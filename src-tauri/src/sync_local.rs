//! v2 step 3B: local side of a sync pass. Reads are complete-or-error; writes reuse the existing
//! journaled save (`transaction::save`: immutable assets, merged images.json, revision check)
//! and step 2's trash/move, so remote data never bypasses local conflict protection.
use std::{fs, path::Path};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;
use crate::{resources::{safe_existing, Asset, Metadata}, storage::{checked_document, read_text, Storage}, transaction, workspace::{root, Workspaces}};

const MAX_TEXT: usize = 10 * 1024 * 1024;
const MAX_IMAGE: u64 = 20 * 1024 * 1024;
const MAX_ASSETS: usize = 128 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision { path: String, revision: String, bytes: u64, history_id: Option<String>, #[serde(skip_serializing_if = "std::ops::Not::not")] history_unreadable: bool }

/// One complete local scan: identity bytes (parsed by the core) and every document's revision.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalScan { identity: Option<Vec<u8>>, documents: Vec<Revision> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDocument { bytes: Vec<u8>, revision: String, instances: Option<Vec<Value>> }

/// Body revision (`sha256:` of raw bytes) of every Markdown document a complete scan finds.
/// Unreadable directories make the scan an error: a missing entry must never look deleted.
pub(crate) fn revisions(root: &Path) -> Result<LocalScan, String> {
    let scan = crate::sync_identity::scan(root)?;
    if !scan.unreadable().is_empty() { return Err("scan_incomplete".into()); }
    if let Some(error) = scan.identity_error() { return Err(error.to_string()); }
    let mut documents = Vec::new();
    for (path, history_id, history_unreadable) in scan.entries() {
        let file = safe_existing(root, &path)?;
        checked_document(&file)?;
        let bytes = read_text(&file)?;
        documents.push(Revision { revision: transaction::hash(&bytes), bytes: bytes.len() as u64, path, history_id, history_unreadable });
    }
    Ok(LocalScan { identity: scan.identity_bytes(), documents })
}

fn split(relative: &str) -> (&str, &str) { relative.rsplit_once('/').unwrap_or(("", relative)) }
fn dir_of(root: &Path, relative: &str) -> Result<std::path::PathBuf, String> {
    let directory = split(relative).0;
    if directory.is_empty() { Ok(root.to_path_buf()) } else { safe_existing(root, directory) }
}

/// One document's bytes and its directory's image instances (None when images.json is unreadable).
pub(crate) fn read_document(root: &Path, path: &str) -> Result<LocalDocument, String> {
    let file = safe_existing(root, path)?;
    checked_document(&file)?;
    let bytes = read_text(&file)?;
    let directory = dir_of(root, path)?;
    let instances = if directory.join(".easym/images.json").exists() { crate::resources::read_metadata(&directory).0.map(|m| m.instances) } else { Some(vec![]) };
    Ok(LocalDocument { revision: transaction::hash(&bytes), bytes, instances })
}

/// A managed image relative to a document directory; None when absent (reported, never invented).
pub(crate) fn read_asset(root: &Path, directory: &str, asset: &str) -> Result<Option<Vec<u8>>, String> {
    if !crate::resources::is_managed(asset) { return Err("permission_denied".into()); }
    let base = if directory.is_empty() { root.to_path_buf() } else { match safe_existing(root, directory) { Ok(p) => p, Err(_) => return Ok(None) } };
    let file = match safe_existing(&base, asset) { Ok(p) => p, Err(e) if e == "resource_missing" => return Ok(None), Err(e) => return Err(e) };
    let info = fs::metadata(&file).map_err(|_| "io_failed")?;
    if !info.is_file() || info.len() > MAX_IMAGE { return Err("quota_exceeded".into()); }
    Ok(Some(fs::read(file).map_err(|_| "io_failed")?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteRequest {
    operation_id: String,
    path: String,
    /// None creates a new file without overwriting; otherwise the file must hold this revision.
    expected: Option<String>,
    bytes: Vec<u8>,
    #[serde(default)] assets: Vec<Asset>,
    /// Per-document instances to merge into the directory's images.json.
    #[serde(default)] instances: Vec<Value>,
}

/// Writes a remote document version through the journaled save. Missing parent directories
/// inside the workspace are created; nothing outside it and nothing under `.easym` is touched.
pub(crate) fn write(root: &Path, request: WriteRequest) -> Result<Option<String>, String> {
    let (directory, name) = split(&request.path);
    crate::workspace_ops::portable_name(name)?;
    for part in directory.split('/').filter(|p| !p.is_empty()) { if part.starts_with('.') { return Err("invalid_name".into()); } }
    if request.bytes.len() > MAX_TEXT || request.assets.iter().map(|a| a.bytes.len()).sum::<usize>() > MAX_ASSETS { return Err("quota_exceeded".into()); }
    let parent = if directory.is_empty() { root.to_path_buf() } else { crate::resources::directory(root, directory)? };
    let target = parent.join(name);
    if request.expected.is_some() { checked_document(&safe_existing(root, &request.path)?)?; }
    transaction::save(&target, request.expected.as_deref(), &request.bytes, &request.assets, Metadata { schema_version: 1, instances: request.instances }, &request.operation_id)
}

#[tauri::command]
pub async fn sync_local_revisions(workspaces: State<'_, Workspaces>, storage: State<'_, Storage>, id: String) -> Result<LocalScan, String> {
    let workspaces = workspaces.inner().clone(); let storage = storage.inner().clone();
    tauri::async_runtime::spawn_blocking(move || { let _queue = storage.0.lock().map_err(|_| "io_failed")?; revisions(&root(&workspaces, &id)?) }).await.map_err(|_| "io_failed".to_string())?
}
#[tauri::command]
pub async fn sync_local_read(workspaces: State<'_, Workspaces>, storage: State<'_, Storage>, id: String, path: String) -> Result<LocalDocument, String> {
    let workspaces = workspaces.inner().clone(); let storage = storage.inner().clone();
    tauri::async_runtime::spawn_blocking(move || { let _queue = storage.0.lock().map_err(|_| "io_failed")?; read_document(&root(&workspaces, &id)?, &path) }).await.map_err(|_| "io_failed".to_string())?
}
#[tauri::command]
pub async fn sync_local_asset(workspaces: State<'_, Workspaces>, storage: State<'_, Storage>, id: String, directory: String, asset: String) -> Result<Option<Vec<u8>>, String> {
    let workspaces = workspaces.inner().clone(); let storage = storage.inner().clone();
    tauri::async_runtime::spawn_blocking(move || { let _queue = storage.0.lock().map_err(|_| "io_failed")?; read_asset(&root(&workspaces, &id)?, &directory, &asset) }).await.map_err(|_| "io_failed".to_string())?
}
/// Holds the write queue, so a save from the editor cannot interleave. Open documents are only
/// written when the engine saw no unsaved edits; an edit started afterwards is caught by the
/// editor's revision check on save (the file changed externally), never silently overwritten.
#[tauri::command]
pub async fn sync_local_write(workspaces: State<'_, Workspaces>, storage: State<'_, Storage>, id: String, request: WriteRequest) -> Result<Option<String>, String> {
    let workspaces = workspaces.inner().clone(); let storage = storage.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _queue = storage.0.lock().map_err(|_| "io_failed")?;
        write(&root(&workspaces, &id)?, request)
    }).await.map_err(|_| "io_failed".to_string())?
}

/// Applies a remote rename/move: target directories are created inside the workspace, the file
/// must still be at `expected`, and step 2's journaled move carries history, images and identity.
/// Link rewrites are not applied: the remote body already contains the remote's links.
pub(crate) fn move_document(root: &Path, operation: &str, from: &str, to: &str, expected: &str, references: Vec<String>) -> Result<(), String> {
    let source = safe_existing(root, from)?;
    checked_document(&source)?;
    if transaction::hash(&read_text(&source)?) != expected { return Err("revision_conflict".into()); }
    let directory = split(to).0;
    for part in directory.split('/').filter(|p| !p.is_empty()) { if part.starts_with('.') { return Err("invalid_name".into()); } }
    if !directory.is_empty() { crate::resources::directory(root, directory)?; }
    crate::workspace_ops::rename_or_move(root, operation, from, to, vec![], crate::workspace_ops::MoveResources::new(references)).map(|_| ())
}

#[tauri::command]
/// Open, saved documents may move: their sessions follow the file and the ids are returned so the
/// tabs reload in place. The engine never moves documents with unsaved edits (they become copies).
pub async fn sync_local_move(workspaces: State<'_, Workspaces>, storage: State<'_, Storage>, id: String, operation_id: String, from: String, to: String, expected: String, references: Vec<String>) -> Result<Vec<String>, String> {
    let workspaces = workspaces.inner().clone(); let storage = storage.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut sessions = storage.0.lock().map_err(|_| "io_failed")?;
        let boundary = root(&workspaces, &id)?;
        let old = safe_existing(&boundary, &from)?;
        move_document(&boundary, &operation_id, &from, &to, &expected, references)?;
        let new = safe_existing(&boundary, &to)?;
        Ok(sessions.iter_mut().filter(|(_, p)| **p == old).map(|(session, path)| { *path = new.clone(); session.clone() }).collect())
    }).await.map_err(|_| "io_failed".to_string())?
}

#[derive(Serialize)]
pub struct OpenDocument { path: String, session: String }

/// Documents of this workspace open in any tab (however they were opened), as relative paths
/// with their session ids, so the engine can treat them as open and the shell can map them to
/// tabs with unsaved edits.
pub(crate) fn open_documents(root: &Path, sessions: &std::collections::HashMap<String, std::path::PathBuf>) -> Vec<OpenDocument> {
    let mut out: Vec<OpenDocument> = sessions.iter().filter_map(|(session, path)| {
        let relative = path.strip_prefix(root).ok()?;
        let parts: Option<Vec<&str>> = relative.components().map(|c| match c { std::path::Component::Normal(p) => p.to_str(), _ => None }).collect();
        Some(OpenDocument { path: parts?.join("/"), session: session.clone() })
    }).collect();
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

#[tauri::command]
pub async fn sync_local_open(workspaces: State<'_, Workspaces>, storage: State<'_, Storage>, id: String) -> Result<Vec<OpenDocument>, String> {
    let sessions = storage.0.lock().map_err(|_| "io_failed")?;
    Ok(open_documents(&root(&workspaces, &id)?, &sessions))
}

/// Applies a remote deletion through the in-app trash (restorable), only at `expected`.
#[tauri::command]
pub async fn sync_local_trash(workspaces: State<'_, Workspaces>, storage: State<'_, Storage>, id: String, operation_id: String, path: String, expected: String) -> Result<(), String> {
    let workspaces = workspaces.inner().clone(); let storage = storage.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let sessions = storage.0.lock().map_err(|_| "io_failed")?;
        let boundary = root(&workspaces, &id)?;
        if sessions.values().any(|p| safe_existing(&boundary, &path).is_ok_and(|q| q == *p)) { return Err("document_open".into()); }
        crate::workspace_ops::trash(&boundary, &operation_id, &path, &expected).map(|_| ())
    }).await.map_err(|_| "io_failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn png() -> Vec<u8> { include_bytes!("../icons/32x32.png").to_vec() }
    fn workspace() -> (tempfile::TempDir, std::path::PathBuf) { let t = tempfile::tempdir().unwrap(); let r = t.path().canonicalize().unwrap(); (t, r) }
    fn op() -> String { uuid::Uuid::new_v4().to_string() }

    #[test]
    fn revisions_cover_every_document_and_reads_are_bounded() {
        let (_t, root) = workspace();
        fs::create_dir_all(root.join("notes/assets")).unwrap();
        fs::write(root.join("a.md"), "A").unwrap(); fs::write(root.join("notes/b.md"), "\u{feff}B\r\n").unwrap();
        fs::write(root.join("notes/assets/img-a-v1.png"), png()).unwrap();
        let list = revisions(&root).unwrap().documents;
        assert_eq!(list.iter().map(|r| r.path.as_str()).collect::<Vec<_>>(), vec!["a.md", "notes/b.md"]);
        assert_eq!(list[1].revision, transaction::hash("\u{feff}B\r\n".as_bytes()));
        assert_eq!(read_document(&root, "notes/b.md").unwrap().bytes, "\u{feff}B\r\n".as_bytes());
        assert_eq!(read_asset(&root, "notes", "assets/img-a-v1.png").unwrap().unwrap(), png());
        assert!(read_asset(&root, "notes", "assets/img-none-v1.png").unwrap().is_none());
        assert!(read_asset(&root, "notes", "../a.md").is_err());
        assert!(read_asset(&root, "", "assets/other.png").is_err());
    }

    #[test]
    fn writes_create_without_overwriting_and_update_only_the_expected_revision() {
        let (_t, root) = workspace();
        let assets = vec![Asset { path: "assets/img-a-v1.png".into(), bytes: png() }];
        let instance = serde_json::json!({"instanceId":"img-a","documentId":null,"sourcePath":"assets/img-a-v1.png","sourceHash":"sha256:x","displayPath":"assets/img-a-v1.png","recipe":{"version":1},"referenceRevision":1});
        write(&root, WriteRequest { operation_id: op(), path: "new/dir/a.md".into(), expected: None, bytes: b"![a](assets/img-a-v1.png)".to_vec(), assets: assets.clone(), instances: vec![instance] }).unwrap();
        assert_eq!(fs::read(root.join("new/dir/a.md")).unwrap(), b"![a](assets/img-a-v1.png)");
        assert_eq!(fs::read(root.join("new/dir/assets/img-a-v1.png")).unwrap(), png());
        assert!(fs::read_to_string(root.join("new/dir/.easym/images.json")).unwrap().contains("img-a"));
        // Creating over an existing file never overwrites it.
        assert!(write(&root, WriteRequest { operation_id: op(), path: "new/dir/a.md".into(), expected: None, bytes: b"other".to_vec(), assets: vec![], instances: vec![] }).is_err());
        assert_eq!(fs::read(root.join("new/dir/a.md")).unwrap(), b"![a](assets/img-a-v1.png)");
        let revision = transaction::hash(b"![a](assets/img-a-v1.png)");
        assert_eq!(write(&root, WriteRequest { operation_id: op(), path: "new/dir/a.md".into(), expected: Some("sha256:stale".into()), bytes: b"x".to_vec(), assets: vec![], instances: vec![] }).unwrap_err(), "revision_conflict");
        write(&root, WriteRequest { operation_id: op(), path: "new/dir/a.md".into(), expected: Some(revision), bytes: b"updated".to_vec(), assets: vec![], instances: vec![] }).unwrap();
        assert_eq!(fs::read(root.join("new/dir/a.md")).unwrap(), b"updated");
        // A differing image at an existing managed path is never replaced.
        let other = vec![Asset { path: "assets/img-a-v1.png".into(), bytes: include_bytes!("../icons/128x128.png").to_vec() }];
        assert!(write(&root, WriteRequest { operation_id: op(), path: "new/dir/b.md".into(), expected: None, bytes: b"b".to_vec(), assets: other, instances: vec![] }).is_err());
        assert_eq!(fs::read(root.join("new/dir/assets/img-a-v1.png")).unwrap(), png());
    }

    #[test]
    fn writes_refuse_hidden_unportable_and_outside_paths() {
        let (_t, root) = workspace();
        for path in [".easym/a.md", "x/.hidden/a.md", "../a.md", "con.md", "a.txt", "a/b?.md"] {
            assert!(write(&root, WriteRequest { operation_id: op(), path: path.into(), expected: None, bytes: b"x".to_vec(), assets: vec![], instances: vec![] }).is_err(), "{path}");
        }
        assert!(fs::read_dir(&root).unwrap().next().is_none() || !root.join(".easym/a.md").exists());
    }

    #[test]
    fn open_documents_lists_only_sessions_inside_the_workspace() {
        let (_t, root) = workspace();
        let outside = tempfile::tempdir().unwrap();
        let sessions = std::collections::HashMap::from([
            ("s1".to_string(), root.join("notes").join("中文.md")),
            ("s2".to_string(), root.join("a.md")),
            ("s3".to_string(), outside.path().join("x.md")),
        ]);
        let open = open_documents(&root, &sessions);
        assert_eq!(open.iter().map(|o| (o.path.as_str(), o.session.as_str())).collect::<Vec<_>>(), vec![("a.md", "s2"), ("notes/中文.md", "s1")]);
    }

    #[test]
    fn remote_moves_create_directories_and_check_the_revision() {
        let (_t, root) = workspace();
        fs::write(root.join("a.md"), "A").unwrap();
        assert_eq!(move_document(&root, &op(), "a.md", "new/deep/a.md", "sha256:stale", vec![]).unwrap_err(), "revision_conflict");
        assert!(!root.join("new").exists());
        move_document(&root, &op(), "a.md", "new/deep/a.md", &transaction::hash(b"A"), vec![]).unwrap();
        assert_eq!(fs::read(root.join("new/deep/a.md")).unwrap(), b"A");
        assert!(!root.join("a.md").exists());
        assert!(move_document(&root, &op(), "new/deep/a.md", ".hidden/a.md", &transaction::hash(b"A"), vec![]).is_err());
    }
}
