use std::{collections::HashMap, fs, path::{Path, PathBuf}, sync::{Arc, Mutex}};
use serde::Serialize;
use tauri::State;
use crate::{resources::safe_existing, storage::{self, ImageFile, OpenedFile, Storage}};

#[derive(Clone, Default)]
pub struct Workspaces(Arc<Mutex<HashMap<String, PathBuf>>>);

#[derive(Serialize)]
pub struct Entry { path: String, name: String, kind: &'static str }

#[derive(Serialize)]
pub struct Workspace { id: String, name: String, entries: Vec<Entry> }

fn kind(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "md" | "markdown" => Some("document"),
        "png" | "jpg" | "jpeg" => Some("image"),
        _ => None,
    }
}

fn directory_entries(root: &Path, relative: &str) -> Result<Vec<Entry>, String> {
    let directory = if relative.is_empty() { root.to_path_buf() } else { safe_existing(root, relative)? };
    if !directory.is_dir() { return Err("invalid_data".into()); }
    let mut entries = Vec::new();
    for (count, item) in fs::read_dir(directory).map_err(|_| "permission_denied")?.enumerate() {
        if count >= 4096 { return Err("quota_exceeded".into()); }
        let item = item.map_err(|_| "io_failed")?;
        let name = item.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || matches!(name.as_str(), "node_modules" | "target") { continue; }
        let info = item.file_type().map_err(|_| "io_failed")?;
        if info.is_symlink() { continue; }
        let path = if relative.is_empty() { name.clone() } else { format!("{relative}/{name}") };
        // Skip links/junctions and entries that cannot be expressed as a safe relative path.
        if safe_existing(root, &path).is_err() { continue; }
        let entry_kind = if info.is_dir() { "directory" } else if info.is_file() {
            let Some(value) = kind(&item.path()) else { continue; }; value
        } else { continue; };
        entries.push(Entry { path, name, kind: entry_kind });
    }
    entries.sort_by(|a, b| (a.kind != "directory").cmp(&(b.kind != "directory")).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(entries)
}

fn root(workspaces: &Workspaces, id: &str) -> Result<PathBuf, String> {
    workspaces.0.lock().map_err(|_| "io_failed")?.get(id).cloned().ok_or_else(|| "permission_denied".into())
}

#[tauri::command]
pub async fn open_workspace(state: State<'_, Workspaces>) -> Result<Option<Workspace>, String> {
    let workspaces = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = rfd::FileDialog::new().pick_folder() else { return Ok(None); };
        let path = path.canonicalize().map_err(|_| "resource_missing")?;
        let entries = directory_entries(&path, "")?;
        let id = uuid::Uuid::new_v4().to_string();
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        workspaces.0.lock().map_err(|_| "io_failed")?.insert(id.clone(), path);
        Ok(Some(Workspace { id, name, entries }))
    }).await.map_err(|_| "io_failed".to_string())?
}

#[tauri::command]
pub async fn list_workspace(state: State<'_, Workspaces>, id: String, relative_path: String) -> Result<Vec<Entry>, String> {
    let workspaces = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || directory_entries(&root(&workspaces, &id)?, &relative_path)).await.map_err(|_| "io_failed".to_string())?
}

#[tauri::command]
pub async fn open_workspace_document(state: State<'_, Workspaces>, storage: State<'_, Storage>, id: String, relative_path: String) -> Result<OpenedFile, String> {
    let workspaces = state.inner().clone(); let storage = storage.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = safe_existing(&root(&workspaces, &id)?, &relative_path)?;
        if kind(&path) != Some("document") { return Err("invalid_data".into()); }
        storage::open_path(&storage, path)
    }).await.map_err(|_| "io_failed".to_string())?
}

#[tauri::command]
pub async fn read_workspace_image(state: State<'_, Workspaces>, id: String, relative_path: String) -> Result<ImageFile, String> {
    let workspaces = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = safe_existing(&root(&workspaces, &id)?, &relative_path)?;
        if kind(&path) != Some("image") { return Err("invalid_data".into()); }
        storage::read_image_path(&path)
    }).await.map_err(|_| "io_failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_supported_files_lazily_and_excludes_private_directories() {
        let temp = tempfile::tempdir().unwrap(); let root = temp.path().canonicalize().unwrap();
        fs::create_dir(root.join("notes")).unwrap(); fs::create_dir(root.join(".easym")).unwrap();
        fs::write(root.join("README.MD"), "body").unwrap(); fs::write(root.join("photo.JPEG"), "image").unwrap();
        fs::write(root.join("private.txt"), "private").unwrap(); fs::write(root.join("notes/中文.md"), "nested").unwrap();
        let entries = directory_entries(&root, "").unwrap();
        assert_eq!(entries.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(), vec!["notes", "photo.JPEG", "README.MD"]);
        assert_eq!(directory_entries(&root, "notes").unwrap()[0].path, "notes/中文.md");
    }

    #[test]
    fn directory_reads_require_authorized_ids_and_relative_paths() {
        let temp = tempfile::tempdir().unwrap(); let directory = temp.path().canonicalize().unwrap();
        assert!(root(&Workspaces::default(), "guessed-id").is_err());
        for path in ["..", "../outside", "/", "C:/", "notes\\outside", "notes:stream"] { assert!(directory_entries(&directory, path).is_err()); }
        fs::write(directory.join("note.md"), "body").unwrap();
        assert!(directory_entries(&directory, "note.md").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn directory_links_are_never_listed_or_followed() {
        let temp = tempfile::tempdir().unwrap(); let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), temp.path().join("linked")).unwrap();
        let root = temp.path().canonicalize().unwrap();
        assert!(directory_entries(&root, "").unwrap().is_empty());
        assert!(directory_entries(&root, "linked").is_err());
    }
}
