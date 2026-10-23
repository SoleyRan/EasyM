//! v2 step 2A: persistent sync identity at `<workspace>/.easym/sync/workspace.json`.
//! The pure rules live in src/core/sync-identity.ts; this module only supplies a complete,
//! read-only scan and validated, atomic writes of that single file. It never touches bodies,
//! images.json or history.
use std::{collections::{BTreeMap, BTreeSet}, fs, io::Write, path::Path};
use serde::Serialize;
use tauri::State;
use tempfile::NamedTempFile;
use crate::{resources::{directory, safe_existing}, storage::Storage, workspace::{root, Workspaces}};

pub(crate) const IDENTITY: &str = ".easym/sync/workspace.json";
const MAX_IDENTITY: u64 = 4 * 1024 * 1024;
const MAX_DOCUMENTS: usize = 10_000;
const MAX_ENTRIES: usize = 50_000;
const MAX_DEPTH: usize = 32;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskDocument { path: String, history_id: Option<String>, #[serde(skip_serializing_if = "std::ops::Not::not")] history_unreadable: bool }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityScan {
    /// Raw identity bytes, parsed and validated by the TypeScript core; None if absent.
    identity: Option<Vec<u8>>,
    /// The file exists but is unreadable or not a regular file; enabling must stop.
    identity_error: Option<String>,
    documents: Vec<DiskDocument>,
    /// Directories that could not be listed. A non-empty list makes the scan incomplete.
    unreadable: Vec<String>,
}

fn ignored_directory(name: &str) -> bool {
    name.starts_with('.') || matches!(name, "node_modules" | "target")
}
fn is_document(name: &str) -> bool {
    let lower = name.to_ascii_lowercase(); lower.ends_with(".md") || lower.ends_with(".markdown")
}

/// Complete scan or an error: limits are hard failures, never silent truncation, because a
/// missing file in a partial scan would look like a deletion.
pub(crate) fn scan(root: &Path) -> Result<IdentityScan, String> {
    let mut documents = Vec::new(); let mut unreadable = Vec::new();
    let mut histories: BTreeMap<String, Result<Option<BTreeMap<String, String>>, String>> = BTreeMap::new();
    let mut stack = vec![(String::new(), 0usize)];
    let mut entries = 0usize;
    while let Some((relative, depth)) = stack.pop() {
        let directory = if relative.is_empty() { root.to_path_buf() } else { match safe_existing(root, &relative) { Ok(path) => path, Err(_) => { unreadable.push(relative); continue; } } };
        let items = match fs::read_dir(&directory) { Ok(items) => items, Err(_) => { unreadable.push(relative); continue; } };
        let mut names = Vec::new();
        for item in items {
            entries += 1;
            if entries > MAX_ENTRIES { return Err("quota_exceeded".into()); }
            let item = item.map_err(|_| "io_failed")?;
            let info = item.file_type().map_err(|_| "io_failed")?;
            let Some(name) = item.file_name().to_str().map(str::to_string) else { if !info.is_dir() { unreadable.push(format!("{relative}/<non-utf8>")); } continue; };
            if info.is_symlink() { continue; }
            let path = if relative.is_empty() { name.clone() } else { format!("{relative}/{name}") };
            if info.is_dir() {
                if ignored_directory(&name) { continue; }
                if depth >= MAX_DEPTH { return Err("quota_exceeded".into()); }
                stack.push((path, depth + 1));
            } else if info.is_file() && is_document(&name) { names.push((name, path)); }
        }
        if names.is_empty() { continue; }
        let history = histories.entry(relative.clone()).or_insert_with(|| crate::history::history_identities(&directory));
        for (name, path) in names {
            if documents.len() >= MAX_DOCUMENTS { return Err("quota_exceeded".into()); }
            let (history_id, history_unreadable) = match history { Ok(Some(map)) => (map.get(&name).cloned(), false), Ok(None) => (None, false), Err(_) => (None, true) };
            documents.push(DiskDocument { path, history_id, history_unreadable });
        }
    }
    documents.sort_by(|a, b| a.path.cmp(&b.path));
    unreadable.sort();
    let (identity, identity_error) = match read_identity(root) { Ok(bytes) => (bytes, None), Err(error) => (None, Some(error)) };
    Ok(IdentityScan { identity, identity_error, documents, unreadable })
}

impl IdentityScan {
    pub(crate) fn unreadable(&self) -> &[String] { &self.unreadable }
    pub(crate) fn identity_error(&self) -> Option<&str> { self.identity_error.as_deref() }
    pub(crate) fn identity_bytes(&self) -> Option<Vec<u8>> { self.identity.clone() }
    /// (path, history documentId, history unreadable) of every Markdown document found.
    pub(crate) fn entries(&self) -> Vec<(String, Option<String>, bool)> { self.documents.iter().map(|d| (d.path.clone(), d.history_id.clone(), d.history_unreadable)).collect() }
}

pub(crate) fn read_identity(root: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::symlink_metadata(root.join(IDENTITY)) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("io_failed".into()),
        Ok(_) => (),
    }
    let path = safe_existing(root, IDENTITY)?;
    let info = fs::metadata(&path).map_err(|_| "io_failed")?;
    if !info.is_file() { return Err("invalid_data".into()); }
    if info.len() > MAX_IDENTITY { return Err("quota_exceeded".into()); }
    Ok(Some(fs::read(path).map_err(|_| "io_failed")?))
}

fn digest(bytes: &[u8]) -> String { crate::transaction::hash(bytes) }

/// Minimal native checks; full validation is done by the core before it sends bytes. The native
/// side still refuses anything that would let the file name paths outside the workspace.
fn validate(bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_IDENTITY { return Err("invalid_data".into()); }
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| "invalid_data")?;
    if value["schemaVersion"] != 1 || !value["workspaceId"].is_string() { return Err("invalid_data".into()); }
    let documents = value["documents"].as_array().ok_or("invalid_data")?;
    if documents.len() > MAX_DOCUMENTS { return Err("quota_exceeded".into()); }
    let mut ids = BTreeSet::new(); let mut paths = BTreeSet::new();
    for document in documents {
        let id = document["documentId"].as_str().ok_or("invalid_data")?;
        let path = document["path"].as_str().ok_or("invalid_data")?;
        uuid::Uuid::parse_str(id).map_err(|_| "invalid_data")?;
        if path.is_empty() || path.contains(['\\', ':', '\0']) || path.starts_with('/') || path.split('/').any(|p| p.is_empty() || p == "." || p == "..") { return Err("permission_denied".into()); }
        if !ids.insert(id.to_string()) || !paths.insert(path.to_lowercase()) { return Err("invalid_data".into()); }
    }
    Ok(())
}

/// Conditional, atomic replace. `expected` is the digest of the bytes the plan was computed from
/// (None = file must not exist), so a concurrent change is a conflict, never an overwrite.
pub(crate) fn write(root: &Path, expected: Option<&str>, bytes: &[u8]) -> Result<String, String> {
    validate(bytes)?;
    let current = read_identity(root)?;
    if current.as_deref().map(digest).as_deref() != expected { return Err("revision_conflict".into()); }
    let parent = directory(root, ".easym/sync")?;
    let mut file = NamedTempFile::new_in(&parent).map_err(|_| "io_failed")?;
    file.write_all(bytes).map_err(|_| "io_failed")?; file.as_file().sync_all().map_err(|_| "io_failed")?;
    if fs::read(file.path()).map_err(|_| "io_failed")? != bytes { return Err("io_failed".into()); }
    let target = parent.join("workspace.json");
    if current.is_none() { file.persist_noclobber(target).map_err(|_| "revision_conflict")?; } else { file.persist(target).map_err(|_| "io_failed")?; }
    Ok(digest(bytes))
}

/// Rollback of enabling: removes only the identity file (and the then-empty sync directory).
pub(crate) fn remove(root: &Path, expected: &str) -> Result<(), String> {
    let current = read_identity(root)?.ok_or("resource_missing")?;
    if digest(&current) != expected { return Err("revision_conflict".into()); }
    fs::remove_file(safe_existing(root, IDENTITY)?).map_err(|_| "io_failed")?;
    if let Ok(sync) = safe_existing(root, ".easym/sync") { let _ = fs::remove_dir(sync); }
    Ok(())
}

// Holding the storage lock serializes identity writes with saves, history and merges.
#[tauri::command]
pub async fn sync_identity_scan(state: State<'_, Workspaces>, storage: State<'_, Storage>, id: String) -> Result<IdentityScan, String> {
    let workspaces = state.inner().clone(); let storage = storage.inner().clone();
    tauri::async_runtime::spawn_blocking(move || { let _queue = storage.0.lock().map_err(|_| "io_failed")?; scan(&root(&workspaces, &id)?) }).await.map_err(|_| "io_failed".to_string())?
}

#[tauri::command]
pub async fn sync_identity_write(state: State<'_, Workspaces>, storage: State<'_, Storage>, id: String, expected: Option<String>, bytes: Vec<u8>) -> Result<String, String> {
    let workspaces = state.inner().clone(); let storage = storage.inner().clone();
    tauri::async_runtime::spawn_blocking(move || { let _queue = storage.0.lock().map_err(|_| "io_failed")?; write(&root(&workspaces, &id)?, expected.as_deref(), &bytes) }).await.map_err(|_| "io_failed".to_string())?
}

#[tauri::command]
pub async fn sync_identity_remove(state: State<'_, Workspaces>, storage: State<'_, Storage>, id: String, expected: String) -> Result<(), String> {
    let workspaces = state.inner().clone(); let storage = storage.inner().clone();
    tauri::async_runtime::spawn_blocking(move || { let _queue = storage.0.lock().map_err(|_| "io_failed")?; remove(&root(&workspaces, &id)?, &expected) }).await.map_err(|_| "io_failed".to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;

    fn tree(root: &Path) -> Vec<(String, Vec<u8>)> {
        let mut files = Vec::new(); let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for item in fs::read_dir(dir).unwrap() {
                let path = item.unwrap().path();
                if path.is_dir() { stack.push(path); } else { files.push((path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"), fs::read(&path).unwrap())); }
            }
        }
        files.sort(); files
    }
    fn identity(documents: &[(&str, &str)]) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"workspaceId":"1358f0a2-25b8-441b-9d55-379f6ca303dc","documents":documents.iter().map(|(id, path)| serde_json::json!({"documentId":id,"path":path})).collect::<Vec<_>>()})).unwrap()
    }
    const A: &str = "a1b2c3d4-0000-4000-8000-000000000001";

    #[test]
    fn scan_lists_markdown_recursively_without_writing_anything() {
        let temp = tempfile::tempdir().unwrap(); let root = temp.path().canonicalize().unwrap();
        fs::create_dir_all(root.join("笔记/深")).unwrap(); fs::create_dir_all(root.join("node_modules")).unwrap(); fs::create_dir_all(root.join(".hidden")).unwrap();
        fs::write(root.join("a.md"), "\u{feff}a\r\n").unwrap(); fs::write(root.join("笔记/深/b.MARKDOWN"), [0xff, 0x00]).unwrap();
        fs::write(root.join("image.png"), "x").unwrap(); fs::write(root.join("node_modules/x.md"), "").unwrap(); fs::write(root.join(".hidden/y.md"), "").unwrap();
        let before = tree(&root);
        let scan = scan(&root).unwrap();
        assert_eq!(scan.documents.iter().map(|d| d.path.as_str()).collect::<Vec<_>>(), vec!["a.md", "笔记/深/b.MARKDOWN"]);
        assert!(scan.identity.is_none() && scan.identity_error.is_none() && scan.unreadable.is_empty());
        assert_eq!(tree(&root), before);
    }

    #[test]
    fn scan_reports_history_ids_and_marks_damaged_history_unreadable() {
        let temp = tempfile::tempdir().unwrap(); let root = temp.path().canonicalize().unwrap();
        fs::create_dir_all(root.join("ok/.easym/history")).unwrap(); fs::create_dir_all(root.join("bad/.easym/history")).unwrap();
        fs::write(root.join("ok/n.md"), "n").unwrap(); fs::write(root.join("bad/n.md"), "n").unwrap();
        fs::write(root.join("ok/.easym/history/index.json"), serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"budgetBytes":536870912u64,"documents":{"n.md":{"documentId":A,"enabled":true,"snapshots":[]}},"deleted":[]})).unwrap()).unwrap();
        fs::write(root.join("bad/.easym/history/index.json"), b"corrupt").unwrap();
        let before = tree(&root);
        let scan = scan(&root).unwrap();
        let get = |p: &str| scan.documents.iter().find(|d| d.path == p).unwrap();
        assert_eq!(get("ok/n.md").history_id.as_deref(), Some(A)); assert!(!get("ok/n.md").history_unreadable);
        assert!(get("bad/n.md").history_id.is_none()); assert!(get("bad/n.md").history_unreadable);
        assert_eq!(tree(&root), before);
    }

    #[test]
    fn scan_fails_instead_of_truncating() {
        let temp = tempfile::tempdir().unwrap(); let root = temp.path().canonicalize().unwrap();
        let mut deep = root.clone();
        for _ in 0..=MAX_DEPTH { deep.push("d"); fs::create_dir(&deep).unwrap(); }
        assert_eq!(scan(&root).err().as_deref(), Some("quota_exceeded"));
    }

    #[cfg(unix)]
    #[test]
    fn scan_skips_links_and_identity_link_is_refused() {
        let temp = tempfile::tempdir().unwrap(); let outside = tempfile::tempdir().unwrap(); let root = temp.path().canonicalize().unwrap();
        fs::write(outside.path().join("secret.md"), "").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("linked")).unwrap();
        assert!(scan(&root).unwrap().documents.is_empty());
        fs::create_dir_all(root.join(".easym/sync")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.md"), root.join(IDENTITY)).unwrap();
        assert!(scan(&root).unwrap().identity_error.is_some());
        assert!(write(&root, None, &identity(&[])).is_err());
    }

    #[test]
    fn writes_are_conditional_atomic_and_validated() {
        let temp = tempfile::tempdir().unwrap(); let root = temp.path().canonicalize().unwrap();
        fs::write(root.join("a.md"), "a").unwrap();
        let first = identity(&[(A, "a.md")]);
        let digest = write(&root, None, &first).unwrap();
        assert_eq!(write(&root, None, &first).unwrap_err(), "revision_conflict");
        assert_eq!(write(&root, Some("sha256:stale"), &identity(&[])).unwrap_err(), "revision_conflict");
        for bad in [identity(&[(A, "../escape.md")]), identity(&[(A, "C:/x.md")]), identity(&[(A, "a.md"), (A, "b.md")]), identity(&[("x", "a.md")]), b"{}".to_vec()] {
            assert!(write(&root, Some(&digest), &bad).is_err());
        }
        assert_eq!(fs::read(root.join(IDENTITY)).unwrap(), first);
        let second = identity(&[(A, "renamed.md")]);
        write(&root, Some(&digest), &second).unwrap();
        assert_eq!(scan(&root).unwrap().identity.unwrap(), second);
        assert_eq!(fs::read_dir(root.join(".easym/sync")).unwrap().count(), 1);
    }

    #[test]
    fn rollback_removes_only_the_identity_file() {
        let temp = tempfile::tempdir().unwrap(); let root = temp.path().canonicalize().unwrap();
        fs::create_dir_all(root.join(".easym")).unwrap(); fs::write(root.join(".easym/images.json"), "{}").unwrap(); fs::write(root.join("a.md"), "a").unwrap();
        let before = tree(&root);
        let digest = write(&root, None, &identity(&[(A, "a.md")])).unwrap();
        assert_eq!(remove(&root, "sha256:other").unwrap_err(), "revision_conflict");
        remove(&root, &digest).unwrap();
        assert_eq!(tree(&root), before);
        assert!(!root.join(".easym/sync").exists());
    }
}
