//! Opt-in, directory-scoped immutable history. All entry points share Storage's write queue.
use std::{collections::{BTreeMap, BTreeSet}, fs, io::Write, path::{Component, Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tempfile::NamedTempFile;
use tauri::State;
use crate::{resources::{self, Asset, Metadata, directory, safe_existing}, storage::Storage, transaction};

const BASE: &str = ".easym/history";
const MAX_JSON: u64 = 4 * 1024 * 1024;
const MAX_TEXT: usize = 10 * 1024 * 1024;
const MAX_RESOURCES: usize = 128 * 1024 * 1024;
const MAX_ENTRIES: usize = 10000;
const DEFAULT_BUDGET: u64 = 512 * 1024 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Index {
    schema_version: u32,
    budget_bytes: u64,
    documents: BTreeMap<String, Entry>,
    // Tombstones commit before collection, so interrupted cleanup cannot resurrect manifests.
    deleted: BTreeSet<String>,
}
impl Default for Index {
    fn default() -> Self { Self { schema_version: 1, budget_bytes: DEFAULT_BUDGET, documents: BTreeMap::new(), deleted: BTreeSet::new() } }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    document_id: String,
    enabled: bool,
    snapshots: Vec<String>,
    #[serde(default)] annotations: BTreeMap<String, Annotation>,
}
#[derive(Clone, Default, Deserialize, Serialize)]
struct Annotation { name: Option<String>, pinned: bool }
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resource {
    path: String, hash: Option<String>, size: usize, mime: Option<String>, role: String, missing: bool,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    schema_version: u32, snapshot_id: String, document_id: String, parent_snapshot_id: Option<String>,
    created_at: u64, reason: String, body_hash: String, body_size: usize, encoding: String, line_ending: String,
    disk_revision: Option<String>, resources: Vec<Resource>, metadata: Metadata, complete: bool,
    #[serde(default)] unarchived_references: Vec<String>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Input { bytes: Vec<u8>, references: Vec<String>, #[serde(default)] unarchived_references: Vec<String>, assets: Vec<Asset>, metadata: Metadata, disk_revision: Option<String> }
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Request {
    Status,
    Enable { references: Vec<String>, #[serde(default)] unarchived_references: Vec<String>, #[serde(default)] expected_revision: Option<String> },
    Capture { input: Input, name: Option<String> },
    Detail { snapshot_id: String },
    Object { snapshot_id: String, hash: String },
    Annotate { snapshot_id: String, name: Option<String>, pinned: bool },
    Configure { budget_mib: u64 },
    Reassociate { document_id: String },
    CleanupPreview { selected: Vec<String> },
    CleanupCommit { selected: Vec<String>, token: String },
    Prepare { snapshot_id: String },
    Restore { snapshot_id: String, bytes: Vec<u8>, relocations: BTreeMap<String, String>, current: Input, expected_revision: String, operation_id: String, encoding: String, line_ending: String },
    Copy { snapshot_id: String, body_only: bool },
}

fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
fn uuid(value: &str) -> Result<(), String> {
    if uuid::Uuid::parse_str(value).map_err(|_| "history_invalid")?.to_string() != value { return Err("history_invalid".into()); } Ok(())
}
fn digest(bytes: &[u8]) -> String { transaction::hash(bytes).trim_start_matches("sha256:").to_string() }
fn valid_hash(value: &str) -> bool { value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }
fn relative(value: &str) -> Result<(), String> {
    if value.is_empty() || value.contains(['\\', ':', '\0']) || Path::new(value).components().any(|c| !matches!(c, Component::Normal(_))) { return Err("permission_denied".into()); } Ok(())
}
fn key(path: &Path) -> Result<String, String> {
    let key = path.file_name().ok_or("history_invalid")?.to_str().ok_or("history_invalid")?.to_string(); relative(&key)?; Ok(key)
}
fn root(path: &Path) -> Result<PathBuf, String> { path.parent().ok_or("history_invalid")?.canonicalize().map_err(|_| "permission_denied".into()) }
fn bounded(root: &Path, path: &str, max: u64) -> Result<Vec<u8>, String> {
    let path = safe_existing(root, path)?;
    let info = fs::metadata(&path).map_err(|_| "io_failed")?;
    if !info.is_file() || info.len() > max { return Err("quota_exceeded".into()); }
    let bytes = fs::read(path).map_err(|_| "io_failed")?;
    if bytes.len() as u64 > max { return Err("quota_exceeded".into()); } Ok(bytes)
}
fn json_read<T: serde::de::DeserializeOwned>(root: &Path, path: &str) -> Result<T, String> {
    let bytes = bounded(root, path, MAX_JSON)?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "history_invalid")?;
    if value["schemaVersion"].as_u64() != Some(1) { return Err("history_read_only".into()); }
    serde_json::from_value(value).map_err(|_| "history_invalid".into())
}
fn atomic(root: &Path, relative_path: &str, bytes: &[u8], immutable: bool) -> Result<(), String> {
    relative(relative_path)?;
    let (parent, name) = relative_path.rsplit_once('/').unwrap_or(("", relative_path));
    let parent = if parent.is_empty() { root.to_path_buf() } else { directory(root, parent)? }; let target = parent.join(name);
    if fs::symlink_metadata(&target).is_ok() { safe_existing(root, relative_path)?; }
    let mut file = NamedTempFile::new_in(parent).map_err(|_| "io_failed")?;
    file.write_all(bytes).map_err(|_| "io_failed")?; file.as_file().sync_all().map_err(|_| "io_failed")?;
    if fs::read(file.path()).map_err(|_| "io_failed")? != bytes { return Err("io_failed".into()); }
    if immutable { file.persist_noclobber(target).map_err(|_| "io_failed")?; }
    else { file.persist(target).map_err(|_| "io_failed")?; } Ok(())
}
fn index_read(root: &Path) -> Result<Index, String> {
    if fs::symlink_metadata(root.join(format!("{BASE}/index.json"))).is_err() {
        // A missing index with existing history is recoverable only if a valid index was committed.
        // Do not silently adopt another directory's data or reset damaged authorization mappings.
        if fs::symlink_metadata(root.join(BASE)).is_ok() {
            safe_existing(root, BASE)?;
            if root.join(format!("{BASE}/documents")).exists() || root.join(format!("{BASE}/objects")).exists() { return Err("history_invalid".into()); }
        }
        return Ok(Index::default());
    }
    let index: Index = json_read(root, &format!("{BASE}/index.json"))?;
    if index.documents.len() > 4096 || index.deleted.len() > MAX_ENTRIES || !(1024 * 1024..=4096 * 1024 * 1024).contains(&index.budget_bytes) { return Err("history_invalid".into()); }
    let mut identities = BTreeSet::new();
    for (path, entry) in &index.documents {
        relative(path)?; uuid(&entry.document_id)?;
        if !identities.insert(&entry.document_id) || entry.snapshots.len() > MAX_ENTRIES { return Err("history_invalid".into()); }
        for snapshot in &entry.snapshots { uuid(snapshot)?; }
        for (snapshot, note) in &entry.annotations { uuid(snapshot)?; if note.name.as_ref().is_some_and(|n| n.len() > 512) { return Err("history_invalid".into()); } }
    }
    for item in &index.deleted { let (doc, snap) = item.split_once('/').ok_or("history_invalid")?; uuid(doc)?; uuid(snap)?; }
    Ok(index)
}
fn index_write(root: &Path, index: &Index) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(index).map_err(|_| "history_invalid")?;
    if bytes.len() as u64 > MAX_JSON { return Err("quota_exceeded".into()); }
    atomic(root, &format!("{BASE}/index.json"), &bytes, false)
}
fn manifest_path(doc: &str, snap: &str) -> Result<String, String> { uuid(doc)?; uuid(snap)?; Ok(format!("{BASE}/documents/{doc}/snapshots/{snap}.json")) }
fn manifest_read(root: &Path, doc: &str, snap: &str) -> Result<Snapshot, String> {
    let value: Snapshot = json_read(root, &manifest_path(doc, snap)?)?;
    if value.document_id != doc || value.snapshot_id != snap || value.body_size > MAX_TEXT || !valid_hash(&value.body_hash) || value.resources.len() > 4096 || value.metadata.schema_version != 1 { return Err("history_invalid".into()); }
    if let Some(parent) = &value.parent_snapshot_id { uuid(parent)?; }
    if !["utf-8", "utf-8-bom"].contains(&value.encoding.as_str()) || !["lf", "crlf", "mixed"].contains(&value.line_ending.as_str()) { return Err("history_invalid".into()); }
    if !["baseline", "manual", "automatic", "pre-save", "pre-restore", "restore", "pre-batch"].contains(&value.reason.as_str()) { return Err("history_invalid".into()); }
    let mut paths = BTreeSet::new(); let mut total = 0;
    for item in &value.resources {
        relative(&item.path)?;
        if !paths.insert(&item.path) || item.path.starts_with(".easym/") || !["source", "display", "plain-reference"].contains(&item.role.as_str()) || item.size > 20 * 1024 * 1024 { return Err("history_invalid".into()); }
        total += item.size;
        if item.missing { if item.hash.is_some() || item.size != 0 { return Err("history_invalid".into()); } }
        else if !item.hash.as_ref().is_some_and(|h| valid_hash(h)) || !item.mime.as_ref().is_some_and(|m| m == "image/png" || m == "image/jpeg") { return Err("history_invalid".into()); }
    }
    validate_unarchived(&value.unarchived_references)?;
    if total > MAX_RESOURCES || value.complete != (!value.resources.iter().any(|r| r.missing) && value.unarchived_references.is_empty()) { return Err("history_invalid".into()); }
    for instance in &value.metadata.instances { resources::validate_instance(instance)?; }
    Ok(value)
}
// Enumerate complete manifests, including those committed just before an interrupted index update.
// No body is changed. A foreign/unknown manifest prevents mutation and GC across the directory.
fn reconcile(root: &Path, index: &mut Index) -> Result<(), String> {
    let documents = format!("{BASE}/documents");
    if root.join(&documents).exists() {
        let entries: Vec<_> = fs::read_dir(safe_existing(root, &documents)?).map_err(|_| "io_failed")?.collect();
        if entries.len() > 4096 { return Err("quota_exceeded".into()); }
        for item in entries {
            let name = item.map_err(|_| "io_failed")?.file_name().to_string_lossy().to_string();
            uuid(&name)?; safe_existing(root, &format!("{documents}/{name}"))?;
            if !index.documents.values().any(|e| e.document_id == name) { return Err("history_invalid".into()); }
        }
    }
    let mut total = 0;
    for entry in index.documents.values_mut() {
        let directory_path = format!("{BASE}/documents/{}/snapshots", entry.document_id);
        if !root.join(&directory_path).exists() { if !entry.snapshots.is_empty() { return Err("history_invalid".into()); } continue; }
        let folder = safe_existing(root, &directory_path)?;
        let mut found = BTreeSet::new();
        for file in fs::read_dir(folder).map_err(|_| "io_failed")? {
            total += 1; if total > MAX_ENTRIES { return Err("quota_exceeded".into()); }
            let name = file.map_err(|_| "io_failed")?.file_name().to_string_lossy().to_string();
            let Some(snap) = name.strip_suffix(".json") else { continue; };
            uuid(snap)?;
            if index.deleted.contains(&format!("{}/{snap}", entry.document_id)) { continue; }
            manifest_read(root, &entry.document_id, snap)?; found.insert(snap.to_string());
        }
        for snap in &entry.snapshots { if !found.contains(snap) && !index.deleted.contains(&format!("{}/{snap}", entry.document_id)) { return Err("history_invalid".into()); } }
        entry.snapshots = found.into_iter().collect();
    }
    Ok(())
}
fn size(root: &Path) -> Result<u64, String> {
    if !root.join(BASE).exists() { return Ok(0); }
    let mut stack = vec![BASE.to_string()]; let mut bytes = 0; let mut count = 0;
    while let Some(folder) = stack.pop() {
        for file in fs::read_dir(safe_existing(root, &folder)?).map_err(|_| "io_failed")? {
            count += 1; if count > 50000 { return Err("quota_exceeded".into()); }
            let name = file.map_err(|_| "io_failed")?.file_name().to_str().ok_or("history_invalid")?.to_string();
            let relative = format!("{folder}/{name}"); let path = safe_existing(root, &relative)?;
            let info = fs::metadata(path).map_err(|_| "io_failed")?;
            if info.is_dir() { stack.push(relative); } else if info.is_file() { bytes += info.len(); } else { return Err("permission_denied".into()); }
        }
    }
    Ok(bytes)
}
fn object_read(root: &Path, hash: &str, max: usize) -> Result<Vec<u8>, String> {
    if !valid_hash(hash) { return Err("history_invalid".into()); }
    let bytes = bounded(root, &format!("{BASE}/objects/{hash}"), max as u64)?;
    if digest(&bytes) != hash { return Err("history_corrupt".into()); } Ok(bytes)
}
fn object_write(root: &Path, bytes: &[u8]) -> Result<String, String> {
    let hash = digest(bytes); let path = format!("{BASE}/objects/{hash}");
    if fs::symlink_metadata(root.join(&path)).is_ok() { object_read(root, &hash, bytes.len())?; }
    else { atomic(root, &path, bytes, true)?; }
    Ok(hash)
}
fn text_format(bytes: &[u8]) -> Result<(String, String), String> {
    if bytes.len() > MAX_TEXT { return Err("quota_exceeded".into()); }
    let bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
    let text = std::str::from_utf8(if bom { &bytes[3..] } else { bytes }).map_err(|_| "history_invalid")?;
    if text.contains('\0') { return Err("history_invalid".into()); }
    let crlf = text.contains("\r\n"); let lf = text.replace("\r\n", "").contains('\n');
    if text.replace("\r\n", "").contains('\r') { return Err("history_invalid".into()); }
    Ok((if bom { "utf-8-bom" } else { "utf-8" }.into(), if crlf && lf { "mixed" } else if crlf { "crlf" } else { "lf" }.into()))
}
fn entry<'a>(index: &'a Index, path: &Path) -> Result<&'a Entry, String> { index.documents.get(&key(path)?).filter(|e| e.enabled).ok_or("history_disabled".into()) }
fn get_snapshot(root: &Path, index: &Index, path: &Path, snapshot_id: &str) -> Result<Snapshot, String> {
    let entry = entry(index, path)?;
    if !entry.snapshots.iter().any(|id| id == snapshot_id) { return Err("permission_denied".into()); }
    manifest_read(root, &entry.document_id, snapshot_id)
}
fn validate_unarchived(references: &[String]) -> Result<(), String> {
    if references.len() > 4096 || references.iter().any(|s| s.len() > 8192 || s.contains('\0')) { return Err("history_invalid".into()); } Ok(())
}
fn disk_input(path: &Path, references: Vec<String>, unarchived_references: Vec<String>) -> Result<Input, String> {
    let parent = root(path)?;
    let bytes = bounded(&parent, &key(path)?, MAX_TEXT as u64)?;
    let metadata = resources::read_metadata(&parent).0;
    if fs::symlink_metadata(parent.join(".easym/images.json")).is_ok() && metadata.is_none() { return Err("history_invalid".into()); }
    Ok(Input { disk_revision: Some(transaction::hash(&bytes)), bytes, references, unarchived_references, assets: vec![], metadata: metadata.unwrap_or(Metadata { schema_version: 1, instances: vec![] }) })
}

#[derive(Clone, Copy, PartialEq)]
enum CapturePhase { Objects, Manifest, Index }
fn capture(root: &Path, index: &mut Index, path: &Path, input: Input, reason: &str, name: Option<String>) -> Result<Option<String>, String> {
    capture_with(root, index, path, input, reason, name, |_| Ok(()))
}
fn capture_with(root: &Path, index: &mut Index, path: &Path, input: Input, reason: &str, name: Option<String>, mut fault: impl FnMut(CapturePhase) -> Result<(), String>) -> Result<Option<String>, String> {
    let entry = entry(index, path)?.clone(); let time = now();
    validate_unarchived(&input.unarchived_references)?;
    if index.documents.values().map(|e| e.snapshots.len()).sum::<usize>() >= MAX_ENTRIES { return Err("quota_exceeded".into()); }
    let (encoding, line_ending) = text_format(&input.bytes)?;
    if input.references.len() > 4096 || input.metadata.instances.len() > 4096 || input.metadata.schema_version != 1 || input.assets.iter().map(|a| a.bytes.len()).sum::<usize>() > MAX_RESOURCES { return Err("quota_exceeded".into()); }
    if name.as_ref().is_some_and(|n| n.len() > 512) { return Err("history_invalid".into()); }
    let mut roles: BTreeMap<String, String> = BTreeMap::new();
    for reference in input.references { relative(&reference)?; if reference.starts_with(".easym/") { return Err("permission_denied".into()); } roles.insert(reference, "plain-reference".into()); }
    let mut instances = vec![];
    for instance in input.metadata.instances {
        resources::validate_instance(&instance)?;
        let display = instance["displayPath"].as_str().ok_or("history_invalid")?;
        if !roles.contains_key(display) { continue; }
        roles.insert(display.into(), "display".into()); roles.entry(instance["sourcePath"].as_str().ok_or("history_invalid")?.into()).or_insert("source".into()); instances.push(instance);
    }
    if roles.len() > 4096 { return Err("quota_exceeded".into()); }
    let mut payloads = vec![]; let mut resources = vec![]; let mut resource_bytes = 0;
    for (path, role) in roles {
        let bytes = input.assets.iter().find(|a| a.path == path).map(|a| a.bytes.clone()).map(Ok).unwrap_or_else(|| bounded(root, &path, 20 * 1024 * 1024));
        let bytes = match bytes {
            Ok(bytes) => { if resources::verify_image(&bytes).is_err() { None } else { Some(bytes) } },
            Err(error) if error == "resource_missing" => None,
            Err(error) => return Err(error),
        };
        if let Some(bytes) = bytes {
            resource_bytes += bytes.len(); if resource_bytes > MAX_RESOURCES { return Err("quota_exceeded".into()); }
            let hash = digest(&bytes); let mime = if bytes.starts_with(b"\x89PNG") { "image/png" } else { "image/jpeg" };
            resources.push(Resource { path, role, hash: Some(hash), size: bytes.len(), mime: Some(mime.into()), missing: false }); payloads.push(bytes);
        } else { resources.push(Resource { path, role, hash: None, size: 0, mime: None, missing: true }); }
    }
    let mut previous: Vec<Snapshot> = entry.snapshots.iter().map(|id| manifest_read(root, &entry.document_id, id)).collect::<Result<_, _>>()?;
    previous.sort_by_key(|s| (s.created_at, s.snapshot_id.clone()));
    let time = previous.last().map_or(time, |s| time.max(s.created_at.saturating_add(1)));
    let body_hash = digest(&input.bytes);
    if reason == "automatic" {
        if previous.last().is_some_and(|s| s.body_hash == body_hash && s.unarchived_references == input.unarchived_references && serde_json::to_value(&s.resources).ok() == serde_json::to_value(&resources).ok() && serde_json::to_value(&s.metadata.instances).ok() == serde_json::to_value(&instances).ok()) { return Ok(None); }
        if previous.iter().filter(|s| s.reason == "automatic").any(|s| time.saturating_sub(s.created_at) < 60000) { return Ok(None); }
    }
    let used = size(root)?; let mut needed = 0; let mut hashes = BTreeSet::new();
    for bytes in std::iter::once(&input.bytes).chain(payloads.iter()) { let hash = digest(bytes); if hashes.insert(hash.clone()) && !root.join(format!("{BASE}/objects/{hash}")).exists() { needed += bytes.len() as u64; } }
    let snapshot_id = uuid::Uuid::new_v4().to_string();
    let snapshot = Snapshot { schema_version: 1, snapshot_id: snapshot_id.clone(), document_id: entry.document_id.clone(), parent_snapshot_id: previous.last().map(|s| s.snapshot_id.clone()), created_at: time, reason: reason.into(), body_hash, body_size: input.bytes.len(), encoding, line_ending, disk_revision: input.disk_revision, complete: !resources.iter().any(|r| r.missing) && input.unarchived_references.is_empty(), unarchived_references: input.unarchived_references, resources, metadata: Metadata { schema_version: 1, instances } };
    let bytes = serde_json::to_vec_pretty(&snapshot).map_err(|_| "history_invalid")?;
    if bytes.len() as u64 > MAX_JSON { return Err("quota_exceeded".into()); }
    let mut proposed_index = index.clone();
    let proposed_entry = proposed_index.documents.get_mut(&key(path)?).ok_or("history_disabled")?;
    proposed_entry.snapshots.push(snapshot_id.clone()); proposed_entry.annotations.insert(snapshot_id.clone(), Annotation { name, pinned: false });
    let index_bytes = serde_json::to_vec_pretty(&proposed_index).map_err(|_| "history_invalid")?;
    if index_bytes.len() as u64 > MAX_JSON { return Err("quota_exceeded".into()); }
    let old_index_bytes = fs::metadata(root.join(format!("{BASE}/index.json"))).map(|m| m.len()).unwrap_or(0);
    if used + needed + bytes.len() as u64 + (index_bytes.len() as u64).saturating_sub(old_index_bytes) > index.budget_bytes { return Err("history_quota".into()); }
    object_write(root, &input.bytes)?; for bytes in payloads { object_write(root, &bytes)?; } fault(CapturePhase::Objects)?;
    atomic(root, &manifest_path(&entry.document_id, &snapshot_id)?, &bytes, true)?; fault(CapturePhase::Manifest)?;
    *index = proposed_index;
    index_write(root, index)?; fault(CapturePhase::Index)?; Ok(Some(snapshot_id))
}

pub(crate) fn before_save(path: &Path, references: Vec<String>, unarchived_references: Vec<String>, expected: Option<&str>) -> Result<(), String> {
    let root = root(path)?; let mut index = index_read(&root)?;
    if index.documents.get(&key(path)?).is_none_or(|e| !e.enabled) { return Ok(()); }
    reconcile(&root, &mut index)?;
    let entry = entry(&index, path)?;
    if !entry.snapshots.iter().any(|id| manifest_read(&root, &entry.document_id, id).is_ok_and(|s| s.reason == "pre-save")) && path.exists() {
        if let Some(revision) = expected { check_revision(path, revision)?; }
        capture(&root, &mut index, path, disk_input(path, references, unarchived_references)?, "pre-save", None)?;
    }
    Ok(())
}
pub(crate) fn after_save(path: &Path, bytes: &[u8], references: Vec<String>, unarchived_references: Vec<String>, metadata: Metadata) -> Result<(), String> {
    let root = root(path)?; let mut index = index_read(&root)?;
    if index.documents.get(&key(path)?).is_none_or(|e| !e.enabled) { return Ok(()); }
    reconcile(&root, &mut index)?;
    capture(&root, &mut index, path, Input { bytes: bytes.to_vec(), references, unarchived_references, assets: vec![], metadata, disk_revision: Some(transaction::hash(bytes)) }, "automatic", None)?; Ok(())
}

fn status(root: &Path, index: &Index, path: &Path) -> Result<Value, String> {
    let entry = index.documents.get(&key(path)?);
    let mut snapshots = vec![];
    if let Some(entry) = entry {
        for id in &entry.snapshots {
            let mut value = serde_json::to_value(manifest_read(root, &entry.document_id, id)?).map_err(|_| "history_invalid")?;
            let note = entry.annotations.get(id).cloned().unwrap_or_default();
            value["name"] = json!(note.name); value["pinned"] = json!(note.pinned);
            snapshots.push(value);
        }
    }
    snapshots.sort_by(|a, b| b["createdAt"].as_u64().cmp(&a["createdAt"].as_u64()).then_with(|| b["snapshotId"].as_str().cmp(&a["snapshotId"].as_str())));
    let used = size(root)?;
    let orphans: Vec<Value> = index.documents.iter().filter(|(p, _)| !root.join(p).exists()).map(|(p, e)| json!({"path":p,"documentId":e.document_id})).collect();
    Ok(json!({"enabled":entry.is_some_and(|e| e.enabled),"documentId":entry.map(|e| &e.document_id),"readOnly":false,"usedBytes":used,"budgetBytes":index.budget_bytes,"paused":used + 65536 >= index.budget_bytes,"snapshots":snapshots,"orphans":orphans}))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Cleanup { candidates: Vec<Value>, reclaim_bytes: u64, token: String, keys: BTreeSet<String> }
fn cleanup_preview(root: &Path, index: &Index, path: &Path, selected: &[String]) -> Result<Cleanup, String> {
    let current = index.documents.get(&key(path)?); let mut keys = BTreeSet::new(); let mut candidates = vec![]; let mut kept = BTreeSet::new(); let time = now(); let mut fingerprints = vec![];
    for (document_path, entry) in &index.documents {
        let mut snapshots: Vec<Snapshot> = entry.snapshots.iter().map(|id| manifest_read(root, &entry.document_id, id)).collect::<Result<_, _>>()?;
        snapshots.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.snapshot_id.cmp(&a.snapshot_id)));
        let mut auto = 0;
        for snapshot in snapshots {
            let note = entry.annotations.get(&snapshot.snapshot_id).cloned().unwrap_or_default();
            let protected = note.pinned || snapshot.reason != "automatic";
            if !protected { auto += 1; }
            let explicit = current.is_some_and(|e| e.document_id == entry.document_id) && selected.contains(&snapshot.snapshot_id);
            if explicit && note.pinned { return Err("history_pinned".into()); }
            let remove = explicit || (!protected && (auto > 100 || time.saturating_sub(snapshot.created_at) > 30 * 24 * 60 * 60 * 1000));
            let snapshot_key = format!("{}/{}", entry.document_id, snapshot.snapshot_id);
            fingerprints.push(json!([snapshot_key, digest(&serde_json::to_vec(&snapshot).map_err(|_| "history_invalid")?), note.pinned, note.name]));
            if remove { keys.insert(snapshot_key); candidates.push(json!({"document":document_path,"snapshotId":snapshot.snapshot_id,"reason":snapshot.reason,"name":note.name,"createdAt":snapshot.created_at})); }
            else { kept.insert(snapshot.body_hash); for r in snapshot.resources { if let Some(h) = r.hash { kept.insert(h); } } }
        }
    }
    if selected.iter().any(|id| !candidates.iter().any(|c| c["snapshotId"] == *id)) { return Err("history_invalid".into()); }
    let mut reclaim = 0; let object_dir = format!("{BASE}/objects");
    if root.join(&object_dir).exists() {
        let files: Vec<_> = fs::read_dir(safe_existing(root, &object_dir)?).map_err(|_| "io_failed")?.collect();
        if files.len() > MAX_ENTRIES * 4 { return Err("quota_exceeded".into()); }
        for file in files {
            let name = file.map_err(|_| "io_failed")?.file_name().to_string_lossy().to_string();
            if !valid_hash(&name) { continue; }
            if !kept.contains(&name) { reclaim += fs::metadata(safe_existing(root, &format!("{object_dir}/{name}"))?).map_err(|_| "io_failed")?.len(); }
        }
    }
    let token = digest(&serde_json::to_vec(&json!([keys, fingerprints, size(root)?, index.budget_bytes, index.deleted])).map_err(|_| "history_invalid")?);
    Ok(Cleanup { candidates, reclaim_bytes: reclaim, token, keys })
}
fn cleanup_commit(root: &Path, index: &mut Index, plan: Cleanup) -> Result<(), String> {
    index.deleted.extend(plan.keys.clone());
    for entry in index.documents.values_mut() { entry.snapshots.retain(|id| !plan.keys.contains(&format!("{}/{id}", entry.document_id))); entry.annotations.retain(|id, _| entry.snapshots.contains(id)); }
    index_write(root, index)?;
    // Read every retained manifest before collecting; corrupt/unknown versions stop collection.
    let mut kept = BTreeSet::new();
    for entry in index.documents.values() { for id in &entry.snapshots { let snap = manifest_read(root, &entry.document_id, id)?; kept.insert(snap.body_hash); for r in snap.resources { if let Some(h) = r.hash { kept.insert(h); } } } }
    for deleted in &index.deleted {
        let (doc, snap) = deleted.split_once('/').ok_or("history_invalid")?; let relative = manifest_path(doc, snap)?;
        if fs::symlink_metadata(root.join(&relative)).is_ok() { fs::remove_file(safe_existing(root, &relative)?).map_err(|_| "io_failed")?; }
    }
    let folder = format!("{BASE}/objects");
    if root.join(&folder).exists() {
        let files: Vec<_> = fs::read_dir(safe_existing(root, &folder)?).map_err(|_| "io_failed")?.collect();
        if files.len() > MAX_ENTRIES * 4 { return Err("quota_exceeded".into()); }
        for file in files { let name = file.map_err(|_| "io_failed")?.file_name().to_string_lossy().to_string(); if valid_hash(&name) && !kept.contains(&name) { fs::remove_file(safe_existing(root, &format!("{folder}/{name}"))?).map_err(|_| "io_failed")?; } }
    }
    Ok(())
}

fn verify_resource(resource: &Resource, bytes: &[u8]) -> Result<(), String> {
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") { "image/png" } else { "image/jpeg" };
    if bytes.len() != resource.size || resource.mime.as_deref() != Some(mime) { return Err("history_corrupt".into()); }
    resources::verify_image(bytes).map_err(|_| "history_corrupt".into())
}
fn verify_snapshot(root: &Path, snapshot: &Snapshot, complete: bool) -> Result<Vec<u8>, String> {
    let bytes = object_read(root, &snapshot.body_hash, MAX_TEXT)?;
    if bytes.len() != snapshot.body_size || text_format(&bytes)? != (snapshot.encoding.clone(), snapshot.line_ending.clone()) { return Err("history_corrupt".into()); }
    if complete && !snapshot.complete { return Err("history_incomplete".into()); }
    if complete {
        for r in &snapshot.resources {
            let bytes = object_read(root, r.hash.as_deref().ok_or("history_incomplete")?, 20 * 1024 * 1024)?;
            verify_resource(r, &bytes)?;
        }
        for instance in &snapshot.metadata.instances {
            let source = snapshot.resources.iter().find(|r| Some(r.path.as_str()) == instance["sourcePath"].as_str()).ok_or("history_incomplete")?;
            if instance["sourceHash"].as_str() != Some(format!("sha256:{}", source.hash.as_deref().ok_or("history_incomplete")?).as_str())
                || !snapshot.resources.iter().any(|r| Some(r.path.as_str()) == instance["displayPath"].as_str()) { return Err("history_corrupt".into()); }
        }
    }
    Ok(bytes)
}
fn relocation(root: &Path, snapshot: &Snapshot) -> Result<BTreeMap<String, String>, String> {
    verify_snapshot(root, snapshot, true)?; let mut map = BTreeMap::new();
    for r in &snapshot.resources {
        let hash = r.hash.as_deref().ok_or("history_incomplete")?;
        let ext = if r.mime.as_deref() == Some("image/png") { "png" } else { "jpg" };
        let prefix = if r.role == "source" { "assets/.originals" } else { "assets" };
        let candidate = format!("{prefix}/img-history-{hash}.{ext}");
        let path = if fs::symlink_metadata(root.join(&candidate)).is_ok() && bounded(root, &candidate, 20 * 1024 * 1024).is_ok_and(|b| digest(&b) != hash) { format!("{prefix}/img-history-{hash}-{}.{ext}", uuid::Uuid::new_v4()) } else { candidate };
        map.insert(r.path.clone(), path);
    }
    Ok(map)
}
fn restored_resources(root: &Path, snapshot: &Snapshot, map: &BTreeMap<String, String>) -> Result<(Vec<Asset>, Metadata), String> {
    if map.len() != snapshot.resources.len() { return Err("history_invalid".into()); }
    let mut assets: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    for r in &snapshot.resources {
        let target = map.get(&r.path).ok_or("history_invalid")?; relative(target)?;
        let hash = r.hash.as_deref().ok_or("history_incomplete")?;
        let prefix = if r.role == "source" { "assets/.originals/img-history-" } else { "assets/img-history-" };
        if !target.starts_with(&format!("{prefix}{hash}")) || !target.ends_with(if r.mime.as_deref() == Some("image/png") { ".png" } else { ".jpg" }) { return Err("permission_denied".into()); }
        let bytes = object_read(root, hash, 20 * 1024 * 1024)?; verify_resource(r, &bytes)?;
        if let Some(previous) = assets.insert(target.clone(), bytes.clone()) { if previous != bytes { return Err("history_invalid".into()); } }
    }
    let mut metadata = snapshot.metadata.clone();
    for instance in &mut metadata.instances {
        for field in ["sourcePath", "displayPath"] { let old = instance[field].as_str().ok_or("history_invalid")?; instance[field] = json!(map.get(old).ok_or("history_invalid")?); }
        // A recipe's declared source must match its archived source bytes.
        let original = snapshot.metadata.instances.iter().find(|i| i["instanceId"] == instance["instanceId"] && i["displayPath"].as_str().and_then(|p| map.get(p)).is_some_and(|p| Some(p.as_str()) == instance["displayPath"].as_str())).ok_or("history_invalid")?;
        let source = snapshot.resources.iter().find(|r| Some(r.path.as_str()) == original["sourcePath"].as_str()).ok_or("history_incomplete")?;
        if original["sourceHash"].as_str() != Some(format!("sha256:{}", source.hash.as_deref().ok_or("history_incomplete")?).as_str()) { return Err("history_corrupt".into()); }
        instance["documentId"] = Value::Null;
    }
    Ok((assets.into_iter().map(|(path, bytes)| Asset { path, bytes }).collect(), metadata))
}
fn check_revision(path: &Path, expected: &str) -> Result<(), String> {
    let root = root(path)?;
    if transaction::hash(&bounded(&root, &key(path)?, MAX_TEXT as u64)?) != expected { return Err("revision_conflict".into()); } Ok(())
}
// Complete history bookkeeping only when the transaction's proposed bytes are still on disk.
// A later external edit is never replaced, nor claimed to have been restored.
fn recover_history(root: &Path, index: &mut Index, path: &Path) -> Result<(), String> {
    let Some(identity) = index.documents.get(&key(path)?).filter(|e| e.enabled).cloned() else { return Ok(()); };
    let relative_folder = format!("{BASE}/documents/{}", identity.document_id);
    if !root.join(&relative_folder).exists() { return Ok(()); }
    let files: Vec<_> = fs::read_dir(safe_existing(root, &relative_folder)?).map_err(|_| "io_failed")?.collect();
    if files.len() > MAX_ENTRIES { return Err("quota_exceeded".into()); }
    for file in files {
        let name = file.map_err(|_| "io_failed")?.file_name().to_string_lossy().to_string();
        let Some(operation) = name.strip_prefix("restore-").and_then(|n| n.strip_suffix(".json")) else { continue; };
        uuid(operation)?; let relative = format!("{relative_folder}/{name}"); let mut log: Value = json_read(root, &relative)?;
        if log["operationId"] != operation { return Err("history_invalid".into()); }
        let proposed = log["proposed"].as_str().ok_or("history_invalid")?;
        if log["historyPending"] != true || check_revision(path, proposed).is_err() { continue; }
        let references: Vec<String> = serde_json::from_value(log["references"].clone()).map_err(|_| "history_invalid")?;
        let metadata: Metadata = serde_json::from_value(log["metadata"].clone()).map_err(|_| "history_invalid")?;
        let bytes = bounded(root, &key(path)?, MAX_TEXT as u64)?;
        // Manifest may have committed before the index/log; avoid creating a duplicate recovery version.
        let current = entry(index, path)?;
        if !current.snapshots.iter().any(|id| manifest_read(root, &current.document_id, id).is_ok_and(|s| s.reason == "restore" && s.disk_revision.as_deref() == Some(proposed))) {
            capture(root, index, path, Input { bytes, references, unarchived_references: vec![], assets: vec![], metadata, disk_revision: Some(proposed.into()) }, "restore", None)?;
        }
        log["committed"] = json!(true); log["historyPending"] = json!(false);
        atomic(root, &relative, &serde_json::to_vec(&log).map_err(|_| "history_invalid")?, false)?;
    }
    Ok(())
}

pub(crate) fn separate_destination(path: &Path) -> Result<(), String> {
    let root = root(path)?; let mut index = index_read(&root)?; reconcile(&root, &mut index)?;
    let key = key(path)?;
    if let Some(old) = index.documents.remove(&key) {
        // Retain the overwritten destination's former timeline under an explicitly orphaned mapping.
        let mut orphan = format!("history-previous-{}.md", old.document_id);
        while index.documents.contains_key(&orphan) || root.join(&orphan).exists() { orphan = format!("history-previous-{}-{}.md", old.document_id, uuid::Uuid::new_v4()); }
        index.documents.insert(orphan, old);
        index.documents.insert(key, Entry { document_id: uuid::Uuid::new_v4().to_string(), enabled: false, snapshots: vec![], annotations: BTreeMap::new() });
        index_write(&root, &index)?;
    }
    Ok(())
}

fn copy_snapshot(root: &Path, path: &Path, sessions: &BTreeSet<PathBuf>, snap: &Snapshot, target: &Path, body_only: bool) -> Result<Value, String> {
    let bytes = verify_snapshot(root, snap, !body_only)?;
    let parent = target.parent().ok_or("history_invalid")?.canonicalize().map_err(|_| "permission_denied")?;
    let target = parent.join(target.file_name().ok_or("history_invalid")?);
    if target == path || sessions.contains(&target) { return Err("document_already_open".into()); }
    if fs::symlink_metadata(&target).is_ok_and(|m| m.file_type().is_symlink()) { return Err("permission_denied".into()); }
    let expected = if target.exists() { Some(transaction::hash(&bounded(&parent, &key(&target)?, MAX_TEXT as u64)?)) } else { None };
    // Preflight every collision before writing any immutable image; body commits last.
    let mut images = vec![];
    if !body_only {
        for r in &snap.resources {
            if parent.join(&r.path) == target { return Err("revision_conflict".into()); }
            let data = object_read(root, r.hash.as_deref().ok_or("history_incomplete")?, 20 * 1024 * 1024)?;
            verify_resource(r, &data)?;
            if fs::symlink_metadata(parent.join(&r.path)).is_ok() {
                if bounded(&parent, &r.path, 20 * 1024 * 1024)? != data { return Err("revision_conflict".into()); }
            } else { images.push((r.path.clone(), data)); }
        }
    }
    for (path, data) in images { atomic(&parent, &path, &data, true)?; }
    let metadata = if body_only { Metadata { schema_version: 1, instances: vec![] } } else { snap.metadata.clone() };
    let warning = transaction::save(&target, expected.as_deref(), &bytes, &[], metadata, &uuid::Uuid::new_v4().to_string())?;
    Ok(json!({"name":key(&target)?,"warning":warning,"bodyOnly":body_only}))
}

fn execute(path: &Path, sessions: &BTreeSet<PathBuf>, request: Request) -> Result<Value, String> {
    let root = root(path)?; let mut index = index_read(&root)?;
    reconcile(&root, &mut index)?;
    match request {
        Request::Status => {
            let transaction_warning = transaction::recover(path);
            let recovery = recover_history(&root, &mut index, path).err();
            let mut value = status(&root, &index, path)?;
            if let Some(error) = recovery { value["warning"] = json!(format!("历史后处理待恢复（{error}）；当前正文未改写。")); }
            else if let Some(warning) = transaction_warning { value["warning"] = json!(warning); }
            // Persist reconciled manifests, but do not create history just by opening the panel.
            if root.join(format!("{BASE}/index.json")).exists() { index_write(&root, &index)?; }
            Ok(value)
        }
        Request::Enable { references, unarchived_references, expected_revision } => {
            if let Some(revision) = expected_revision { check_revision(path, &revision)?; }
            let key = key(path)?;
            if !index.documents.contains_key(&key) { index.documents.insert(key.clone(), Entry { document_id: uuid::Uuid::new_v4().to_string(), enabled: true, snapshots: vec![], annotations: BTreeMap::new() }); }
            index.documents.get_mut(&key).ok_or("history_invalid")?.enabled = true;
            index_write(&root, &index)?;
            if entry(&index, path)?.snapshots.is_empty() { capture(&root, &mut index, path, disk_input(path, references, unarchived_references)?, "baseline", None)?; }
            status(&root, &index, path)
        }
        Request::Capture { input, name } => { capture(&root, &mut index, path, input, "manual", name)?; status(&root, &index, path) }
        Request::Detail { snapshot_id } => { let snap = get_snapshot(&root, &index, path, &snapshot_id)?; let bytes = verify_snapshot(&root, &snap, false)?; Ok(json!({"snapshot":snap,"bytes":bytes})) }
        Request::Object { snapshot_id, hash } => {
            let snap = get_snapshot(&root, &index, path, &snapshot_id)?; let resource = snap.resources.iter().find(|r| r.hash.as_deref() == Some(&hash)).ok_or("permission_denied")?;
            let bytes = object_read(&root, &hash, 20 * 1024 * 1024)?;
            verify_resource(resource, &bytes)?;
            Ok(json!({"bytes":bytes,"mime":resource.mime}))
        }
        Request::Annotate { snapshot_id, name, pinned } => {
            get_snapshot(&root, &index, path, &snapshot_id)?;
            if name.as_ref().is_some_and(|n| n.len() > 512) { return Err("history_invalid".into()); }
            index.documents.get_mut(&key(path)?).ok_or("history_disabled")?.annotations.insert(snapshot_id, Annotation { name, pinned }); index_write(&root, &index)?; status(&root, &index, path)
        }
        Request::Configure { budget_mib } => {
            entry(&index, path)?;
            if !(1..=4096).contains(&budget_mib) { return Err("history_invalid".into()); }
            index.budget_bytes = budget_mib * 1024 * 1024; index_write(&root, &index)?; status(&root, &index, path)
        }
        Request::Reassociate { document_id } => {
            uuid(&document_id)?; let new_key = key(path)?;
            if index.documents.contains_key(&new_key) { return Err("history_invalid".into()); }
            let old_key = index.documents.iter().find(|(p, e)| e.document_id == document_id && !root.join(p).exists()).map(|(p, _)| p.clone()).ok_or("permission_denied")?;
            let entry = index.documents.remove(&old_key).ok_or("history_invalid")?; index.documents.insert(new_key, entry); index_write(&root, &index)?; status(&root, &index, path)
        }
        Request::CleanupPreview { selected } => Ok(serde_json::to_value(cleanup_preview(&root, &index, path, &selected)?).map_err(|_| "history_invalid")?),
        Request::CleanupCommit { selected, token } => {
            let plan = cleanup_preview(&root, &index, path, &selected)?; if plan.token != token { return Err("revision_conflict".into()); }
            cleanup_commit(&root, &mut index, plan)?; status(&root, &index, path)
        }
        Request::Prepare { snapshot_id } => {
            let snap = get_snapshot(&root, &index, path, &snapshot_id)?; let map = relocation(&root, &snap)?; let (_, metadata) = restored_resources(&root, &snap, &map)?;
            Ok(json!({"relocations":map,"metadata":metadata}))
        }
        Request::Restore { snapshot_id, bytes, relocations, mut current, expected_revision, operation_id, encoding, line_ending } => {
            uuid(&operation_id)?; text_format(&bytes)?;
            let snap = get_snapshot(&root, &index, path, &snapshot_id)?; verify_snapshot(&root, &snap, true)?;
            // The editor keeps its own encoding policy; arbitrary mixed newline conversion is refused.
            if text_format(&current.bytes)?.1 == "mixed" { return Err("history_mixed".into()); }
            let proposed = text_format(&bytes)?;
            if !["lf", "crlf"].contains(&line_ending.as_str()) || !["utf-8", "utf-8-bom"].contains(&encoding.as_str()) || proposed.0 != encoding || proposed.1 == "mixed" { return Err("history_invalid".into()); }
            let raw = std::str::from_utf8(&bytes).map_err(|_| "history_invalid")?;
            if (line_ending == "lf" && raw.contains("\r\n")) || (line_ending == "crlf" && raw.replace("\r\n", "").contains('\n')) { return Err("history_invalid".into()); }
            check_revision(path, &expected_revision)?;
            current.disk_revision = Some(expected_revision.clone());
            let pre = capture(&root, &mut index, path, current, "pre-restore", None)?.ok_or("history_invalid")?;
            let pre_incomplete = !get_snapshot(&root, &index, path, &pre)?.complete;
            let (assets, metadata) = restored_resources(&root, &snap, &relocations)?;
            let log = format!("{BASE}/documents/{}/restore-{operation_id}.json", snap.document_id);
            atomic(&root, &log, &serde_json::to_vec(&json!({"schemaVersion":1,"operationId":operation_id,"candidate":snapshot_id,"preSnapshotId":pre,"expected":expected_revision,"proposed":transaction::hash(&bytes),"committed":false,"historyPending":true,"references":relocations.values().collect::<Vec<_>>(),"metadata":metadata})).map_err(|_| "history_invalid")?, false)?;
            let warning = transaction::save(path, Some(&expected_revision), &bytes, &assets, metadata.clone(), &operation_id)?;
            let references = relocations.values().cloned().collect();
            let history_error = capture(&root, &mut index, path, Input { bytes: bytes.clone(), references, unarchived_references: vec![], assets: vec![], metadata: metadata.clone(), disk_revision: Some(transaction::hash(&bytes)) }, "restore", None).err();
            let log_error = atomic(&root, &log, &serde_json::to_vec(&json!({"schemaVersion":1,"operationId":operation_id,"candidate":snapshot_id,"preSnapshotId":pre,"proposed":transaction::hash(&bytes),"committed":true,"historyPending":history_error.is_some(),"references":relocations.values().collect::<Vec<_>>(),"metadata":metadata})).map_err(|_| "history_invalid")?, false).err();
            let warning = warning.or_else(|| history_error.or(log_error).map(|e| format!("正文已恢复，历史后处理未完成（{e}）；恢复记录已保留。"))).or_else(|| pre_incomplete.then(|| "正文与目标归档图片已恢复；恢复前版本的正文已保留，但其图片不完整。".into()));
            Ok(json!({"revision":transaction::hash(&bytes),"metadata":metadata,"warning":warning,"preSnapshotId":pre}))
        }
        Request::Copy { snapshot_id, body_only } => {
            let snap = get_snapshot(&root, &index, path, &snapshot_id)?; verify_snapshot(&root, &snap, !body_only)?;
            let Some(target) = rfd::FileDialog::new().add_filter("Markdown", &["md", "markdown"]).set_file_name(format!("{}-history.md", key(path)?.trim_end_matches(".md"))).save_file() else { return Ok(Value::Null); };
            copy_snapshot(&root, path, sessions, &snap, &target, body_only)
        }
    }
}

#[tauri::command]
pub async fn history_operation(state: State<'_, Storage>, id: String, request: Request) -> Result<Value, String> {
    let storage = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let sessions = storage.0.lock().map_err(|_| "io_failed")?;
        let path = sessions.get(&id).ok_or("permission_denied")?;
        let is_status = matches!(request, Request::Status);
        match execute(path, &sessions.values().cloned().collect(), request) {
            Err(error) if is_status && error == "history_read_only" => Ok(json!({"enabled":false,"readOnly":true,"snapshots":[],"orphans":[],"usedBytes":0,"budgetBytes":DEFAULT_BUDGET,"paused":true,"warning":"历史格式版本较新；已保留原数据，请使用新版 EasyM。"})),
            value => value,
        }
    }).await.map_err(|_| "io_failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup(bytes: &[u8]) -> (tempfile::TempDir, PathBuf, PathBuf, Index) {
        let temp = tempfile::tempdir().unwrap(); let root = temp.path().canonicalize().unwrap(); let path = root.join("中文 note.md"); fs::write(&path, bytes).unwrap();
        execute(&path, &BTreeSet::new(), Request::Enable { references: vec![], unarchived_references: vec![], expected_revision: None }).unwrap();
        let index = index_read(&root).unwrap(); (temp, root, path, index)
    }
    fn input(bytes: &[u8]) -> Input { Input { bytes: bytes.to_vec(), references: vec![], unarchived_references: vec![], assets: vec![], metadata: Metadata { schema_version: 1, instances: vec![] }, disk_revision: Some(transaction::hash(b"old")) } }
    fn newest(root: &Path, index: &Index, path: &Path) -> Snapshot {
        let entry = entry(index, path).unwrap(); entry.snapshots.iter().map(|s| manifest_read(root, &entry.document_id, s).unwrap()).max_by_key(|s| (s.created_at, s.snapshot_id.clone())).unwrap()
    }
    fn restore_request(id: String, bytes: &[u8], current: Input, expected: &str, relocations: BTreeMap<String, String>) -> Request {
        Request::Restore { snapshot_id: id, bytes: bytes.into(), relocations, current, expected_revision: expected.into(), operation_id: uuid::Uuid::new_v4().to_string(), encoding: "utf-8".into(), line_ending: "lf".into() }
    }
    #[test]
    fn consent_restart_identity_rename_and_save_as_are_separate() {
        let temp = tempfile::tempdir().unwrap(); let root = temp.path().canonicalize().unwrap(); let path = root.join("note.md"); fs::write(&path, b"same").unwrap();
        assert_eq!(execute(&path, &BTreeSet::new(), Request::Status).unwrap()["enabled"], false); assert!(!root.join(BASE).exists());
        let first = execute(&path, &BTreeSet::new(), Request::Enable { references: vec![], unarchived_references: vec![], expected_revision: None }).unwrap();
        assert_eq!(execute(&path, &BTreeSet::new(), Request::Status).unwrap()["documentId"], first["documentId"]);
        let renamed = root.join("renamed.md"); fs::rename(&path, &renamed).unwrap();
        assert_eq!(execute(&renamed, &BTreeSet::new(), Request::Status).unwrap()["enabled"], false);
        execute(&renamed, &BTreeSet::new(), Request::Reassociate { document_id: first["documentId"].as_str().unwrap().into() }).unwrap();
        assert_eq!(execute(&renamed, &BTreeSet::new(), Request::Status).unwrap()["documentId"], first["documentId"]);
        let other = root.join("other.md"); fs::write(&other, b"same").unwrap();
        let second = execute(&other, &BTreeSet::new(), Request::Enable { references: vec![], unarchived_references: vec![], expected_revision: None }).unwrap(); assert_ne!(first["documentId"], second["documentId"]);
        separate_destination(&other).unwrap();
        let replaced = execute(&other, &BTreeSet::new(), Request::Status).unwrap(); assert_ne!(replaced["documentId"], second["documentId"]); assert_eq!(replaced["enabled"], false);
    }
    #[test]
    fn original_bom_crlf_dedup_and_automatic_interval() {
        let (_temp, root, path, mut index) = setup(b"\xef\xbb\xbfline\r\nbody");
        let baseline = newest(&root, &index, &path); assert_eq!(baseline.encoding, "utf-8-bom"); assert_eq!(baseline.line_ending, "crlf");
        assert_eq!(verify_snapshot(&root, &baseline, true).unwrap(), b"\xef\xbb\xbfline\r\nbody");
        let initial = size(&root).unwrap();
        assert!(capture(&root, &mut index, &path, input(b"\xef\xbb\xbfline\r\nbody"), "automatic", None).unwrap().is_none()); assert_eq!(size(&root).unwrap(), initial);
        assert!(capture(&root, &mut index, &path, input(b"changed"), "automatic", None).unwrap().is_some());
        assert!(capture(&root, &mut index, &path, input(b"again"), "automatic", None).unwrap().is_none());
        assert!(capture(&root, &mut index, &path, input(b"again"), "manual", Some("named".into())).unwrap().is_some());
    }
    #[test]
    fn stale_enable_and_pre_save_do_not_archive_wrong_resource_inventory() {
        let temp = tempfile::tempdir().unwrap(); let path = temp.path().join("note.md"); fs::write(&path, b"external").unwrap();
        assert_eq!(execute(&path, &BTreeSet::new(), Request::Enable { references: vec![], unarchived_references: vec![], expected_revision: Some(transaction::hash(b"stale")) }).unwrap_err(), "revision_conflict");
        assert!(!temp.path().join(BASE).exists()); assert_eq!(fs::read(&path).unwrap(), b"external");
        execute(&path, &BTreeSet::new(), Request::Enable { references: vec![], unarchived_references: vec![], expected_revision: Some(transaction::hash(b"external")) }).unwrap();
        assert_eq!(before_save(&path, vec![], vec![], Some(&transaction::hash(b"stale"))).unwrap_err(), "revision_conflict");
        assert_eq!(index_read(&root(&path).unwrap()).unwrap().documents.values().next().unwrap().snapshots.len(), 1);
    }
    #[test]
    fn forged_resource_mime_and_source_hash_block_full_copy_and_restore() {
        let (_temp, root, path, mut index) = setup(b"old"); let image = include_bytes!("../icons/32x32.png").to_vec();
        let mut data = input(b"![image](assets/img-display.png)");
        data.references = vec!["assets/img-display.png".into()];
        data.assets = vec![Asset { path: "assets/img-display.png".into(), bytes: image.clone() }, Asset { path: "assets/.originals/img-source.png".into(), bytes: image.clone() }];
        data.metadata.instances = vec![json!({"instanceId":"img-test","sourcePath":"assets/.originals/img-source.png","displayPath":"assets/img-display.png","sourceHash":transaction::hash(&image),"recipe":{"version":1}})];
        let id = capture(&root, &mut index, &path, data, "manual", None).unwrap().unwrap(); let mut snap = get_snapshot(&root, &index, &path, &id).unwrap();
        snap.metadata.instances[0]["sourceHash"] = json!(transaction::hash(b"wrong"));
        assert_eq!(verify_snapshot(&root, &snap, true).unwrap_err(), "history_corrupt");
        snap.metadata.instances.clear(); snap.resources[0].mime = Some("image/jpeg".into());
        assert_eq!(verify_snapshot(&root, &snap, true).unwrap_err(), "history_corrupt"); assert_eq!(fs::read(path).unwrap(), b"old");
    }
    #[test]
    fn deleted_current_images_restore_from_archive_with_incomplete_pre_snapshot_warning() {
        let (_temp, root, path, mut index) = setup(b"old");
        let image = include_bytes!("../icons/32x32.png").to_vec();
        let body = b"![image](assets/img-lost.png)";
        let mut archived = input(body); archived.references = vec!["assets/img-lost.png".into()];
        archived.assets = vec![Asset { path: "assets/img-lost.png".into(), bytes: image.clone() }];
        let id = capture(&root, &mut index, &path, archived, "manual", None).unwrap().unwrap();
        let snap = get_snapshot(&root, &index, &path, &id).unwrap(); let map = relocation(&root, &snap).unwrap();
        fs::write(&path, body).unwrap();
        let mut current = input(body); current.references = vec!["assets/img-lost.png".into()];
        let proposed = format!("![image]({})", map["assets/img-lost.png"]);
        let result = execute(&path, &BTreeSet::new(), restore_request(id, proposed.as_bytes(), current, &transaction::hash(body), map.clone())).unwrap();
        assert!(result["warning"].as_str().unwrap().contains("图片不完整"));
        assert_eq!(fs::read(root.join(&map["assets/img-lost.png"])).unwrap(), image);
        assert_eq!(fs::read(&path).unwrap(), proposed.as_bytes());
        let index = index_read(&root).unwrap();
        assert!(!get_snapshot(&root, &index, &path, result["preSnapshotId"].as_str().unwrap()).unwrap().complete);
    }
    #[test]
    fn exact_copy_preserves_bom_crlf_images_and_rejects_collisions_or_open_targets() {
        let (_temp, root, path, mut index) = setup(b"old");
        let body = b"\xef\xbb\xbf![image](image.png)\r\n"; let image = include_bytes!("../icons/32x32.png").to_vec();
        let mut archived = input(body); archived.references = vec!["image.png".into()];
        archived.assets = vec![Asset { path: "image.png".into(), bytes: image.clone() }];
        let id = capture(&root, &mut index, &path, archived, "manual", None).unwrap().unwrap();
        let snap = get_snapshot(&root, &index, &path, &id).unwrap();
        let destination = tempfile::tempdir().unwrap(); let target = destination.path().join("copy.md");
        fs::write(destination.path().join("image.png"), b"different").unwrap();
        assert_eq!(copy_snapshot(&root, &path, &BTreeSet::new(), &snap, &target, false).unwrap_err(), "revision_conflict"); assert!(!target.exists());
        fs::remove_file(destination.path().join("image.png")).unwrap();
        copy_snapshot(&root, &path, &BTreeSet::new(), &snap, &target, false).unwrap();
        assert_eq!(fs::read(&target).unwrap(), body); assert_eq!(fs::read(destination.path().join("image.png")).unwrap(), image);
        assert_eq!(copy_snapshot(&root, &path, &BTreeSet::from([target.canonicalize().unwrap()]), &snap, &target, true).unwrap_err(), "document_already_open");
        assert_eq!(fs::read(&path).unwrap(), b"old");
    }
    #[test]
    fn unsafe_local_references_and_invalid_metadata_are_never_complete() {
        let (_temp, root, path, mut index) = setup(b"old"); let mut data = input(b"![image](../outside.png)");
        data.unarchived_references = vec!["../outside.png".into()];
        let id = capture(&root, &mut index, &path, data, "manual", None).unwrap().unwrap(); let snap = get_snapshot(&root, &index, &path, &id).unwrap();
        assert!(!snap.complete); assert_eq!(verify_snapshot(&root, &snap, true).unwrap_err(), "history_incomplete");
        let output = root.join("body.md"); copy_snapshot(&root, &path, &BTreeSet::new(), &snap, &output, true).unwrap();
        assert_eq!(fs::read(output).unwrap(), b"![image](../outside.png)");
        atomic(&root, ".easym/images.json", br#"{"schemaVersion":9}"#, false).unwrap();
        assert!(disk_input(&path, vec![], vec![]).is_err()); assert_eq!(fs::read(&path).unwrap(), b"old");
    }
    #[test]
    fn restore_uses_current_encoding_policy_and_rejects_mixed_newlines() {
        let (_temp, _root, path, index) = setup(b"old\nline"); let target = newest(&_root, &index, &path);
        let proposed = b"\xef\xbb\xbfold\r\nline";
        let mut request = restore_request(target.snapshot_id.clone(), proposed, input(b"current"), &transaction::hash(b"old\nline"), BTreeMap::new());
        if let Request::Restore { encoding, line_ending, .. } = &mut request { *encoding = "utf-8-bom".into(); *line_ending = "crlf".into(); }
        execute(&path, &BTreeSet::new(), request).unwrap(); assert_eq!(fs::read(&path).unwrap(), proposed);
        let request = restore_request(target.snapshot_id, b"old\nline", input(b"mixed\r\nline\n"), &transaction::hash(proposed), BTreeMap::new());
        assert_eq!(execute(&path, &BTreeSet::new(), request).unwrap_err(), "history_mixed"); assert_eq!(fs::read(path).unwrap(), proposed);
    }
    #[test]
    fn archived_images_survive_asset_deletion_and_hash_corruption_blocks_restore() {
        let (_temp, root, path, mut index) = setup(b"old");
        let image = include_bytes!("../icons/32x32.png").to_vec();
        let body = b"![image](assets/img-test.png)";
        let mut data = input(body); data.references.push("assets/img-test.png".into()); data.assets.push(Asset { path: "assets/img-test.png".into(), bytes: image.clone() });
        let id = capture(&root, &mut index, &path, data, "manual", None).unwrap().unwrap(); let snap = get_snapshot(&root, &index, &path, &id).unwrap();
        assert!(snap.complete); let map = relocation(&root, &snap).unwrap(); let (assets, _) = restored_resources(&root, &snap, &map).unwrap(); assert_eq!(assets[0].bytes, image);
        assert!(!root.join("assets/img-test.png").exists());
        fs::write(root.join(format!("{BASE}/objects/{}", snap.resources[0].hash.as_ref().unwrap())), b"corrupt").unwrap();
        assert_eq!(verify_snapshot(&root, &snap, true).unwrap_err(), "history_corrupt"); assert_eq!(fs::read(&path).unwrap(), b"old");
    }
    #[test]
    fn source_recipe_archives_and_relocates_without_overwriting_collision() {
        let (_temp, root, path, mut index) = setup(b"old"); let bytes = include_bytes!("../icons/32x32.png").to_vec();
        let source = "assets/.originals/img-source.png"; let display = "assets/img-display.png";
        let mut data = input(b"![image](assets/img-display.png)"); data.references = vec![display.into()];
        data.assets = vec![Asset { path: source.into(), bytes: bytes.clone() }, Asset { path: display.into(), bytes: bytes.clone() }];
        data.metadata.instances = vec![json!({"instanceId":"img-test","documentId":null,"sourcePath":source,"displayPath":display,"sourceHash":transaction::hash(&bytes),"recipe":{"version":1},"referenceRevision":1})];
        let id = capture(&root, &mut index, &path, data, "manual", None).unwrap().unwrap(); let snap = get_snapshot(&root, &index, &path, &id).unwrap(); assert_eq!(snap.resources.len(), 2);
        let map = relocation(&root, &snap).unwrap(); let collision = &map[display];
        resources::write_assets(&root, &[Asset { path: collision.clone(), bytes: include_bytes!("../icons/64x64.png").to_vec() }]).unwrap();
        let new_map = relocation(&root, &snap).unwrap(); assert_ne!(map[display], new_map[display]);
        let (assets, metadata) = restored_resources(&root, &snap, &new_map).unwrap(); resources::write_assets(&root, &assets).unwrap();
        assert_eq!(metadata.instances[0]["displayPath"], new_map[display]); assert_eq!(metadata.instances[0]["sourceHash"], transaction::hash(&bytes));
        assert_eq!(fs::read(root.join(collision)).unwrap(), include_bytes!("../icons/64x64.png"));
    }
    #[test]
    fn missing_images_allow_body_preview_but_block_full_restore() {
        let (_temp, root, path, mut index) = setup(b"old"); let mut data = input(b"![missing](assets/no.png)"); data.references.push("assets/no.png".into());
        let id = capture(&root, &mut index, &path, data, "manual", None).unwrap().unwrap(); let snap = get_snapshot(&root, &index, &path, &id).unwrap();
        assert!(!snap.complete); assert!(verify_snapshot(&root, &snap, false).is_ok()); assert_eq!(verify_snapshot(&root, &snap, true).unwrap_err(), "history_incomplete");
    }
    #[test]
    fn objects_manifest_and_index_faults_preserve_body_and_reconcile() {
        for stop in [CapturePhase::Objects, CapturePhase::Manifest, CapturePhase::Index] {
            let (_temp, root, path, mut index) = setup(b"old"); let count = entry(&index, &path).unwrap().snapshots.len();
            assert!(capture_with(&root, &mut index, &path, input(b"candidate"), "manual", None, |phase| if phase == stop { Err("injected".into()) } else { Ok(()) }).is_err());
            assert_eq!(fs::read(&path).unwrap(), b"old"); let mut restart = index_read(&root).unwrap(); reconcile(&root, &mut restart).unwrap();
            assert_eq!(entry(&restart, &path).unwrap().snapshots.len(), count + usize::from(stop != CapturePhase::Objects));
        }
    }
    #[test]
    fn unknown_schema_identity_tampering_and_traversal_preserve_data() {
        let (_temp, root, path, index) = setup(b"old"); let id = newest(&root, &index, &path).snapshot_id;
        assert!(execute(&path, &BTreeSet::new(), Request::Detail { snapshot_id: "../note".into() }).is_err());
        let manifest = root.join(manifest_path(&entry(&index, &path).unwrap().document_id, &id).unwrap());
        let mut value: Value = serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap(); value["schemaVersion"] = json!(2); fs::write(&manifest, serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(execute(&path, &BTreeSet::new(), Request::CleanupPreview { selected: vec![] }).unwrap_err(), "history_read_only");
        assert_eq!(fs::read(&path).unwrap(), b"old"); assert_eq!(serde_json::from_slice::<Value>(&fs::read(manifest).unwrap()).unwrap()["schemaVersion"], 2);
    }
    #[test]
    fn quota_and_stale_external_revision_block_restore_before_body_commit() {
        let (_temp, root, path, mut index) = setup(b"old"); let baseline = newest(&root, &index, &path);
        fs::write(&path, b"external").unwrap();
        assert_eq!(execute(&path, &BTreeSet::new(), restore_request(baseline.snapshot_id.clone(), b"old", input(b"local"), &transaction::hash(b"old"), BTreeMap::new())).unwrap_err(), "revision_conflict");
        assert_eq!(fs::read(&path).unwrap(), b"external");
        index.budget_bytes = 1024 * 1024; index_write(&root, &index).unwrap();
        let current = input(&vec![b'x'; 1024 * 1024]);
        assert_eq!(execute(&path, &BTreeSet::new(), restore_request(baseline.snapshot_id, b"old", current, &transaction::hash(b"external"), BTreeMap::new())).unwrap_err(), "history_quota");
        assert_eq!(fs::read(&path).unwrap(), b"external");
    }
    #[test]
    fn successful_restore_preserves_pre_version_and_creates_new_history() {
        let (_temp, root, path, index) = setup(b"old"); let target = newest(&root, &index, &path);
        fs::write(&path, b"new").unwrap();
        let result = execute(&path, &BTreeSet::new(), restore_request(target.snapshot_id, b"old", input(b"unsaved edit"), &transaction::hash(b"new"), BTreeMap::new())).unwrap();
        assert_eq!(result["revision"], transaction::hash(b"old")); assert_eq!(fs::read(&path).unwrap(), b"old");
        let status = execute(&path, &BTreeSet::new(), Request::Status).unwrap(); let snaps = status["snapshots"].as_array().unwrap();
        assert!(snaps.iter().any(|s| s["reason"] == "pre-restore" && s["bodyHash"] == digest(b"unsaved edit"))); assert!(snaps.iter().any(|s| s["reason"] == "restore"));
        assert!(root.join(format!("{BASE}/objects/{}", digest(b"unsaved edit"))).exists());
    }
    #[test]
    fn cleanup_protects_pinned_and_shared_objects_across_documents_and_retries() {
        let (_temp, root, path, mut index) = setup(b"shared");
        let id = capture(&root, &mut index, &path, input(b"shared"), "manual", None).unwrap().unwrap();
        let other = root.join("other.md"); fs::write(&other, b"shared").unwrap(); execute(&other, &BTreeSet::new(), Request::Enable { references: vec![], unarchived_references: vec![], expected_revision: None }).unwrap(); index = index_read(&root).unwrap();
        let annotation = index.documents.get_mut(&key(&path).unwrap()).unwrap().annotations.get_mut(&id).unwrap(); annotation.pinned = true; index_write(&root, &index).unwrap();
        assert_eq!(cleanup_preview(&root, &index, &path, &[id.clone()]).err().unwrap(), "history_pinned");
        index.documents.get_mut(&key(&path).unwrap()).unwrap().annotations.get_mut(&id).unwrap().pinned = false;
        let plan = cleanup_preview(&root, &index, &path, &[id.clone()]).unwrap(); assert_eq!(plan.reclaim_bytes, 0); cleanup_commit(&root, &mut index, plan).unwrap();
        assert!(root.join(format!("{BASE}/objects/{}", digest(b"shared"))).exists());
        // Simulate a manifest left behind after the index tombstone commit.
        let identity = entry(&index, &path).unwrap().document_id.clone(); let mut snapshot = newest(&root, &index, &path); snapshot.snapshot_id = id.clone();
        atomic(&root, &manifest_path(&identity, &id).unwrap(), &serde_json::to_vec(&snapshot).unwrap(), true).unwrap();
        reconcile(&root, &mut index).unwrap(); assert!(!entry(&index, &path).unwrap().snapshots.contains(&id));
        let plan = cleanup_preview(&root, &index, &path, &[]).unwrap(); cleanup_commit(&root, &mut index, plan).unwrap(); assert!(!root.join(manifest_path(&identity, &id).unwrap()).exists());
        assert_eq!(fs::read(&path).unwrap(), b"shared"); assert_eq!(fs::read(&other).unwrap(), b"shared");
    }
    #[test]
    fn retention_candidates_exclude_manual_pre_restore_and_fixed_versions() {
        let (_temp, root, path, mut index) = setup(b"old");
        for reason in ["manual", "pre-restore", "automatic"] {
            let id = capture(&root, &mut index, &path, input(reason.as_bytes()), reason, None).unwrap().unwrap();
            let doc = entry(&index, &path).unwrap().document_id.clone(); let mut snapshot = manifest_read(&root, &doc, &id).unwrap(); snapshot.created_at = 1;
            atomic(&root, &manifest_path(&doc, &id).unwrap(), &serde_json::to_vec(&snapshot).unwrap(), false).unwrap();
        }
        let plan = cleanup_preview(&root, &index, &path, &[]).unwrap(); assert_eq!(plan.candidates.len(), 1); assert_eq!(plan.candidates[0]["reason"], "automatic");
    }
    #[test]
    fn interrupted_restore_bookkeeping_recovers_without_overwriting_later_edits() {
        let (_temp, root, path, mut index) = setup(b"old"); let target = newest(&root, &index, &path); let op = uuid::Uuid::new_v4().to_string();
        let log = format!("{BASE}/documents/{}/restore-{op}.json", target.document_id);
        let record = json!({"schemaVersion":1,"operationId":op,"candidate":target.snapshot_id,"preSnapshotId":target.snapshot_id,"proposed":transaction::hash(b"restored"),"committed":false,"historyPending":true,"references":[],"metadata":{"schemaVersion":1,"instances":[]}});
        atomic(&root, &log, &serde_json::to_vec(&record).unwrap(), false).unwrap(); fs::write(&path, b"external").unwrap(); recover_history(&root, &mut index, &path).unwrap(); assert_eq!(fs::read(&path).unwrap(), b"external");
        fs::write(&path, b"restored").unwrap(); recover_history(&root, &mut index, &path).unwrap();
        assert!(entry(&index, &path).unwrap().snapshots.iter().any(|id| manifest_read(&root, &target.document_id, id).unwrap().reason == "restore"));
        let count = entry(&index, &path).unwrap().snapshots.len(); recover_history(&root, &mut index, &path).unwrap(); assert_eq!(count, entry(&index, &path).unwrap().snapshots.len());
    }
    #[cfg(unix)]
    #[test]
    fn symlink_objects_and_resources_never_escape_history_scope() {
        use std::os::unix::fs::symlink;
        let (_temp, root, path, mut index) = setup(b"old"); let external = tempfile::tempdir().unwrap(); fs::write(external.path().join("secret"), b"secret").unwrap();
        symlink(external.path(), root.join("linked")).unwrap(); let mut data = input(b"![a](linked/secret)"); data.references = vec!["linked/secret".into()];
        assert_eq!(capture(&root, &mut index, &path, data, "manual", None).err().unwrap(), "permission_denied");
        assert_eq!(fs::read(external.path().join("secret")).unwrap(), b"secret");
    }
}
