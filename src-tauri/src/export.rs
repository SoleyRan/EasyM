use std::{fs, io::Write, path::Path};
use tauri::{State, WebviewWindow};
use tempfile::NamedTempFile;
use crate::storage::Storage;

const MAX_EXPORT: usize = 192 * 1024 * 1024;

fn write_html(storage: &Storage, path: &Path, html: &str) -> Result<(), String> {
    if html.len() > MAX_EXPORT { return Err("quota_exceeded".into()); }
    if !path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("html") || extension.eq_ignore_ascii_case("htm")) { return Err("导出文件请使用 .html 扩展名。".into()); }
    let parent = path.parent().ok_or("invalid_data")?.canonicalize().map_err(|_| "permission_denied")?;
    let target = parent.join(path.file_name().ok_or("invalid_data")?);
    let sessions = storage.0.lock().map_err(|_| "io_failed")?;
    let identity = target.canonicalize().unwrap_or_else(|_| target.clone());
    if sessions.values().any(|existing| existing.canonicalize().unwrap_or_else(|_| existing.clone()) == identity) { return Err("document_already_open".into()); }
    if fs::symlink_metadata(&target).map(|info| info.file_type().is_symlink() || !info.is_file()).unwrap_or(false) { return Err("permission_denied".into()); }
    let mut temporary = NamedTempFile::new_in(parent).map_err(|_| "io_failed")?;
    temporary.write_all(html.as_bytes()).map_err(|_| "io_failed")?;
    temporary.as_file().sync_all().map_err(|_| "io_failed")?;
    temporary.persist(target).map_err(|_| "io_failed")?;
    Ok(())
}

#[tauri::command]
pub async fn export_html(state: State<'_, Storage>, name: String, html: String) -> Result<bool, String> {
    if html.len() > MAX_EXPORT { return Err("quota_exceeded".into()); }
    let storage = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let safe_name = Path::new(&name).file_name().unwrap_or_default().to_string_lossy();
        let Some(path) = rfd::FileDialog::new().add_filter("HTML", &["html", "htm"]).set_file_name(safe_name.as_ref()).save_file() else { return Ok(false); };
        write_html(&storage, &path, &html)?;
        Ok(true)
    }).await.map_err(|_| "io_failed".to_string())?
}

#[tauri::command]
pub fn print_document(window: WebviewWindow) -> Result<(), String> {
    window.print().map_err(|_| "系统打印不可用，请导出 HTML 后在浏览器中打印。".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn export_is_independent_of_markdown_sessions_and_rejects_wrong_extensions() {
        let root = tempfile::tempdir().unwrap();
        let storage = Storage::default();
        let source = root.path().join("中文.md"); fs::write(&source, "source").unwrap();
        storage.0.lock().unwrap().insert("source".into(), source.clone());
        assert!(write_html(&storage, &source, "overwrite").is_err());
        assert_eq!(fs::read_to_string(&source).unwrap(), "source");
        let output = root.path().join("中文.html");
        write_html(&storage, &output, "<!doctype html><p>中文</p>").unwrap();
        write_html(&storage, &output, "updated").unwrap();
        assert_eq!(fs::read_to_string(output).unwrap(), "updated");
        assert_eq!(storage.0.lock().unwrap().len(), 1);
    }
    #[test]
    fn export_refuses_open_documents_and_directories() {
        let root = tempfile::tempdir().unwrap(); let storage = Storage::default();
        let open = root.path().join("open.html"); fs::write(&open, "keep").unwrap();
        storage.0.lock().unwrap().insert("open".into(), open.clone());
        assert_eq!(write_html(&storage, &open, "replace"), Err("document_already_open".into()));
        let directory = root.path().join("directory.html"); fs::create_dir(&directory).unwrap();
        assert_eq!(write_html(&storage, &directory, "replace"), Err("permission_denied".into()));
    }
}
