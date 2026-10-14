use std::{collections::HashMap, fs, io::Read, path::{Path, PathBuf}, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}};
use serde::Serialize;
use tauri::State;
use sha2::{Digest, Sha256};
use crate::{resources::safe_existing, storage::{self, ImageFile, OpenedFile, Storage}};

#[derive(Clone, Default)]
pub struct Workspaces(Arc<Mutex<HashMap<String, PathBuf>>>, Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>);

#[derive(Serialize)]
pub struct Entry { path: String, name: String, kind: &'static str }

#[derive(Serialize)]
pub struct Workspace { id: String, name: String, entries: Vec<Entry> }

#[derive(Serialize)]
pub struct SearchResult { pub path: String, pub line: usize, pub preview: String, pub revision: String }
#[derive(Default, Serialize)]
pub struct SearchReport { pub results: Vec<SearchResult>, pub scanned: usize, pub skipped: usize, pub limited: bool, pub cancelled: bool }

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

#[derive(Default, Serialize)]
pub struct FilenameReport { pub paths: Vec<String>, pub scanned: usize, pub skipped: usize, pub limited: bool, pub cancelled: bool }

fn ignored_directory(name: &str) -> bool {
    name.starts_with('.') || matches!(name, "node_modules" | "target" | "dist" | "build" | "coverage" | "test-results")
}

// Filename-only discovery: count every directory entry, never read document bytes.
fn search_filenames(root: &Path, query: &str, cancelled: &AtomicBool) -> Result<FilenameReport, String> {
    if query.len() > 1024 || query.contains(['\n', '\r', '\0']) { return Err("invalid_data".into()); }
    let needles: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    let mut report = FilenameReport::default();
    let mut stack = vec![(String::new(), 0usize)];
    'scan: while let Some((relative, depth)) = stack.pop() {
        if cancelled.load(Ordering::Relaxed) { report.cancelled = true; break; }
        let directory = if relative.is_empty() { root.to_path_buf() } else { match safe_existing(root, &relative) { Ok(value) => value, Err(_) => { report.skipped += 1; continue; } } };
        let entries = match fs::read_dir(directory) { Ok(value) => value, Err(_) => { report.skipped += 1; continue; } };
        for item in entries {
            if cancelled.load(Ordering::Relaxed) { report.cancelled = true; break 'scan; }
            if report.scanned >= 10_000 { report.limited = true; break 'scan; }
            report.scanned += 1;
            let item = match item { Ok(item) => item, Err(_) => { report.skipped += 1; continue; } };
            let name = item.file_name().to_string_lossy().to_string();
            if name.starts_with('.') { continue; }
            let info = match item.file_type() { Ok(value) => value, Err(_) => { report.skipped += 1; continue; } };
            if info.is_symlink() { report.skipped += 1; continue; }
            let path = if relative.is_empty() { name.clone() } else { format!("{relative}/{name}") };
            if info.is_dir() && ignored_directory(&name) { continue; }
            if !info.is_dir() && (!info.is_file() || kind(&item.path()) != Some("document")) { continue; }
            if safe_existing(root, &path).is_err() { report.skipped += 1; continue; }
            if info.is_dir() {
                if depth >= 32 { report.limited = true; continue; }
                stack.push((path, depth + 1));
            } else if needles.iter().all(|needle| path.to_lowercase().contains(needle)) {
                if report.paths.len() >= 100 { report.limited = true; break 'scan; }
                report.paths.push(path);
            }
        }
    }
    report.paths.sort_by_key(|path| path.to_lowercase());
    Ok(report)
}

#[tauri::command]
pub async fn search_workspace_filenames(state: State<'_, Workspaces>, id: String, query: String, request_id: String) -> Result<FilenameReport, String> {
    let workspaces = state.inner().clone();
    let directory = root(&workspaces, &id)?;
    let cancel = Arc::new(AtomicBool::new(false));
    { let mut tasks = workspaces.1.lock().map_err(|_| "io_failed")?;
      if request_id.is_empty() || request_id.len() > 128 || tasks.contains_key(&request_id) || tasks.len() >= 8 { return Err("quota_exceeded".into()); }
      tasks.insert(request_id.clone(), cancel.clone()); }
    let result = tauri::async_runtime::spawn_blocking(move || search_filenames(&directory, &query, &cancel)).await.map_err(|_| "io_failed".to_string());
    workspaces.1.lock().map_err(|_| "io_failed")?.remove(&request_id);
    result?
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

fn search_directory(root: &Path, query: &str, cancelled: &AtomicBool) -> Result<SearchReport, String> {
    let mut report = SearchReport::default();
    if query.is_empty() { return Ok(report); }
    if query.len() > 4096 || query.contains(['\n', '\r', '\0']) { return Err("invalid_data".into()); }
    let needle = query.to_lowercase();
    let mut stack = vec![String::new()];
    let mut directories = 0usize;
    let mut total_bytes = 0usize;
    'scan: while let Some(relative) = stack.pop() {
        if cancelled.load(Ordering::Relaxed) { report.cancelled = true; break; }
        directories += 1;
        if directories > 4096 { report.limited = true; break; }
        let entries = match directory_entries(root, &relative) { Ok(value) => value, Err(error) => { report.skipped += 1; if error == "quota_exceeded" { report.limited = true; } continue; } };
        for entry in entries {
            if cancelled.load(Ordering::Relaxed) { report.cancelled = true; break 'scan; }
            if entry.kind == "directory" { if stack.len() >= 4096 { report.limited = true; break 'scan; } stack.push(entry.path); continue; }
            if entry.kind != "document" { continue; }
            if report.scanned >= 4096 || total_bytes >= 64 * 1024 * 1024 { report.limited = true; break 'scan; }
            report.scanned += 1;
            // Revalidate on each read and bound allocation even if the file grows.
            let read = (|| -> Result<Vec<u8>, String> {
                let path = safe_existing(root, &entry.path)?;
                let file = fs::File::open(path).map_err(|_| "io_failed")?;
                if !file.metadata().map_err(|_| "io_failed")?.is_file() || file.metadata().map_err(|_| "io_failed")?.len() > 2 * 1024 * 1024 { return Err("quota_exceeded".into()); }
                let mut bytes = Vec::new(); file.take(2 * 1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|_| "io_failed")?;
                if bytes.len() > 2 * 1024 * 1024 { return Err("quota_exceeded".into()); }
                Ok(bytes)
            })();
            let bytes = match read { Ok(bytes) => bytes, Err(_) => { report.skipped += 1; continue; } };
            if total_bytes + bytes.len() > 64 * 1024 * 1024 { report.limited = true; break 'scan; }
            total_bytes += bytes.len();
            let text = match std::str::from_utf8(&bytes) { Ok(text) if !text.contains('\0') => text.trim_start_matches('\u{feff}'), _ => { report.skipped += 1; continue; } };
            let revision = format!("{:x}", Sha256::digest(&bytes));
            for (index, line) in text.split('\n').enumerate() {
                if cancelled.load(Ordering::Relaxed) { report.cancelled = true; break 'scan; }
                let line = line.trim_end_matches('\r');
                if line.to_lowercase().contains(&needle) {
                    if report.results.len() >= 1000 { report.limited = true; break 'scan; }
                    let preview = line.trim().chars().take(240).collect::<String>();
                    report.results.push(SearchResult { path: entry.path.clone(), line: index + 1, preview, revision: revision.clone() });
                }
            }
        }
    }
    report.results.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()).then(a.line.cmp(&b.line)));
    Ok(report)
}

#[tauri::command]
pub async fn search_workspace(state: State<'_, Workspaces>, id: String, query: String, request_id: String) -> Result<SearchReport, String> {
    let workspaces = state.inner().clone();
    let directory = root(&workspaces, &id)?;
    let cancel = Arc::new(AtomicBool::new(false));
    { let mut tasks = workspaces.1.lock().map_err(|_| "io_failed")?;
      if tasks.contains_key(&request_id) || tasks.len() >= 8 { return Err("quota_exceeded".into()); }
      tasks.insert(request_id.clone(), cancel.clone()); }
    let result = tauri::async_runtime::spawn_blocking(move || search_directory(&directory, &query, &cancel)).await.map_err(|_| "io_failed".to_string());
    workspaces.1.lock().map_err(|_| "io_failed")?.remove(&request_id);
    result?
}

#[tauri::command]
pub fn cancel_workspace_search(state: State<'_, Workspaces>, request_id: String) -> Result<(), String> {
    if let Some(task) = state.1.lock().map_err(|_| "io_failed")?.get(&request_id) { task.store(true, Ordering::Relaxed); }
    Ok(())
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
    fn filename_search_uses_paths_only_and_ignores_build_private_and_non_markdown() {
        let temp = tempfile::tempdir().unwrap(); let root = temp.path().canonicalize().unwrap();
        fs::create_dir(root.join("中文 notes")).unwrap();
        // Invalid UTF-8 body is still discoverable: filename search never reads it.
        fs::write(root.join("中文 notes/同名.MARKDOWN"), [0xff, 0x00]).unwrap();
        fs::write(root.join("同名.md"), "unrelated body").unwrap();
        fs::write(root.join("body.md"), "同名").unwrap();
        fs::write(root.join("同名.txt"), "").unwrap();
        for name in [".private", "node_modules", "target", "dist", "build", "coverage", "test-results"] {
            fs::create_dir(root.join(name)).unwrap(); fs::write(root.join(name).join("同名.md"), "").unwrap();
        }
        let report = search_filenames(&root, "同名", &AtomicBool::new(false)).unwrap();
        assert_eq!(report.paths, vec!["中文 notes/同名.MARKDOWN", "同名.md"]);
        assert_eq!(search_filenames(&root, "中文 NOTES", &AtomicBool::new(false)).unwrap().paths, vec!["中文 notes/同名.MARKDOWN"]);
        assert_eq!(fs::read(root.join("中文 notes/同名.MARKDOWN")).unwrap(), vec![0xff, 0x00]);
        assert!(search_filenames(&root, "\0", &AtomicBool::new(false)).is_err());
        assert!(search_filenames(&root, &"a".repeat(1025), &AtomicBool::new(false)).is_err());
    }

    #[test]
    fn filename_search_bounds_results_entries_depth_and_cancels() {
        let temp = tempfile::tempdir().unwrap(); let root = temp.path().canonicalize().unwrap();
        for index in 0..101 { fs::write(root.join(format!("note{index}.md")), "").unwrap(); }
        let report = search_filenames(&root, "note", &AtomicBool::new(false)).unwrap();
        assert_eq!(report.paths.len(), 100); assert!(report.limited);
        let report = search_filenames(&root, "", &AtomicBool::new(true)).unwrap();
        assert!(report.cancelled); assert_eq!(report.scanned, 0);
        let mut deep = root.clone();
        for _ in 0..33 { deep.push("d"); fs::create_dir(&deep).unwrap(); }
        fs::write(deep.join("deep.md"), "").unwrap();
        let report = search_filenames(&root, "deep", &AtomicBool::new(false)).unwrap();
        assert!(report.limited); assert!(report.paths.is_empty());
        for index in 0..10_001 { fs::write(root.join(format!("f{index}.txt")), "").unwrap(); }
        let report = search_filenames(&root, "absent", &AtomicBool::new(false)).unwrap();
        assert_eq!(report.scanned, 10_000); assert!(report.limited);
    }

    #[cfg(unix)]
    #[test]
    fn filename_search_does_not_follow_directory_or_file_links() {
        let temp = tempfile::tempdir().unwrap(); let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.md"), "").unwrap();
        std::os::unix::fs::symlink(outside.path(), temp.path().join("directory")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.md"), temp.path().join("secret.md")).unwrap();
        let report = search_filenames(&temp.path().canonicalize().unwrap(), "", &AtomicBool::new(false)).unwrap();
        assert!(report.paths.is_empty()); assert_eq!(report.skipped, 2);
    }

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

    #[test]
    fn searches_only_markdown_with_relative_lines_and_case_insensitive_literals() {
        let temp = tempfile::tempdir().unwrap(); let root = temp.path().canonicalize().unwrap();
        fs::create_dir(root.join("nested")).unwrap();
        fs::write(root.join("A.md"), "First\nNeedle here\nlast").unwrap();
        fs::write(root.join("nested/B.MARKDOWN"), "needle again").unwrap();
        fs::write(root.join("ignore.txt"), "needle").unwrap();
        let report = search_directory(&root, "NEEDLE", &AtomicBool::new(false)).unwrap();
        assert_eq!(report.results.iter().map(|item| (item.path.as_str(), item.line)).collect::<Vec<_>>(), vec![("A.md", 2), ("nested/B.MARKDOWN", 1)]);
        assert!(search_directory(&root, "", &AtomicBool::new(false)).unwrap().results.is_empty());
    }

    #[test]
    fn search_preserves_unicode_bom_crlf_and_file_versions_without_writes() {
        let temp = tempfile::tempdir().unwrap(); let root = temp.path().canonicalize().unwrap();
        let bytes = "\u{feff}标题\r\n中文😀 needle\r\n".as_bytes();
        fs::write(root.join("中文.md"), bytes).unwrap();
        let report = search_directory(&root, "中文😀", &AtomicBool::new(false)).unwrap();
        assert_eq!(report.scanned, 1);
        assert_eq!(report.results[0].line, 2);
        assert_eq!(report.results[0].revision, format!("{:x}", Sha256::digest(bytes)));
        assert_eq!(fs::read(root.join("中文.md")).unwrap(), bytes);
        fs::write(root.join("中文.md"), "中文😀 new").unwrap();
        assert_ne!(report.results[0].revision, search_directory(&root, "中文😀", &AtomicBool::new(false)).unwrap().results[0].revision);
    }

    #[test]
    fn search_cancels_limits_and_skips_invalid_or_private_content() {
        let temp = tempfile::tempdir().unwrap(); let root = temp.path().canonicalize().unwrap();
        for name in [".private", "node_modules", "target"] {
            fs::create_dir(root.join(name)).unwrap(); fs::write(root.join(name).join("private.md"), "needle").unwrap();
        }
        fs::write(root.join("binary.md"), [0xff, 0xfe]).unwrap();
        fs::write(root.join("nul.md"), b"needle\0").unwrap();
        fs::write(root.join("large.md"), vec![b'x'; 2 * 1024 * 1024 + 1]).unwrap();
        let report = search_directory(&root, "needle", &AtomicBool::new(false)).unwrap();
        assert!(report.results.is_empty()); assert_eq!(report.skipped, 3);
        fs::write(root.join("matches.md"), "needle\n".repeat(1001)).unwrap();
        let report = search_directory(&root, "needle", &AtomicBool::new(false)).unwrap();
        assert_eq!(report.results.len(), 1000); assert!(report.limited);
        let report = search_directory(&root, "needle", &AtomicBool::new(true)).unwrap();
        assert!(report.cancelled); assert_eq!(report.scanned, 0);
        for query in ["a\nb", "a\rb", "\0"] { assert!(search_directory(&root, query, &AtomicBool::new(false)).is_err()); }
        assert!(search_directory(&root, &"a".repeat(4097), &AtomicBool::new(false)).is_err());
    }
}
