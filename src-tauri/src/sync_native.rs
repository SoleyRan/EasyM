//! v2 step 3A: native WebDAV provider, credentials and per-binding local state.
//! The trust boundary for remote JSON stays in src/core (sync-contract/sync-commit); this module
//! only moves verified bytes. Credentials live in the OS credential store and never reach the
//! webview, the workspace, logs or sync objects. Layout on the server (frozen in step 1):
//! `<root>/easym-sync/v1/<workspaceId>/{devices/<deviceId>.json, objects/sha256/<hex>}`.
use std::{fs, io::Write, path::{Path, PathBuf}, sync::{Arc, Mutex}, time::Duration};
use reqwest::{header::{HeaderMap, HeaderValue}, Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;
use tempfile::NamedTempFile;
use crate::workspace::{root, Workspaces};

const SERVICE: &str = "EasyM Sync";
const MAX_HEAD: usize = 4096;
const MAX_OBJECT: usize = 32 * 1024 * 1024;
const MAX_LISTING: usize = 1024 * 1024;
const MAX_DEVICES: usize = 64;
const MAX_STATE: usize = 1024 * 1024;
const MAX_BINDINGS: usize = 32;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub binding_id: String,
    /// Canonical absolute workspace directory; local only, never synced.
    pub workspace_root: PathBuf,
    pub workspace_id: String,
    pub device_id: String,
    /// Collection URL that holds `easym-sync/`, normalized with a trailing slash.
    pub endpoint: String,
    pub username: String,
    pub created_at: u64,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Registry { version: u32, bindings: Vec<Binding> }

/// App-data scoped store: `sync/bindings-v1.json`, `sync/<bindingId>/state.json`,
/// `sync/<bindingId>/objects/<hex>` (verified cache of immutable remote objects).
#[derive(Clone)]
pub struct SyncNative {
    directory: PathBuf,
    lock: Arc<Mutex<()>>,
    client: Arc<Mutex<Option<reqwest::Client>>>,
}

impl SyncNative {
    pub fn new(directory: PathBuf) -> Self { Self { directory, lock: Arc::default(), client: Arc::default() } }
    fn registry_path(&self) -> PathBuf { self.directory.join("bindings-v1.json") }
    fn binding_dir(&self, id: &str) -> Result<PathBuf, String> { uuid(id)?; Ok(self.directory.join(id)) }
    fn client(&self) -> Result<reqwest::Client, String> {
        let mut slot = self.client.lock().map_err(|_| "io_failed")?;
        if let Some(client) = slot.as_ref() { return Ok(client.clone()); }
        // No redirects: a cross-origin hop must never receive the Authorization header.
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(120))
            .user_agent(concat!("EasyM/", env!("CARGO_PKG_VERSION")))
            .build().map_err(|_| "transport_failed")?;
        *slot = Some(client.clone());
        Ok(client)
    }
}
fn now() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
fn uuid(value: &str) -> Result<(), String> {
    if uuid::Uuid::parse_str(value).map_err(|_| "invalid_data")?.to_string() != value { return Err("invalid_data".into()); } Ok(())
}
fn sha_hex(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn object_hex(hash: &str) -> Result<&str, String> {
    let hex = hash.strip_prefix("sha256:").ok_or("invalid_data")?;
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { return Err("invalid_data".into()); }
    Ok(hex)
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("io_failed")?;
    fs::create_dir_all(parent).map_err(|_| "io_failed")?;
    let mut file = NamedTempFile::new_in(parent).map_err(|_| "io_failed")?;
    file.write_all(bytes).map_err(|_| "io_failed")?; file.as_file().sync_all().map_err(|_| "io_failed")?;
    file.persist(path).map_err(|_| "io_failed")?; Ok(())
}
fn read_bounded(path: &Path, max: usize) -> Result<Option<Vec<u8>>, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("io_failed".into()),
        Ok(info) if !info.is_file() || info.len() as usize > max => Err("invalid_data".into()),
        Ok(_) => Ok(Some(fs::read(path).map_err(|_| "io_failed")?)),
    }
}

/// HTTPS only, except plain HTTP to loopback (local test servers). No credentials, query or
/// fragment in the URL; always ends with `/` so relative joins stay inside the collection.
pub(crate) fn normalize_endpoint(value: &str) -> Result<Url, String> {
    let mut url = Url::parse(value.trim()).map_err(|_| "endpoint_invalid")?;
    let loopback = url.host_str().is_some_and(|host| host == "localhost" || host.trim_matches(['[', ']']).parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback()));
    match url.scheme() { "https" => (), "http" if loopback => (), "http" => return Err("endpoint_insecure".into()), _ => return Err("endpoint_invalid".into()) }
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() || url.host_str().is_none() { return Err("endpoint_invalid".into()); }
    if !url.path().ends_with('/') { let path = format!("{}/", url.path()); url.set_path(&path); }
    Ok(url)
}

// Credentials: one OS credential-store entry per binding. Failure is an error, never a file
// fallback. Unit tests use an in-process map so they never touch the developer's real store.
#[cfg(not(test))]
fn credential(binding: &str) -> Result<keyring::Entry, String> { keyring::Entry::new(SERVICE, binding).map_err(|_| "credential_store_unavailable".into()) }
#[cfg(not(test))]
fn store_password(binding: &str, password: &str) -> Result<(), String> {
    if password.is_empty() || password.len() > 4096 { return Err("credential_invalid".into()); }
    credential(binding)?.set_password(password).map_err(|_| "credential_store_unavailable".into())
}
#[cfg(not(test))]
fn load_password(binding: &str) -> Result<String, String> {
    credential(binding)?.get_password().map_err(|error| if matches!(error, keyring::Error::NoEntry) { "credential_missing".into() } else { "credential_store_unavailable".into() })
}
#[cfg(not(test))]
fn forget_password(binding: &str) -> Result<(), String> {
    match credential(binding)?.delete_credential() { Ok(()) | Err(keyring::Error::NoEntry) => Ok(()), Err(_) => Err("credential_store_unavailable".into()) }
}
#[cfg(test)]
static TEST_STORE: std::sync::LazyLock<Mutex<std::collections::HashMap<String, String>>> = std::sync::LazyLock::new(Default::default);
#[cfg(test)]
fn store_password(binding: &str, password: &str) -> Result<(), String> {
    if password.is_empty() || password.len() > 4096 { return Err("credential_invalid".into()); }
    let _ = SERVICE; TEST_STORE.lock().unwrap().insert(binding.into(), password.into()); Ok(())
}
#[cfg(test)]
fn load_password(binding: &str) -> Result<String, String> { TEST_STORE.lock().unwrap().get(binding).cloned().ok_or_else(|| "credential_missing".into()) }
#[cfg(test)]
fn forget_password(binding: &str) -> Result<(), String> { TEST_STORE.lock().unwrap().remove(binding); Ok(()) }

impl SyncNative {
    fn read_registry(&self) -> Result<Registry, String> {
        let Some(bytes) = read_bounded(&self.registry_path(), MAX_STATE)? else { return Ok(Registry { version: 1, bindings: vec![] }); };
        let registry: Registry = serde_json::from_slice(&bytes).map_err(|_| "sync_registry_invalid")?;
        if registry.version != 1 || registry.bindings.len() > MAX_BINDINGS { return Err("sync_registry_invalid".into()); }
        for binding in &registry.bindings { uuid(&binding.binding_id)?; uuid(&binding.workspace_id)?; uuid(&binding.device_id)?; normalize_endpoint(&binding.endpoint)?; }
        Ok(registry)
    }
    fn write_registry(&self, registry: &Registry) -> Result<(), String> {
        atomic_write(&self.registry_path(), &serde_json::to_vec_pretty(registry).map_err(|_| "invalid_data")?)
    }
    pub(crate) fn binding(&self, id: &str) -> Result<Binding, String> {
        let _guard = self.lock.lock().map_err(|_| "io_failed")?;
        self.read_registry()?.bindings.into_iter().find(|b| b.binding_id == id).ok_or_else(|| "binding_missing".into())
    }
    pub(crate) fn binding_for(&self, root: &Path) -> Result<Option<Binding>, String> {
        let _guard = self.lock.lock().map_err(|_| "io_failed")?;
        Ok(self.read_registry()?.bindings.into_iter().find(|b| b.workspace_root == root))
    }
    /// Registers a binding and stores its password. One binding per workspace directory.
    pub(crate) fn create(&self, root: &Path, workspace_id: &str, endpoint: &str, username: &str, password: &str) -> Result<Binding, String> {
        uuid(workspace_id)?;
        let endpoint = normalize_endpoint(endpoint)?;
        if username.is_empty() || username.len() > 256 || username.chars().any(char::is_control) { return Err("credential_invalid".into()); }
        let _guard = self.lock.lock().map_err(|_| "io_failed")?;
        let mut registry = self.read_registry()?;
        if registry.bindings.iter().any(|b| b.workspace_root == root) { return Err("binding_exists".into()); }
        if registry.bindings.len() >= MAX_BINDINGS { return Err("quota_exceeded".into()); }
        let binding = Binding { binding_id: uuid::Uuid::new_v4().to_string(), workspace_root: root.to_path_buf(), workspace_id: workspace_id.into(), device_id: uuid::Uuid::new_v4().to_string(), endpoint: endpoint.to_string(), username: username.into(), created_at: now() };
        store_password(&binding.binding_id, password)?;
        registry.bindings.push(binding.clone());
        if let Err(error) = self.write_registry(&registry) { let _ = forget_password(&binding.binding_id); return Err(error); }
        Ok(binding)
    }
    /// v2 step 4C: gives the binding a new device id after a rollback or a reused id. The old head
    /// stays on the server (its commits remain ancestors); the frontend then rewrites the state for
    /// the new id. Repeating it is harmless: each call just issues another unused id.
    pub(crate) fn rejoin(&self, id: &str) -> Result<Binding, String> {
        let _guard = self.lock.lock().map_err(|_| "io_failed")?;
        let mut registry = self.read_registry()?;
        let binding = registry.bindings.iter_mut().find(|b| b.binding_id == id).ok_or("binding_missing")?;
        binding.device_id = uuid::Uuid::new_v4().to_string();
        let updated = binding.clone();
        self.write_registry(&registry)?;
        Ok(updated)
    }
    /// Removes local binding state and the credential. Remote data and the workspace are untouched.
    pub(crate) fn remove(&self, id: &str) -> Result<(), String> {
        let _guard = self.lock.lock().map_err(|_| "io_failed")?;
        let mut registry = self.read_registry()?;
        let before = registry.bindings.len();
        registry.bindings.retain(|b| b.binding_id != id);
        if registry.bindings.len() == before { return Err("binding_missing".into()); }
        forget_password(id)?;
        self.write_registry(&registry)?;
        let dir = self.binding_dir(id)?;
        if dir.exists() { fs::remove_dir_all(dir).map_err(|_| "io_failed")?; }
        Ok(())
    }
    /// Opaque per-binding sync state written by the core (SyncDeviceState); validated as JSON only.
    pub(crate) fn read_state(&self, id: &str) -> Result<Option<Vec<u8>>, String> { self.binding(id)?; read_bounded(&self.binding_dir(id)?.join("state.json"), MAX_STATE) }
    pub(crate) fn write_state(&self, id: &str, bytes: &[u8]) -> Result<(), String> {
        let binding = self.binding(id)?;
        if bytes.len() > MAX_STATE { return Err("quota_exceeded".into()); }
        let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| "invalid_data")?;
        if value["workspaceId"] != binding.workspace_id.as_str() || value["deviceId"] != binding.device_id.as_str() { return Err("invalid_data".into()); }
        atomic_write(&self.binding_dir(id)?.join("state.json"), bytes)
    }
    fn cached(&self, id: &str, hash: &str) -> Result<Option<Vec<u8>>, String> {
        let hex = object_hex(hash)?;
        let path = self.binding_dir(id)?.join("objects").join(hex);
        let Some(bytes) = read_bounded(&path, MAX_OBJECT)? else { return Ok(None); };
        // A damaged cache entry is discarded and refetched, never returned.
        if sha_hex(&bytes) != hex { let _ = fs::remove_file(path); return Ok(None); }
        Ok(Some(bytes))
    }
    fn cache(&self, id: &str, hash: &str, bytes: &[u8]) -> Result<(), String> {
        let hex = object_hex(hash)?;
        if sha_hex(bytes) != hex { return Err("hash_mismatch".into()); }
        let path = self.binding_dir(id)?.join("objects").join(hex);
        if path.exists() { return Ok(()); }
        atomic_write(&path, bytes)
    }
}
/// One authenticated WebDAV connection target for a binding. `base` is the binding's
/// `easym-sync/v1/<workspaceId>/` collection; every request URL must stay under it.
pub(crate) struct Dav { client: reqwest::Client, base: Url, user: String, password: String }

pub(crate) struct DavResponse { pub status: StatusCode, pub etag: Option<String>, pub body: Vec<u8> }

fn failure(status: StatusCode) -> String {
    match status.as_u16() {
        401 | 403 => "unauthorized".into(),
        404 => "not_found".into(),
        413 | 507 => "quota_exceeded".into(),
        // Moved endpoints are reported, never followed (credentials must not cross origins).
        300..=399 => "endpoint_redirected".into(),
        423 | 429 | 500 | 502 | 503 | 504 => format!("server_busy:{}", status.as_u16()),
        code => format!("unexpected_status:{code}"),
    }
}
fn strong(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(reqwest::header::ETAG)?.to_str().ok()?;
    (value.starts_with('"') && value.ends_with('"') && value.len() >= 2).then(|| value.to_string())
}
fn transport(error: reqwest::Error) -> String {
    if error.is_timeout() { "timeout".into() }
    else if error.is_connect() { "connect_failed".into() }
    // rustls verification failures surface as request errors; never retried as transport noise.
    else if format!("{error:?}").contains("certificate") { "certificate_invalid".into() }
    else { "transport_failed".into() }
}

impl Dav {
    pub(crate) fn new(client: reqwest::Client, endpoint: &str, workspace_id: &str, user: String, password: String) -> Result<Self, String> {
        uuid(workspace_id)?;
        let base = normalize_endpoint(endpoint)?.join(&format!("easym-sync/v1/{workspace_id}/")).map_err(|_| "endpoint_invalid")?;
        Ok(Self { client, base, user, password })
    }
    /// Connection to `easym-sync/v1/` itself, for listing workspaces before a binding exists.
    pub(crate) fn root(client: reqwest::Client, endpoint: &str, user: String, password: String) -> Result<Self, String> {
        let base = normalize_endpoint(endpoint)?.join("easym-sync/v1/").map_err(|_| "endpoint_invalid")?;
        Ok(Self { client, base, user, password })
    }
    fn url(&self, relative: &str) -> Result<Url, String> {
        let url = if relative.is_empty() { self.base.clone() } else { self.base.join(relative).map_err(|_| "invalid_data")? };
        if url.origin() != self.base.origin() || !url.path().starts_with(self.base.path()) { return Err("invalid_data".into()); }
        Ok(url)
    }
    async fn send(&self, method: Method, url: Url, headers: &[(&str, String)], body: Option<Vec<u8>>, max: usize) -> Result<DavResponse, String> {
        let mut request = self.client.request(method, url).basic_auth(&self.user, Some(&self.password));
        for (name, value) in headers { request = request.header(*name, HeaderValue::from_str(value).map_err(|_| "invalid_data")?); }
        if let Some(body) = body { request = request.body(body); }
        let mut response = request.send().await.map_err(transport)?;
        let status = response.status(); let etag = strong(response.headers());
        if response.content_length().is_some_and(|n| n as usize > max) { return Err("response_too_large".into()); }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(transport)? {
            if body.len() + chunk.len() > max { return Err("response_too_large".into()); }
            body.extend_from_slice(&chunk);
        }
        Ok(DavResponse { status, etag, body })
    }
    /// Creates the namespace from the endpoint down. 405 means it already exists.
    pub(crate) async fn prepare(&self) -> Result<(), String> {
        let mut collections = vec![];
        let mut url = self.base.clone();
        for _ in 0..2 { collections.push(url.clone()); url = url.join("..").map_err(|_| "invalid_data")?; }
        collections.reverse();
        for relative in ["devices/", "objects/", "objects/sha256/"] { collections.push(self.url(relative)?); }
        for url in collections {
            let response = self.send(Method::from_bytes(b"MKCOL").map_err(|_| "invalid_data")?, url, &[], None, 64 * 1024).await?;
            if !matches!(response.status.as_u16(), 201 | 405) { return Err(failure(response.status)); }
        }
        Ok(())
    }
    /// Decoded child names of a collection (PROPFIND Depth 1); None for a missing collection.
    /// A non-207 reply or an href outside the collection is an error, never a shorter list.
    async fn children(&self, relative: &str) -> Result<Option<Vec<String>>, String> {
        let base = self.url(relative)?;
        let body = br#"<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>"#.to_vec();
        let response = self.send(Method::from_bytes(b"PROPFIND").map_err(|_| "invalid_data")?, base.clone(), &[("Depth", "1".into()), ("Content-Type", "application/xml".into())], Some(body), MAX_LISTING).await?;
        if response.status == StatusCode::NOT_FOUND { return Ok(None); }
        if response.status.as_u16() != 207 { return Err(failure(response.status)); }
        let own = percent_decode(base.path())?;
        let mut names = vec![];
        for href in hrefs(&response.body)? {
            let path = base.join(&href).map_err(|_| "invalid_listing")?;
            if path.origin() != base.origin() { return Err("invalid_listing".into()); }
            let decoded = percent_decode(path.path())?;
            if decoded == own || decoded == own.trim_end_matches('/') { continue; }
            names.push(decoded.strip_prefix(&own).ok_or("invalid_listing")?.to_string());
        }
        Ok(Some(names))
    }
    /// Device ids under `devices/`; an unexpected name stops sync instead of being skipped.
    pub(crate) async fn list_devices(&self) -> Result<Vec<String>, String> {
        let mut ids = vec![];
        for name in self.children("devices/").await?.unwrap_or_default() {
            if name.starts_with(".~") || name.starts_with("._") || name.starts_with(".#") { continue; }
            let id = name.strip_suffix(".json").ok_or("invalid_listing")?;
            uuid(id).map_err(|_| "invalid_listing")?;
            ids.push(id.to_string());
        }
        if ids.len() > MAX_DEVICES { return Err("too_many_devices".into()); }
        ids.sort(); ids.dedup(); Ok(ids)
    }
    /// Workspace ids under `easym-sync/v1/` (for pairing a new device). Requires a root Dav.
    pub(crate) async fn list_workspaces(&self) -> Result<Vec<String>, String> {
        let mut ids = vec![];
        for name in self.children("").await?.unwrap_or_default() {
            let id = name.trim_end_matches('/');
            // Unrelated entries are ignored here: this only offers choices, it never deletes.
            if uuid(id).is_ok() { ids.push(id.to_string()); }
        }
        ids.sort(); ids.dedup(); Ok(ids)
    }
    pub(crate) async fn read_head(&self, device: &str) -> Result<Option<DavResponse>, String> {
        uuid(device)?;
        let response = self.send(Method::GET, self.url(&format!("devices/{device}.json"))?, &[], None, MAX_HEAD).await?;
        if response.status == StatusCode::NOT_FOUND { return Ok(None); }
        if response.status != StatusCode::OK { return Err(failure(response.status)); }
        Ok(Some(response))
    }
    /// `expected`: None = create (If-None-Match), Some("") = owned write, Some(etag) = If-Match.
    pub(crate) async fn publish_head(&self, device: &str, bytes: Vec<u8>, expected: Option<&str>) -> Result<(String, Option<String>), String> {
        uuid(device)?;
        if bytes.len() > MAX_HEAD { return Err("quota_exceeded".into()); }
        let mut headers = vec![("Content-Type", "application/json".to_string())];
        match expected { None => headers.push(("If-None-Match", "*".into())), Some("") => (), Some(etag) => headers.push(("If-Match", etag.into())) }
        let response = match self.send(Method::PUT, self.url(&format!("devices/{device}.json"))?, &headers, Some(bytes), 64 * 1024).await {
            Ok(response) => response,
            // The request may have reached the server; the core reads its own head back.
            Err(error) if matches!(error.as_str(), "timeout" | "transport_failed" | "connect_failed") => return Ok(("unknown".into(), None)),
            Err(error) => return Err(error),
        };
        match response.status.as_u16() {
            201 | 204 | 200 => Ok(("committed".into(), response.etag)),
            412 => Ok(("conflict".into(), None)),
            401 | 403 | 413 | 507 => Err(failure(response.status)),
            _ => Ok(("unknown".into(), None)),
        }
    }
    pub(crate) async fn read_object(&self, hash: &str) -> Result<Option<Vec<u8>>, String> {
        let hex = object_hex(hash)?;
        let response = self.send(Method::GET, self.url(&format!("objects/sha256/{hex}"))?, &[], None, MAX_OBJECT).await?;
        if response.status == StatusCode::NOT_FOUND { return Ok(None); }
        if response.status != StatusCode::OK { return Err(failure(response.status)); }
        if sha_hex(&response.body) != hex { return Err("hash_mismatch".into()); }
        Ok(Some(response.body))
    }
    /// Content-addressed create; an existing object must hold exactly the same bytes.
    pub(crate) async fn create_object(&self, hash: &str, bytes: Vec<u8>) -> Result<&'static str, String> {
        let hex = object_hex(hash)?.to_string();
        if sha_hex(&bytes) != hex { return Err("hash_mismatch".into()); }
        if bytes.len() > MAX_OBJECT { return Err("quota_exceeded".into()); }
        let url = self.url(&format!("objects/sha256/{hex}"))?;
        for attempt in 0..8u32 {
            let response = self.send(Method::PUT, url.clone(), &[("Content-Type", "application/octet-stream".into()), ("If-None-Match", "*".into())], Some(bytes.clone()), 64 * 1024).await?;
            match response.status.as_u16() {
                201 | 204 | 200 => return Ok("created"),
                // Nextcloud: a concurrent upload of the same object holds the file lock.
                423 if attempt < 7 => { tokio::time::sleep(Duration::from_millis(100 * 2u64.pow(attempt))).await; continue; }
                // Nextcloud also answers 404 to some racing creates of one path (measured: 7 of 80).
                // Content addressing makes this safe: if the object is there now its bytes were
                // just checked against the hash; otherwise retry the create.
                404 if attempt < 7 => {
                    if self.read_object(hash).await?.is_some() { return Ok("exists"); }
                    tokio::time::sleep(Duration::from_millis(100 * 2u64.pow(attempt))).await; continue;
                }
                412 => {
                    let existing = self.read_object(hash).await?;
                    return if existing.is_some() { Ok("exists") } else { Err("remote_object_corrupt".into()) };
                }
                _ => return Err(failure(response.status)),
            }
        }
        Err("server_busy:423".into())
    }
}

fn percent_decode(path: &str) -> Result<String, String> {
    let bytes = path.as_bytes(); let mut out = Vec::with_capacity(bytes.len()); let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|_| "invalid_listing")?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| "invalid_listing")?); i += 3;
        } else { out.push(bytes[i]); i += 1; }
    }
    String::from_utf8(out).map_err(|_| "invalid_listing".into())
}
/// `href` text of a multistatus body, matched by local name (servers use `d:`, `D:` or none).
/// Text and entity references inside one href are joined; unknown entities are an error.
fn hrefs(xml: &[u8]) -> Result<Vec<String>, String> {
    use quick_xml::{events::Event, Reader};
    let source = std::str::from_utf8(xml).map_err(|_| "invalid_listing")?;
    let mut reader = Reader::from_str(source);
    let (mut out, mut current): (Vec<String>, Option<String>) = (vec![], None);
    loop {
        match reader.read_event().map_err(|_| "invalid_listing")? {
            Event::Start(e) if e.local_name().as_ref() == "href" => current = Some(String::new()),
            Event::End(e) if e.local_name().as_ref() == "href" => out.push(current.take().ok_or("invalid_listing")?.trim().to_string()),
            Event::Text(t) => if let Some(text) = current.as_mut() { text.push_str(&t.xml10_content()) },
            Event::GeneralRef(r) => if let Some(text) = current.as_mut() {
                let resolved = match r.resolve_char_ref().map_err(|_| "invalid_listing")? {
                    Some(c) => c,
                    None => match &*r.xml10_content() { "amp" => '&', "lt" => '<', "gt" => '>', "quot" => '"', "apos" => '\'', _ => return Err("invalid_listing".into()) },
                };
                text.push(resolved);
            },
            Event::Eof => break,
            _ => (),
        }
        if out.len() > MAX_DEVICES * 4 + 8 { return Err("too_many_devices".into()); }
    }
    if current.is_some() { return Err("invalid_listing".into()); }
    Ok(out)
}
pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::Manager;
    let directory = app.path().app_data_dir()?;
    // Same isolation as the recent registry: an explicit WebView2 test profile keeps its own bindings.
    #[cfg(windows)]
    let directory = crate::recent::profile_registry_directory(directory, std::env::var_os("WEBVIEW2_USER_DATA_FOLDER"))?;
    app.manage(SyncNative::new(directory.join("sync")));
    Ok(())
}

/// What the webview may know about a binding: no password, no local path.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingView { binding_id: String, workspace_id: String, device_id: String, endpoint: String, username: String, created_at: u64 }
impl From<&Binding> for BindingView {
    fn from(b: &Binding) -> Self { Self { binding_id: b.binding_id.clone(), workspace_id: b.workspace_id.clone(), device_id: b.device_id.clone(), endpoint: b.endpoint.clone(), username: b.username.clone(), created_at: b.created_at } }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadBytes { device_id: String, bytes: Vec<u8>, revision: Option<String> }
#[derive(Serialize)]
pub struct Published { kind: String, revision: Option<String> }

fn bound(native: &SyncNative, workspaces: &Workspaces, id: &str) -> Result<Binding, String> {
    native.binding_for(&root(workspaces, id)?)?.ok_or_else(|| "binding_missing".into())
}
fn dav(native: &SyncNative, binding: &Binding) -> Result<Dav, String> {
    Dav::new(native.client()?, &binding.endpoint, &binding.workspace_id, binding.username.clone(), load_password(&binding.binding_id)?)
}
/// The workspace's persistent sync identity id (step 2A); a binding requires it.
fn identity_workspace(root: &Path) -> Result<String, String> {
    let bytes = crate::sync_identity::read_identity(root)?.ok_or("identity_missing")?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "identity_unreadable")?;
    let id = value["workspaceId"].as_str().ok_or("identity_unreadable")?.to_string();
    uuid(&id).map_err(|_| "identity_unreadable")?;
    Ok(id)
}

#[tauri::command]
pub async fn sync_binding(native: State<'_, SyncNative>, workspaces: State<'_, Workspaces>, id: String) -> Result<Option<BindingView>, String> {
    Ok(native.binding_for(&root(&workspaces, &id)?)?.as_ref().map(BindingView::from))
}

/// Checks endpoint and credentials and lists remote workspaces, without storing anything.
#[tauri::command]
pub async fn sync_probe(native: State<'_, SyncNative>, endpoint: String, username: String, password: String) -> Result<Vec<String>, String> {
    Dav::root(native.client()?, &endpoint, username, password)?.list_workspaces().await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbedHead { device_id: String, head: Vec<u8>, commit: Option<Vec<u8>> }

/// Read-only pairing preview of an existing remote workspace: every device head and the commit
/// object it points to (hash-checked here, parsed by the core). Nothing is stored.
#[tauri::command]
pub async fn sync_probe_workspace(native: State<'_, SyncNative>, endpoint: String, username: String, password: String, workspace_id: String) -> Result<Vec<ProbedHead>, String> {
    let dav = Dav::new(native.client()?, &endpoint, &workspace_id, username, password)?;
    let mut heads = vec![];
    for device in dav.list_devices().await? {
        let head = dav.read_head(&device).await?.ok_or("invalid_listing")?;
        let value: serde_json::Value = serde_json::from_slice(&head.body).map_err(|_| "invalid_head")?;
        let hash = value["commitHash"].as_str().ok_or("invalid_head")?;
        heads.push(ProbedHead { commit: dav.read_object(hash).await?, device_id: device, head: head.body });
    }
    Ok(heads)
}

/// Binds the workspace (whose identity must be enabled) to an endpoint and creates the remote
/// namespace. On any failure nothing is left behind locally.
#[tauri::command]
pub async fn sync_bind(native: State<'_, SyncNative>, workspaces: State<'_, Workspaces>, id: String, endpoint: String, username: String, password: String) -> Result<BindingView, String> {
    let root = root(&workspaces, &id)?;
    let workspace_id = identity_workspace(&root)?;
    let binding = native.create(&root, &workspace_id, &endpoint, &username, &password)?;
    if let Err(error) = dav(&native, &binding)?.prepare().await { let _ = native.remove(&binding.binding_id); return Err(error); }
    Ok(BindingView::from(&binding))
}

/// Exit sync: forgets the binding, its credential, state and cache. Workspace and remote are kept.
#[tauri::command]
pub async fn sync_unbind(native: State<'_, SyncNative>, workspaces: State<'_, Workspaces>, id: String) -> Result<(), String> {
    native.remove(&bound(&native, &workspaces, &id)?.binding_id)
}

/// Rejoin as a new device (see `SyncNative::rejoin`). Credential, endpoint and cache are kept.
#[tauri::command]
pub async fn sync_rejoin(native: State<'_, SyncNative>, workspaces: State<'_, Workspaces>, id: String) -> Result<BindingView, String> {
    let binding = bound(&native, &workspaces, &id)?;
    Ok(BindingView::from(&native.rejoin(&binding.binding_id)?))
}

#[tauri::command]
pub async fn sync_state_read(native: State<'_, SyncNative>, workspaces: State<'_, Workspaces>, id: String) -> Result<Option<Vec<u8>>, String> {
    native.read_state(&bound(&native, &workspaces, &id)?.binding_id)
}
#[tauri::command]
pub async fn sync_state_write(native: State<'_, SyncNative>, workspaces: State<'_, Workspaces>, id: String, bytes: Vec<u8>) -> Result<(), String> {
    native.write_state(&bound(&native, &workspaces, &id)?.binding_id, &bytes)
}

/// Complete listing of device heads as raw bytes; parsed and validated by the core.
#[tauri::command]
pub async fn sync_heads(native: State<'_, SyncNative>, workspaces: State<'_, Workspaces>, id: String) -> Result<Vec<HeadBytes>, String> {
    let binding = bound(&native, &workspaces, &id)?; let dav = dav(&native, &binding)?;
    let mut heads = vec![];
    for device in dav.list_devices().await? {
        // Listed but unreadable: an inconsistent listing, never silently skipped.
        let head = dav.read_head(&device).await?.ok_or("invalid_listing")?;
        heads.push(HeadBytes { device_id: device, bytes: head.body, revision: head.etag });
    }
    Ok(heads)
}
#[tauri::command]
pub async fn sync_head(native: State<'_, SyncNative>, workspaces: State<'_, Workspaces>, id: String, device: String) -> Result<Option<HeadBytes>, String> {
    let binding = bound(&native, &workspaces, &id)?;
    Ok(dav(&native, &binding)?.read_head(&device).await?.map(|head| HeadBytes { device_id: device, bytes: head.body, revision: head.etag }))
}
/// Writes only this binding's own device head. `expected`: None = create, "" = owned, else If-Match.
#[tauri::command]
pub async fn sync_publish(native: State<'_, SyncNative>, workspaces: State<'_, Workspaces>, id: String, bytes: Vec<u8>, expected: Option<String>) -> Result<Published, String> {
    let binding = bound(&native, &workspaces, &id)?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "invalid_data")?;
    if value["deviceId"] != binding.device_id.as_str() || value["workspaceId"] != binding.workspace_id.as_str() { return Err("permission_denied".into()); }
    let (kind, revision) = dav(&native, &binding)?.publish_head(&binding.device_id, bytes, expected.as_deref()).await?;
    Ok(Published { kind, revision })
}
/// Verified read: local cache first, then remote; remote bytes are hash-checked and cached.
#[tauri::command]
pub async fn sync_object(native: State<'_, SyncNative>, workspaces: State<'_, Workspaces>, id: String, hash: String) -> Result<Option<Vec<u8>>, String> {
    let binding = bound(&native, &workspaces, &id)?;
    if let Some(bytes) = native.cached(&binding.binding_id, &hash)? { return Ok(Some(bytes)); }
    let bytes = dav(&native, &binding)?.read_object(&hash).await?;
    if let Some(bytes) = &bytes { native.cache(&binding.binding_id, &hash, bytes)?; }
    Ok(bytes)
}
#[tauri::command]
pub async fn sync_put_object(native: State<'_, SyncNative>, workspaces: State<'_, Workspaces>, id: String, hash: String, bytes: Vec<u8>) -> Result<String, String> {
    let binding = bound(&native, &workspaces, &id)?;
    let outcome = dav(&native, &binding)?.create_object(&hash, bytes.clone()).await?;
    native.cache(&binding.binding_id, &hash, &bytes)?;
    Ok(outcome.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    const W: &str = "1358f0a2-25b8-441b-9d55-379f6ca303dc";

    #[test]
    fn endpoints_require_https_except_loopback_and_never_carry_credentials() {
        assert_eq!(normalize_endpoint("https://dav.example.test/remote.php/dav/files/u").unwrap().as_str(), "https://dav.example.test/remote.php/dav/files/u/");
        assert!(normalize_endpoint("http://127.0.0.1:18081/dav/").is_ok());
        assert!(normalize_endpoint("http://[::1]:8080/").is_ok());
        assert!(normalize_endpoint("http://localhost/dav").is_ok());
        for (url, code) in [("http://dav.example.test/", "endpoint_insecure"), ("https://u:p@dav.example.test/", "endpoint_invalid"), ("https://dav.example.test/?a=b", "endpoint_invalid"), ("https://dav.example.test/#x", "endpoint_invalid"), ("ftp://dav.example.test/", "endpoint_invalid"), ("not a url", "endpoint_invalid")] {
            assert_eq!(normalize_endpoint(url).unwrap_err(), code, "{url}");
        }
    }

    #[test]
    fn request_urls_stay_inside_the_workspace_collection() {
        let dav = Dav::new(reqwest::Client::new(), "https://dav.example.test/files/u/", W, "u".into(), "p".into()).unwrap();
        assert_eq!(dav.url("devices/").unwrap().as_str(), format!("https://dav.example.test/files/u/easym-sync/v1/{W}/devices/"));
        for escape in ["../other/", "../../../../x", "https://evil.test/x", "//evil.test/x", "/files/u/"] { assert!(dav.url(escape).is_err(), "{escape}"); }
        assert!(Dav::new(reqwest::Client::new(), "https://dav.example.test/", "../x", "u".into(), "p".into()).is_err());
    }

    #[test]
    fn multistatus_hrefs_match_any_prefix_and_decode() {
        let xml = br#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/f/easym-sync/v1/w/devices/</d:href></d:response><d:response><d:href>/f/easym-sync/v1/w/devices/6f0c1c55-3c9e-4f53-9c9b-0b8f4d9f6a01.json</d:href></d:response></d:multistatus>"#;
        assert_eq!(hrefs(xml).unwrap().len(), 2);
        let upper = br#"<D:multistatus xmlns:D="DAV:"><D:response><D:href>/a%20b/</D:href></D:response></D:multistatus>"#;
        assert_eq!(hrefs(upper).unwrap(), vec!["/a%20b/"]);
        assert_eq!(percent_decode("/a%20b/%E4%B8%AD").unwrap(), "/a b/中");
        assert!(percent_decode("/bad%ff%fe").is_err());
        assert!(hrefs(b"<d:multistatus><d:href>").is_err() || hrefs(b"<d:multistatus><d:href>").unwrap().is_empty());
    }

    #[test]
    fn statuses_map_to_actionable_errors() {
        for (code, expected) in [(401, "unauthorized"), (403, "unauthorized"), (507, "quota_exceeded"), (301, "endpoint_redirected"), (423, "server_busy:423"), (418, "unexpected_status:418")] {
            assert_eq!(failure(StatusCode::from_u16(code).unwrap()), expected);
        }
    }

    #[test]
    fn bindings_keep_secrets_out_of_files_and_remove_everything_local() {
        let temp = tempfile::tempdir().unwrap(); let native = SyncNative::new(temp.path().join("sync"));
        let root = temp.path().join("workspace");
        let binding = native.create(&root, W, "https://dav.example.test/f", "user", "s3cret-password").unwrap();
        assert_eq!(binding.endpoint, "https://dav.example.test/f/");
        assert_eq!(native.binding_for(&root).unwrap().unwrap(), binding);
        assert_eq!(native.create(&root, W, "https://dav.example.test/f", "user", "x").unwrap_err(), "binding_exists");
        assert_eq!(load_password(&binding.binding_id).unwrap(), "s3cret-password");
        let registry = fs::read_to_string(temp.path().join("sync/bindings-v1.json")).unwrap();
        assert!(!registry.contains("s3cret-password"));
        let state = serde_json::to_vec(&serde_json::json!({"workspaceId":W,"deviceId":binding.device_id,"sequence":0,"commitHash":null,"seen":{}})).unwrap();
        native.write_state(&binding.binding_id, &state).unwrap();
        assert_eq!(native.read_state(&binding.binding_id).unwrap().unwrap(), state);
        assert!(native.write_state(&binding.binding_id, br#"{"workspaceId":"other","deviceId":"x"}"#).is_err());
        // Rejoin: a fresh device id; credential and binding id stay, old-id state is refused.
        let rejoined = native.rejoin(&binding.binding_id).unwrap();
        assert_ne!(rejoined.device_id, binding.device_id);
        assert_eq!((rejoined.binding_id.as_str(), rejoined.workspace_id.as_str()), (binding.binding_id.as_str(), binding.workspace_id.as_str()));
        assert_eq!(native.binding_for(&root).unwrap().unwrap(), rejoined);
        assert_eq!(load_password(&binding.binding_id).unwrap(), "s3cret-password");
        assert!(native.write_state(&binding.binding_id, &state).is_err());
        let fresh = serde_json::to_vec(&serde_json::json!({"workspaceId":W,"deviceId":rejoined.device_id,"sequence":0,"commitHash":null,"seen":{}})).unwrap();
        native.write_state(&binding.binding_id, &fresh).unwrap();
        assert_eq!(native.rejoin("00000000-0000-4000-8000-000000000000").unwrap_err(), "binding_missing");
        native.remove(&binding.binding_id).unwrap();
        assert!(native.binding_for(&root).unwrap().is_none());
        assert_eq!(load_password(&binding.binding_id).unwrap_err(), "credential_missing");
        assert!(!temp.path().join("sync").join(&binding.binding_id).exists());
        assert!(native.create(&root, W, "http://dav.example.test/", "user", "p").is_err());
    }

    #[test]
    fn cache_returns_only_verified_bytes() {
        let temp = tempfile::tempdir().unwrap(); let native = SyncNative::new(temp.path().join("sync"));
        let binding = native.create(&temp.path().join("w"), W, "https://dav.example.test/", "u", "p").unwrap();
        let bytes = b"object".to_vec(); let hash = format!("sha256:{}", sha_hex(&bytes));
        assert!(native.cache(&binding.binding_id, &hash, b"other").is_err());
        native.cache(&binding.binding_id, &hash, &bytes).unwrap();
        assert_eq!(native.cached(&binding.binding_id, &hash).unwrap().unwrap(), bytes);
        fs::write(temp.path().join("sync").join(&binding.binding_id).join("objects").join(object_hex(&hash).unwrap()), b"tampered").unwrap();
        assert!(native.cached(&binding.binding_id, &hash).unwrap().is_none());
        assert!(native.cached(&binding.binding_id, "sha256:../../x").is_err());
    }

    /// Real-server check of the native provider (step 3A). Needs the step-1 containers:
    /// `cargo test --manifest-path src-tauri/Cargo.toml -- --ignored native_dav_round_trip`.
    #[test]
    #[ignore]
    fn native_dav_round_trip_against_step1_containers() {
        let env = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../test-results/v2.0/step-1/webdav.env")).expect("webdav.env");
        let get = |key: &str| env.lines().find_map(|l| l.strip_prefix(&format!("{key}="))).unwrap().to_string();
        let targets = [("http://127.0.0.1:18081/dav/", get("EASYM_DAV_USER"), get("EASYM_DAV_PASSWORD")), (&*format!("http://127.0.0.1:18082/remote.php/dav/files/{}/", get("EASYM_NC_ADMIN_USER")), get("EASYM_NC_ADMIN_USER"), get("EASYM_NC_ADMIN_PASSWORD"))]
            .map(|(e, u, p)| (e.to_string(), u, p));
        for (endpoint, user, password) in targets {
            tauri::async_runtime::block_on(async {
                let workspace = uuid::Uuid::new_v4().to_string(); let device = uuid::Uuid::new_v4().to_string();
                let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
                let wrong = Dav::new(client.clone(), &endpoint, &workspace, user.clone(), "wrong".into()).unwrap();
                assert_eq!(wrong.list_devices().await.unwrap_err(), "unauthorized", "{endpoint}");
                let dav = Dav::new(client.clone(), &endpoint, &workspace, user.clone(), password.clone()).unwrap();
                dav.prepare().await.unwrap(); dav.prepare().await.unwrap();
                assert!(dav.list_devices().await.unwrap().is_empty());
                let root = Dav::root(client.clone(), &endpoint, user.clone(), password.clone()).unwrap();
                assert!(root.list_workspaces().await.unwrap().contains(&workspace));
                let bytes = "中文 object".as_bytes().to_vec(); let hash = format!("sha256:{}", sha_hex(&bytes));
                assert_eq!(dav.create_object(&hash, bytes.clone()).await.unwrap(), "created");
                assert_eq!(dav.create_object(&hash, bytes.clone()).await.unwrap(), "exists");
                // Racing creates of one object (several devices uploading the same merged body)
                // must all end as created/exists; Nextcloud answers some of them 404 or 423.
                for round in 0..5 {
                    let racing = format!("racing {round} {}", uuid::Uuid::new_v4()).into_bytes(); let racing_hash = format!("sha256:{}", sha_hex(&racing));
                    let tasks: Vec<_> = (0..8).map(|_| { let dav = Dav::new(client.clone(), &endpoint, &workspace, user.clone(), password.clone()).unwrap(); let (h, b) = (racing_hash.clone(), racing.clone()); tauri::async_runtime::spawn(async move { dav.create_object(&h, b).await }) }).collect();
                    for task in tasks { let outcome = task.await.unwrap(); assert!(matches!(outcome, Ok("created" | "exists")), "{endpoint} {outcome:?}"); }
                }
                assert_eq!(dav.read_object(&hash).await.unwrap().unwrap(), bytes);
                assert!(dav.read_object(&format!("sha256:{}", "0".repeat(64))).await.unwrap().is_none());
                let head = format!(r#"{{"schemaVersion":1,"workspaceId":"{workspace}","deviceId":"{device}","sequence":1,"commitHash":"{hash}"}}"#).into_bytes();
                assert_eq!(dav.publish_head(&device, head.clone(), None).await.unwrap().0, "committed");
                assert_eq!(dav.publish_head(&device, head.clone(), None).await.unwrap().0, "conflict");
                assert_eq!(dav.list_devices().await.unwrap(), vec![device.clone()]);
                assert_eq!(dav.read_head(&device).await.unwrap().unwrap().body, head);
                assert_eq!(dav.publish_head(&device, head.clone(), Some("")).await.unwrap().0, "committed");
            });
        }
    }
}
