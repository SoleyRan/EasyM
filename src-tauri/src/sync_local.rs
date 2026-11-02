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
    let mut checked = std::collections::HashMap::new();
    for (path, history_id, history_unreadable) in scan.entries() {
        let file = scanned_file(root, &mut checked, &path)?;
        let bytes = read_text(&file)?;
        documents.push(Revision { revision: transaction::hash(&bytes), bytes: bytes.len() as u64, path, history_id, history_unreadable });
    }
    Ok(LocalScan { identity: scan.identity_bytes(), documents })
}

/// Step 5B: `safe_existing` + `checked_document` per file canonicalized every path component of
/// every document (seconds for 2,000 files on Windows). Each directory is now checked once per
/// scan, and each file with one metadata call: a regular file, not a symlink or reparse point,
/// inside a checked directory — the same guarantee as before.
fn scanned_file(root: &Path, checked: &mut std::collections::HashMap<String, std::path::PathBuf>, path: &str) -> Result<std::path::PathBuf, String> {
    let (directory, name) = split(path);
    if name.is_empty() || name == "." || name == ".." || name.contains('\\') { return Err("invalid_data".into()); }
    let parent = match checked.get(directory) {
        Some(parent) => parent.clone(),
        None => {
            let parent = if directory.is_empty() { root.to_path_buf() } else { safe_existing(root, directory)? };
            checked_document(&parent)?;
            checked.insert(directory.to_string(), parent.clone());
            parent
        }
    };
    let file = parent.join(name);
    let info = fs::symlink_metadata(&file).map_err(|_| "resource_missing")?;
    if info.file_type().is_symlink() || !info.is_file() { return Err("permission_denied".into()); }
    #[cfg(windows)]
    { use std::os::windows::fs::MetadataExt; if info.file_attributes() & 0x400 != 0 { return Err("permission_denied".into()); } }
    Ok(file)
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveRequest {
    /// The document that kept its place, and its revision when the user chose.
    path: String, expected: String,
    /// The conflict copy, and its revision when the user chose.
    copy: String, copy_expected: String,
    /// New body for `path`; None keeps the current body (the copy is simply discarded).
    bytes: Option<Vec<u8>>,
    /// Name under which the replaced body is restorable from the trash.
    snapshot_path: String,
    save_operation: String, snapshot_operation: String, copy_operation: String,
}

/// v2 step 4B: resolves a sync conflict. Both earlier versions stay restorable from the in-app
/// trash: the replaced body as `snapshot_path` (written before the save), the copy as itself.
/// Images are not moved: the copy lives in the same directory, so anything it references is
/// already there. Fails without changes when either file changed since the user chose.
pub(crate) fn resolve(root: &Path, request: ResolveRequest) -> Result<String, String> {
    if split(&request.path).0 != split(&request.copy).0 || split(&request.path).0 != split(&request.snapshot_path).0 { return Err("invalid_data".into()); }
    let original = safe_existing(root, &request.path)?; checked_document(&original)?;
    let copy = safe_existing(root, &request.copy)?; checked_document(&copy)?;
    if original == copy { return Err("invalid_data".into()); }
    let current = read_text(&original)?;
    if transaction::hash(&current) != request.expected || transaction::hash(&read_text(&copy)?) != request.copy_expected { return Err("revision_conflict".into()); }
    let mut revision = request.expected.clone();
    if let Some(bytes) = request.bytes.filter(|b| *b != current) {
        if bytes.len() > MAX_TEXT { return Err("quota_exceeded".into()); }
        if std::str::from_utf8(&bytes).map_err(|_| "invalid_data")?.contains('\0') { return Err("invalid_data".into()); }
        if exists_exact(root, &request.snapshot_path)? { return Err("target_exists".into()); }
        crate::workspace_ops::trash_snapshot(root, &request.snapshot_operation, &request.snapshot_path, &current)?;
        transaction::save(&original, Some(&request.expected), &bytes, &[], Metadata { schema_version: 1, instances: vec![] }, &request.save_operation)?;
        revision = transaction::hash(&bytes);
    }
    crate::workspace_ops::trash(root, &request.copy_operation, &request.copy, &request.copy_expected)?;
    Ok(revision)
}
fn exists_exact(root: &Path, relative: &str) -> Result<bool, String> {
    match safe_existing(root, relative) { Ok(_) => Ok(true), Err(e) if e == "resource_missing" => Ok(false), Err(e) => Err(e) }
}

/// Refuses while the copy is open in a tab, because the copy is trashed (same rule as delete).
/// The kept document may be open: the frontend refuses when its tab has unsaved edits and reloads
/// it afterwards, and the revision check catches a write that raced the user's choice.
#[tauri::command]
pub async fn sync_local_resolve(workspaces: State<'_, Workspaces>, storage: State<'_, Storage>, id: String, request: ResolveRequest) -> Result<String, String> {
    let workspaces = workspaces.inner().clone(); let storage = storage.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let sessions = storage.0.lock().map_err(|_| "io_failed")?;
        let boundary = root(&workspaces, &id)?;
        if sessions.values().any(|p| safe_existing(&boundary, &request.copy).is_ok_and(|q| q == *p)) { return Err("document_open".into()); }
        resolve(&boundary, request)
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

    fn resolve_request(expected: &str, copy_expected: &str, bytes: Option<&[u8]>) -> ResolveRequest {
        ResolveRequest { path: "notes/a.md".into(), expected: expected.into(), copy: "notes/a (冲突 0123abcd).md".into(), copy_expected: copy_expected.into(), bytes: bytes.map(<[u8]>::to_vec), snapshot_path: "notes/a (解决前).md".into(), save_operation: op(), snapshot_operation: op(), copy_operation: op() }
    }
    fn trash_bodies(root: &Path) -> Vec<(String, Vec<u8>)> {
        let mut items: Vec<_> = crate::workspace_ops::trash_list(root).unwrap().into_iter().map(|item| {
            let folder = root.join(".easym/trash").join(item["operationId"].as_str().unwrap());
            (item["path"].as_str().unwrap().to_string(), fs::read(folder.join("document.md")).unwrap())
        }).collect();
        items.sort(); items
    }

    #[test]
    fn resolving_writes_the_result_and_keeps_both_earlier_versions_in_the_trash() {
        let (_t, root) = workspace();
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(root.join("notes/a.md"), "mine").unwrap(); fs::write(root.join("notes/a (冲突 0123abcd).md"), "theirs").unwrap();
        let (mine, theirs) = (transaction::hash(b"mine"), transaction::hash(b"theirs"));
        // A stale revision on either side changes nothing.
        assert_eq!(resolve(&root, resolve_request("sha256:stale", &theirs, Some(b"merged"))).unwrap_err(), "revision_conflict");
        assert_eq!(resolve(&root, resolve_request(&mine, "sha256:stale", Some(b"merged"))).unwrap_err(), "revision_conflict");
        assert_eq!(fs::read(root.join("notes/a.md")).unwrap(), b"mine");
        assert!(trash_bodies(&root).is_empty());
        assert_eq!(resolve(&root, resolve_request(&mine, &theirs, Some(b"merged"))).unwrap(), transaction::hash(b"merged"));
        assert_eq!(fs::read(root.join("notes/a.md")).unwrap(), b"merged");
        assert!(!root.join("notes/a (冲突 0123abcd).md").exists());
        assert_eq!(trash_bodies(&root), vec![("notes/a (冲突 0123abcd).md".to_string(), b"theirs".to_vec()), ("notes/a (解决前).md".to_string(), b"mine".to_vec())]);
        // Restoring the snapshot gives an independent document beside the resolved one.
        let snapshot = crate::workspace_ops::trash_list(&root).unwrap().into_iter().find(|i| i["path"] == "notes/a (解决前).md").unwrap();
        assert!(snapshot["documentId"].is_null());
        crate::workspace_ops::restore(&root, snapshot["operationId"].as_str().unwrap()).unwrap();
        assert_eq!(fs::read(root.join("notes/a (解决前).md")).unwrap(), b"mine");
    }

    #[test]
    fn keeping_this_document_only_trashes_the_copy() {
        let (_t, root) = workspace();
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(root.join("notes/a.md"), "mine").unwrap(); fs::write(root.join("notes/a (冲突 0123abcd).md"), "theirs").unwrap();
        let (mine, theirs) = (transaction::hash(b"mine"), transaction::hash(b"theirs"));
        // Unchanged bytes count as "keep": no snapshot, the body is not rewritten.
        assert_eq!(resolve(&root, resolve_request(&mine, &theirs, Some(b"mine"))).unwrap(), mine);
        assert_eq!(fs::read(root.join("notes/a.md")).unwrap(), b"mine");
        assert_eq!(trash_bodies(&root), vec![("notes/a (冲突 0123abcd).md".to_string(), b"theirs".to_vec())]);
    }

    #[test]
    fn resolving_refuses_other_directories_an_existing_snapshot_name_and_invalid_bodies() {
        let (_t, root) = workspace();
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(root.join("notes/a.md"), "mine").unwrap(); fs::write(root.join("notes/a (冲突 0123abcd).md"), "theirs").unwrap();
        let (mine, theirs) = (transaction::hash(b"mine"), transaction::hash(b"theirs"));
        let mut elsewhere = resolve_request(&mine, &theirs, Some(b"x")); elsewhere.snapshot_path = "a (解决前).md".into();
        assert_eq!(resolve(&root, elsewhere).unwrap_err(), "invalid_data");
        let mut same = resolve_request(&mine, &mine, Some(b"x")); same.copy = "notes/a.md".into();
        assert_eq!(resolve(&root, same).unwrap_err(), "invalid_data");
        assert_eq!(resolve(&root, resolve_request(&mine, &theirs, Some(&[0xff, 0xfe]))).unwrap_err(), "invalid_data");
        fs::write(root.join("notes/a (解决前).md"), "older").unwrap();
        assert_eq!(resolve(&root, resolve_request(&mine, &theirs, Some(b"merged"))).unwrap_err(), "target_exists");
        assert_eq!(fs::read(root.join("notes/a.md")).unwrap(), b"mine");
        assert!(root.join("notes/a (冲突 0123abcd).md").exists());
        assert!(trash_bodies(&root).is_empty());
    }

    #[test]
    fn scanned_files_keep_the_path_checks_with_one_check_per_directory() {
        let (_t, root) = workspace();
        fs::create_dir_all(root.join("notes/sub")).unwrap();
        fs::write(root.join("notes/a.md"), "A").unwrap(); fs::write(root.join("notes/b.md"), "B").unwrap();
        let mut checked = std::collections::HashMap::new();
        assert_eq!(scanned_file(&root, &mut checked, "notes/a.md").unwrap(), root.join("notes/a.md"));
        assert_eq!(scanned_file(&root, &mut checked, "notes/b.md").unwrap(), root.join("notes/b.md"));
        assert_eq!(checked.len(), 1, "the directory is checked once");
        for path in ["notes/..", "notes/.", "notes/", "notes/x\\y.md", "../a.md"] { assert!(scanned_file(&root, &mut checked, path).is_err(), "{path}"); }
        assert!(scanned_file(&root, &mut checked, "notes/sub").is_err(), "a directory is not a document");
        assert_eq!(scanned_file(&root, &mut checked, "notes/missing.md").unwrap_err(), "resource_missing");
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            fs::write(outside.path().join("secret.md"), "S").unwrap();
            std::os::unix::fs::symlink(outside.path().join("secret.md"), root.join("notes/link.md")).unwrap();
            assert_eq!(scanned_file(&root, &mut checked, "notes/link.md").unwrap_err(), "permission_denied");
            std::os::unix::fs::symlink(outside.path(), root.join("linked")).unwrap();
            assert!(scanned_file(&root, &mut std::collections::HashMap::new(), "linked/secret.md").is_err());
        }
    }

    /// Step 5B measurement (run with --ignored --nocapture): native scan cost of a large workspace.
    #[test]
    #[ignore]
    fn measure_scan_of_a_large_workspace() {
        let (_t, root) = workspace();
        let body = format!("# 文档\n\n{}\n", "正文内容 ".repeat(80));
        for i in 0..2000 {
            let dir = root.join(format!("目录-{:02}", i % 20));
            if i < 20 { fs::create_dir_all(&dir).unwrap(); }
            fs::write(dir.join(format!("文档-{i:05}.md")), &body).unwrap();
        }
        // Identity file listing every document, as an enabled sync workspace has.
        let documents: Vec<_> = (0..2000).map(|i| serde_json::json!({"documentId": uuid::Uuid::new_v4().to_string(), "path": format!("目录-{:02}/文档-{i:05}.md", i % 20)})).collect();
        fs::create_dir_all(root.join(".easym/sync")).unwrap();
        fs::write(root.join(".easym/sync/workspace.json"), serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"workspaceId":uuid::Uuid::new_v4().to_string(),"documents":documents})).unwrap()).unwrap();
        let _ = revisions(&root).unwrap();
        let mut times = vec![];
        for _ in 0..5 { let start = std::time::Instant::now(); let scan = revisions(&root).unwrap(); times.push(start.elapsed().as_millis()); assert_eq!(scan.documents.len(), 2000); }
        times.sort();
        println!("native scan of 2000 documents: median {} ms, min {} ms, max {} ms", times[2], times[0], times[4]);
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
