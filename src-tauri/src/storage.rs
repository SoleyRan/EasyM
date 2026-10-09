use std::{collections::HashMap, fs, path::{Component, Path, PathBuf}, sync::{Arc, Mutex}};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::State;
use crate::resources::{Asset, Metadata, read_metadata, safe_existing};
use crate::transaction;

const MAX_TEXT: usize = 10 * 1024 * 1024;
const MAX_IMAGE: u64 = 20 * 1024 * 1024;

#[derive(Clone, Default)]
pub struct Storage(pub Arc<Mutex<HashMap<String, PathBuf>>>);

#[derive(Serialize)]
pub struct OpenedFile { id: String, name: String, bytes: Vec<u8>, revision: String, metadata: Option<Metadata>, warning: Option<String> }
#[derive(Serialize)]
pub struct SavedFile { id: String, name: String, revision: String, warning: Option<String> }
#[derive(Serialize)]
pub struct ImageFile { bytes: Vec<u8>, mime: String }

fn hash(bytes: &[u8]) -> String { format!("sha256:{:x}", Sha256::digest(bytes)) }
fn name(path: &Path) -> String { path.file_name().unwrap_or_default().to_string_lossy().to_string() }
fn read_text(path: &Path) -> Result<Vec<u8>, String> {
    if !path.is_file() { return Err("invalid_data".into()); }
    if fs::metadata(path).map_err(|_| "resource_missing")?.len() > MAX_TEXT as u64 { return Err("quota_exceeded".into()); }
    let bytes = fs::read(path).map_err(|_| "io_failed")?;
    if bytes.len() > MAX_TEXT { return Err("quota_exceeded".into()); }
    Ok(bytes)
}

pub(crate) fn open_path(storage: &Storage, path: PathBuf) -> Result<OpenedFile, String> {
    let bytes = read_text(&path)?;
    let id = uuid::Uuid::new_v4().to_string();
    let recovery = transaction::recover(&path);
    let (metadata, warning) = read_metadata(path.parent().ok_or("invalid_data")?);
    let result = OpenedFile { id: id.clone(), name: name(&path), revision: hash(&bytes), bytes, metadata, warning: recovery.or(warning) };
    storage.0.lock().map_err(|_| "io_failed")?.insert(id, path);
    Ok(result)
}

pub(crate) fn read_image_path(path: &Path) -> Result<ImageFile, String> {
    if !path.is_file() { return Err("invalid_data".into()); }
    if fs::metadata(path).map_err(|_| "resource_missing")?.len() > MAX_IMAGE { return Err("quota_exceeded".into()); }
    let bytes = fs::read(path).map_err(|_| "io_failed")?;
    if bytes.len() > MAX_IMAGE as usize { return Err("quota_exceeded".into()); }
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") { "image/png" } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) { "image/jpeg" } else { return Err("invalid_data".into()); };
    Ok(ImageFile { bytes, mime: mime.to_string() })
}

#[tauri::command]
pub async fn open_document(state: State<'_, Storage>) -> Result<Option<OpenedFile>, String> {
    let storage = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = rfd::FileDialog::new().add_filter("Markdown", &["md", "markdown"]).pick_file() else { return Ok(None); };
        let path = path.canonicalize().map_err(|_| "resource_missing")?;
        open_path(&storage, path).map(Some)
    }).await.map_err(|_| "io_failed".to_string())?
}

#[tauri::command]
pub async fn save_document(state: State<'_, Storage>, id: Option<String>, name: String, expected_revision: Option<String>, bytes: Vec<u8>, save_as: bool, assets: Vec<Asset>, metadata: Metadata, operation_id: String) -> Result<Option<SavedFile>, String> {
    if bytes.len() > MAX_TEXT { return Err("quota_exceeded".into()); }
    uuid::Uuid::parse_str(&operation_id).map_err(|_| "invalid_data")?;
    let storage = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Serializes this application's writers. External tools are checked optimistically.
        let mut sessions = storage.0.lock().map_err(|_| "io_failed")?;
        let (session_id, path, expected) = if save_as || id.is_none() {
            let safe_name = Path::new(&name).file_name().unwrap_or_default().to_string_lossy();
            let Some(path) = rfd::FileDialog::new().add_filter("Markdown", &["md", "markdown"]).set_file_name(safe_name.as_ref()).save_file() else { return Ok(None); };
            let parent = path.parent().ok_or("invalid_data")?.canonicalize().map_err(|_| "permission_denied")?;
            let path = parent.join(path.file_name().ok_or("invalid_data")?);
            if fs::symlink_metadata(&path).map(|m| m.file_type().is_symlink()).unwrap_or(false) { return Err("permission_denied".into()); }
            let expected = if path.exists() { Some(hash(&read_text(&path)?)) } else { None };
            (uuid::Uuid::new_v4().to_string(), path, expected)
        } else {
            let session_id = id.ok_or("invalid_data")?;
            let path = sessions.get(&session_id).ok_or("permission_denied")?.clone();
            (session_id, path, expected_revision)
        };
        let warning = transaction::save(&path, expected.as_deref(), &bytes, &assets, metadata, &operation_id)?;
        // The base revision is the body we committed, so later external writes conflict on the next save.
        let revision = hash(&bytes);
        let result = SavedFile { id: session_id.clone(), name: crate::storage::name(&path), revision, warning };
        sessions.insert(session_id, path);
        Ok(Some(result))
    }).await.map_err(|_| "io_failed".to_string())?
}

#[tauri::command]
pub async fn read_image(state: State<'_, Storage>, id: String, relative_path: String) -> Result<ImageFile, String> {
    let storage = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let sessions = storage.0.lock().map_err(|_| "io_failed")?;
        let document = sessions.get(&id).ok_or("permission_denied")?;
        let root = document.parent().ok_or("invalid_data")?.canonicalize().map_err(|_| "io_failed")?;
        let relative = Path::new(&relative_path);
        if relative.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) { return Err("permission_denied".into()); }
        let target = safe_existing(&root, &relative_path)?;
        if !target.starts_with(&root) { return Err("permission_denied".into()); }
        read_image_path(&target)
    }).await.map_err(|_| "io_failed".to_string())?
}

#[tauri::command]
pub async fn reload_document(state: State<'_, Storage>, id: String) -> Result<OpenedFile, String> {
    let storage = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let sessions = storage.0.lock().map_err(|_| "io_failed")?;
        let path = sessions.get(&id).ok_or("permission_denied")?;
        if fs::symlink_metadata(path).map_err(|_| "resource_missing")?.file_type().is_symlink() { return Err("permission_denied".into()); }
        let bytes = read_text(path)?;
        let recovery = transaction::recover(path);
        let (metadata, warning) = read_metadata(path.parent().ok_or("invalid_data")?);
        let warning = recovery.or(warning);
        Ok(OpenedFile { id, name: name(path), revision: hash(&bytes), bytes, metadata, warning })
    }).await.map_err(|_| "io_failed".to_string())?
}
