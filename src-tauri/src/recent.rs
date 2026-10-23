use std::{collections::HashSet, fs, io::{Read, Write}, path::{Path, PathBuf}, sync::{Arc, Mutex}};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use crate::{storage::{Storage, OpenedFile}, workspace::{Workspaces, Workspace}};

const LIMIT: u64 = 1024 * 1024;
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Record { id: String, kind: String, path: PathBuf, boundary: Option<PathBuf> }
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Session { pub tabs: Vec<SessionTab>, pub active_draft_key: Option<String>, pub workspace_id: Option<String> }
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SessionTab { pub draft_key: String, pub recent_id: Option<String> }
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Data { version: u32, records: Vec<Record>, session: Session }
impl Default for Data { fn default() -> Self { Self { version: 1, records: vec![], session: Session::default() } } }
#[derive(Serialize)]
pub struct Entry { id: String, kind: String, name: String, location: String }
#[derive(Serialize)]
pub struct Snapshot { entries: Vec<Entry>, session: Session }
#[derive(Clone)]
pub struct Recents { path: PathBuf, lock: Arc<Mutex<()>> }

fn key(value: &str) -> bool { value == "current" || (value.starts_with("document:") && value.len() <= 256 && value.len() > 9 && !value.chars().any(|c| c.is_control() || c.is_whitespace())) }
fn validate_session(session: &Session) -> Result<(), String> {
    let mut keys = HashSet::new();
    if session.tabs.len() > 100 || session.tabs.iter().any(|tab| !key(&tab.draft_key) || !keys.insert(&tab.draft_key) || tab.recent_id.as_ref().is_some_and(|id| uuid::Uuid::parse_str(id).is_err())) || session.active_draft_key.as_ref().is_some_and(|id| !keys.contains(id)) || session.workspace_id.as_ref().is_some_and(|id| uuid::Uuid::parse_str(id).is_err()) { return Err("recent_invalid_session".into()); }
    Ok(())
}

impl Recents {
    pub fn new(path: PathBuf) -> Self { Self { path, lock: Arc::new(Mutex::new(())) } }
    fn read(&self) -> Result<Data, String> {
        let info = match fs::symlink_metadata(&self.path) { Ok(info) => info, Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Data::default()), Err(_) => return Err("recent_read_failed".into()) };
        if !info.is_file() || info.file_type().is_symlink() || info.len() > LIMIT { return Err("recent_invalid_record".into()); }
        let mut bytes = vec![];
        fs::File::open(&self.path).map_err(|_| "recent_read_failed")?.take(LIMIT + 1).read_to_end(&mut bytes).map_err(|_| "recent_read_failed")?;
        if bytes.len() > LIMIT as usize { return Err("recent_invalid_record".into()); }
        let data: Data = serde_json::from_slice(&bytes).map_err(|_| "recent_invalid_record")?;
        let mut ids = HashSet::new(); let mut paths = HashSet::new();
        if data.version != 1 || data.records.iter().filter(|r| r.kind == "file").count() > 30 || data.records.iter().filter(|r| r.kind == "workspace").count() > 10 || data.records.iter().any(|r| uuid::Uuid::parse_str(&r.id).is_err() || !ids.insert(&r.id) || !paths.insert((&r.kind, &r.path)) || !matches!(r.kind.as_str(), "file" | "workspace") || !r.path.is_absolute() || r.boundary.as_ref().is_some_and(|b| !b.is_absolute() || !r.path.starts_with(b))) { return Err("recent_invalid_record".into()); }
        validate_session(&data.session)?;
        Ok(data)
    }
    fn write(&self, data: &Data) -> Result<(), String> {
        let parent = self.path.parent().ok_or("recent_write_failed")?;
        fs::create_dir_all(parent).map_err(|_| "recent_write_failed")?;
        let bytes = serde_json::to_vec(data).map_err(|_| "recent_write_failed")?;
        if bytes.len() > LIMIT as usize { return Err("recent_write_failed".into()); }
        let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|_| "recent_write_failed")?;
        temp.write_all(&bytes).map_err(|_| "recent_write_failed")?;
        temp.as_file().sync_all().map_err(|_| "recent_write_failed")?;
        temp.persist(&self.path).map_err(|_| "recent_write_failed")?;
        Ok(())
    }
    pub fn remember(&self, path: &Path, kind: &str, boundary: Option<&Path>) -> Result<String, String> {
        let _guard = self.lock.lock().map_err(|_| "recent_write_failed")?;
        let mut data = self.read()?;
        let previous = data.records.iter().position(|r| r.path == path && r.kind == kind).map(|i| data.records.remove(i));
        let id = previous.as_ref().map(|r| r.id.clone()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let boundary = boundary.map(Path::to_path_buf).or_else(|| previous.and_then(|r| r.boundary));
        data.records.insert(0, Record { id: id.clone(), kind: kind.into(), path: path.to_path_buf(), boundary });
        let mut files = 0; let mut workspaces = 0;
        data.records.retain(|r| { let count = if r.kind == "file" { files += 1; files } else { workspaces += 1; workspaces }; count <= if r.kind == "file" { 30 } else { 10 } });
        self.write(&data)?; Ok(id)
    }
    /// Points file records at a renamed path; records of other kinds and other paths are kept.
    pub fn relocate(&self, from: &Path, to: &Path) -> Result<(), String> {
        let _guard = self.lock.lock().map_err(|_| "recent_write_failed")?;
        let mut data = self.read()?;
        if data.records.iter().any(|r| r.kind == "file" && r.path == to) { data.records.retain(|r| !(r.kind == "file" && r.path == from)); }
        else { for record in data.records.iter_mut().filter(|r| r.kind == "file" && r.path == from) { record.path = to.to_path_buf(); } }
        self.write(&data)
    }
    pub fn snapshot(&self) -> Result<Snapshot, String> {
        let _guard = self.lock.lock().map_err(|_| "recent_read_failed")?;
        let data = self.read()?;
        Ok(Snapshot { entries: data.records.into_iter().map(|r| Entry { name: r.path.file_name().unwrap_or_default().to_string_lossy().into(), location: r.path.to_string_lossy().into(), id: r.id, kind: r.kind }).collect(), session: data.session })
    }
    fn record(&self, id: &str) -> Result<Record, String> {
        let _guard = self.lock.lock().map_err(|_| "recent_read_failed")?;
        self.read()?.records.into_iter().find(|r| r.id == id).ok_or_else(|| "recent_missing".into())
    }
    fn open_file(&self, storage: &Storage, id: &str) -> Result<OpenedFile, String> {
        let record = self.record(id)?;
        if record.kind != "file" { return Err("invalid_data".into()); }
        let path = checked_path(&record)?;
        let mut file = crate::storage::open_path(storage, path.clone())?;
        file.recent_id = register(self, &path, "file", record.boundary.as_deref(), &mut file.warning);
        Ok(file)
    }
    fn forget(&self, id: Option<&str>) -> Result<(), String> {
        let _guard = self.lock.lock().map_err(|_| "recent_write_failed")?;
        let mut data = self.read()?;
        data.records.retain(|r| id.is_some_and(|id| r.id != id));
        let ids: HashSet<_> = data.records.iter().map(|r| r.id.as_str()).collect();
        for tab in &mut data.session.tabs { if tab.recent_id.as_ref().is_some_and(|id| !ids.contains(id.as_str())) { tab.recent_id = None; } }
        if data.session.workspace_id.as_ref().is_some_and(|id| !ids.contains(id.as_str())) { data.session.workspace_id = None; }
        self.write(&data)
    }
    fn session(&self, session: Session) -> Result<(), String> {
        validate_session(&session)?;
        let _guard = self.lock.lock().map_err(|_| "recent_write_failed")?;
        let mut data = self.read()?;
        let mut session = session;
        for tab in &mut session.tabs { if tab.recent_id.as_ref().is_some_and(|id| !data.records.iter().any(|r| r.id == *id && r.kind == "file")) { tab.recent_id = None; } }
        if session.workspace_id.as_ref().is_some_and(|id| !data.records.iter().any(|r| r.id == *id && r.kind == "workspace")) { session.workspace_id = None; }
        data.session = session; self.write(&data)
    }
}

// A persisted path is rechecked at every reopen. Never follow a replaced file,
// parent symlink or junction to a new location, including within workspaces.
fn checked_path(record: &Record) -> Result<PathBuf, String> {
    let mut current = PathBuf::new();
    for component in record.path.components() {
        current.push(component);
        if !matches!(component, std::path::Component::Normal(_)) { continue; }
        let info = fs::symlink_metadata(&current).map_err(|_| "resource_missing")?;
        if info.file_type().is_symlink() { return Err("permission_denied".into()); }
        let canonical = current.canonicalize().map_err(|_| "permission_denied")?;
        if canonical != current { return Err("permission_denied".into()); }
    }
    if record.boundary.as_ref().is_some_and(|root| !record.path.starts_with(root)) { return Err("permission_denied".into()); }
    let info = fs::metadata(&record.path).map_err(|_| "resource_missing")?;
    if (record.kind == "workspace" && !info.is_dir()) || (record.kind == "file" && !info.is_file()) { return Err("invalid_data".into()); }
    if record.kind == "file" && info.len() > 10 * 1024 * 1024 { return Err("quota_exceeded".into()); }
    if record.kind == "file" && !record.path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown")) { return Err("invalid_data".into()); }
    Ok(record.path.clone())
}

pub fn register(recents: &Recents, path: &Path, kind: &str, boundary: Option<&Path>, warning: &mut Option<String>) -> Option<String> {
    match recents.remember(path, kind, boundary) { Ok(id) => Some(id), Err(error) => { let message = format!("最近打开记录未保存（{error}），原记录与文档保留。"); *warning = Some(warning.take().map(|w| format!("{w}\n{message}")).unwrap_or(message)); None } }
}

#[tauri::command]
pub async fn recent_state(state: State<'_, Recents>) -> Result<Snapshot, String> {
    let recents = state.inner().clone(); tauri::async_runtime::spawn_blocking(move || recents.snapshot()).await.map_err(|_| "recent_read_failed".to_string())?
}
#[tauri::command]
pub async fn remember_session(state: State<'_, Recents>, session: Session) -> Result<(), String> {
    let recents = state.inner().clone(); tauri::async_runtime::spawn_blocking(move || recents.session(session)).await.map_err(|_| "recent_write_failed".to_string())?
}
#[tauri::command]
pub async fn forget_recent(state: State<'_, Recents>, id: Option<String>) -> Result<(), String> {
    let recents = state.inner().clone(); tauri::async_runtime::spawn_blocking(move || recents.forget(id.as_deref())).await.map_err(|_| "recent_write_failed".to_string())?
}
#[tauri::command]
pub async fn reopen_recent_file(state: State<'_, Recents>, storage: State<'_, Storage>, id: String) -> Result<OpenedFile, String> {
    let recents = state.inner().clone(); let storage = storage.inner().clone();
    tauri::async_runtime::spawn_blocking(move || recents.open_file(&storage, &id)).await.map_err(|_| "io_failed".to_string())?
}
#[tauri::command]
pub async fn reopen_recent_workspace(state: State<'_, Recents>, workspaces: State<'_, Workspaces>, id: String) -> Result<Workspace, String> {
    let recents = state.inner().clone(); let workspaces = workspaces.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let record = recents.record(&id)?;
        if record.kind != "workspace" { return Err("invalid_data".into()); }
        let path = checked_path(&record)?;
        let mut workspace = crate::workspace::open_path(&workspaces, path.clone())?;
        workspace.recent_id = register(&recents, &path, "workspace", None, &mut workspace.warning);
        Ok(workspace)
    }).await.map_err(|_| "io_failed".to_string())?
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let directory = app.path().app_data_dir()?;
    // WebView2 permits an explicit isolated profile. Keep its native session
    // registry in that same profile, so smoke tests cannot reopen or rewrite
    // the regular user's recent documents while testing a fresh WebView.
    #[cfg(windows)]
    let directory = profile_registry_directory(directory, std::env::var_os("WEBVIEW2_USER_DATA_FOLDER"))?;
    app.manage(Recents::new(directory.join("recent-v1.json"))); Ok(())
}

#[cfg(windows)]
pub(crate) fn profile_registry_directory(default: PathBuf, profile: Option<std::ffi::OsString>) -> Result<PathBuf, String> {
    match profile {
        None => Ok(default),
        Some(value) => {
            let profile = PathBuf::from(value);
            if !profile.is_absolute() { return Err("recent_profile_invalid".into()); }
            Ok(profile.join(".easym"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn registry(root: &Path) -> Recents { Recents::new(root.join("app/recent-v1.json")) }
    #[cfg(windows)]
    #[test]
    fn explicit_webview_profile_keeps_native_session_out_of_regular_registry() {
        let temp = tempfile::tempdir().unwrap();
        let default = temp.path().join("regular");
        assert_eq!(profile_registry_directory(default.clone(), None).unwrap(), default);
        assert!(profile_registry_directory(default.clone(), Some("relative/profile".into())).is_err());
        fs::create_dir(&default).unwrap();
        let regular = default.join("recent-v1.json");
        fs::write(&regular, b"keep existing user registry").unwrap();
        let profile = temp.path().join("isolated");
        let directory = profile_registry_directory(default, Some(profile.clone().into_os_string())).unwrap();
        assert_eq!(directory, profile.join(".easym"));
        let isolated = Recents::new(directory.join("recent-v1.json"));
        assert!(isolated.snapshot().unwrap().entries.is_empty());
        isolated.session(Session::default()).unwrap();
        assert!(isolated.path.is_file());
        assert_eq!(fs::read(regular).unwrap(), b"keep existing user registry");
    }
    #[test]
    fn persists_unicode_same_names_session_and_reopens_with_fresh_process_handles() {
        let temp = tempfile::tempdir().unwrap(); let root = temp.path().canonicalize().unwrap();
        fs::create_dir(root.join("中文")).unwrap(); fs::create_dir(root.join("other")).unwrap();
        let path = root.join("中文/同名.md"); let other = root.join("other/同名.md");
        let bytes = b"\xef\xbb\xbf# hello\r\n"; fs::write(&path, bytes).unwrap(); fs::write(&other, b"other").unwrap();
        let recents = registry(&root); let a = recents.remember(&path, "file", Some(&root)).unwrap(); let b = recents.remember(&other, "file", None).unwrap();
        assert_ne!(a, b); assert_eq!(recents.remember(&path, "file", None).unwrap(), a);
        recents.session(Session { tabs: vec![SessionTab { draft_key: "document:one".into(), recent_id: Some(a.clone()) }], active_draft_key: Some("document:one".into()), workspace_id: None }).unwrap();
        let before = serde_json::to_value(recents.open_file(&Storage::default(), &a).unwrap()).unwrap();
        let next = registry(&root); let storage = Storage::default();
        let opened = serde_json::to_value(next.open_file(&storage, &a).unwrap()).unwrap();
        assert_ne!(before["id"], opened["id"]); assert_eq!(opened["recentId"], a); assert_eq!(next.snapshot().unwrap().session.tabs.len(), 1);
        assert_eq!(serde_json::to_value(next.open_file(&storage, &a).unwrap()).unwrap()["id"], opened["id"]);
        assert_eq!(fs::read(&path).unwrap(), bytes); assert!(next.open_file(&storage, "D:/arbitrary.md").is_err());
        next.forget(Some(&a)).unwrap(); assert!(next.open_file(&storage, &a).is_err()); assert!(fs::read(&path).is_ok()); assert!(next.snapshot().unwrap().session.tabs[0].recent_id.is_none());
        next.forget(None).unwrap(); assert!(next.snapshot().unwrap().entries.is_empty()); assert_eq!(fs::read(other).unwrap(), b"other");
    }
    #[test]
    fn bounds_files_workspaces_and_rejects_invalid_sessions_without_replacing_records() {
        let temp = tempfile::tempdir().unwrap(); let recents = registry(temp.path());
        let first = recents.remember(&temp.path().join("first.md"), "file", None).unwrap();
        for i in 0..31 { recents.remember(&temp.path().join(format!("{i}.md")), "file", None).unwrap(); }
        for i in 0..11 { recents.remember(&temp.path().join(format!("ws{i}")), "workspace", None).unwrap(); }
        let state = recents.snapshot().unwrap(); assert_eq!(state.entries.len(), 40); assert!(!state.entries.iter().any(|e| e.id == first));
        let before = fs::read(&recents.path).unwrap();
        assert!(recents.session(Session { tabs: vec![SessionTab { draft_key: "../escape".into(), recent_id: None }], ..Session::default() }).is_err());
        assert!(recents.session(Session { tabs: (0..101).map(|i| SessionTab { draft_key: format!("document:{i}"), recent_id: None }).collect(), ..Session::default() }).is_err());
        assert_eq!(fs::read(&recents.path).unwrap(), before);
    }
    #[test]
    fn future_corrupt_and_oversize_records_are_never_rewritten() {
        let temp = tempfile::tempdir().unwrap(); let recents = registry(temp.path()); fs::create_dir_all(recents.path.parent().unwrap()).unwrap();
        for bytes in [br#"{"version":2,"records":[],"session":{"tabs":[],"activeDraftKey":null,"workspaceId":null}}"#.to_vec(), b"{broken".to_vec(), vec![b'x'; LIMIT as usize + 1]] {
            fs::write(&recents.path, &bytes).unwrap();
            assert!(recents.snapshot().is_err()); assert!(recents.remember(&temp.path().join("note.md"), "file", None).is_err()); assert!(recents.forget(None).is_err());
            assert_eq!(fs::read(&recents.path).unwrap(), bytes);
        }
        let blocked = temp.path().join("blocked"); fs::write(&blocked, b"keep").unwrap();
        assert!(Recents::new(blocked.join("recent.json")).remember(&temp.path().join("note.md"), "file", None).is_err()); assert_eq!(fs::read(blocked).unwrap(), b"keep");
    }
    #[test]
    fn missing_wrong_type_over_limit_and_forged_boundary_never_open() {
        let temp = tempfile::tempdir().unwrap(); let root = temp.path().canonicalize().unwrap(); let recents = registry(&root); let storage = Storage::default();
        let file = root.join("note.md"); fs::write(&file, "safe").unwrap(); let id = recents.remember(&file, "file", None).unwrap();
        fs::remove_file(&file).unwrap(); assert!(recents.open_file(&storage, &id).is_err()); fs::create_dir(&file).unwrap(); assert!(recents.open_file(&storage, &id).is_err()); fs::remove_dir(&file).unwrap();
        let huge = fs::File::create(&file).unwrap(); huge.set_len(10 * 1024 * 1024 + 1).unwrap(); drop(huge); assert!(recents.open_file(&storage, &id).is_err());
        assert!(storage.0.lock().unwrap().is_empty());
        let mut data = recents.read().unwrap(); data.records[0].boundary = Some(root.join("elsewhere")); fs::write(&recents.path, serde_json::to_vec(&data).unwrap()).unwrap(); assert!(recents.snapshot().is_err());
    }
    #[cfg(unix)]
    #[test]
    fn replaced_file_and_parent_links_cannot_escape_prior_authority() {
        let temp = tempfile::tempdir().unwrap(); let outside = tempfile::tempdir().unwrap(); let root = temp.path().canonicalize().unwrap();
        fs::create_dir(root.join("dir")).unwrap(); let file = root.join("dir/note.md"); fs::write(&file, "safe").unwrap(); fs::write(outside.path().join("note.md"), "private").unwrap();
        let recents = registry(&root); let id = recents.remember(&file, "file", Some(&root)).unwrap();
        fs::remove_file(&file).unwrap(); std::os::unix::fs::symlink(outside.path().join("note.md"), &file).unwrap(); assert!(recents.open_file(&Storage::default(), &id).is_err());
        fs::remove_file(&file).unwrap(); fs::remove_dir(root.join("dir")).unwrap(); std::os::unix::fs::symlink(outside.path(), root.join("dir")).unwrap(); assert!(recents.open_file(&Storage::default(), &id).is_err());
        assert_eq!(fs::read_to_string(outside.path().join("note.md")).unwrap(), "private");
    }
}
