use std::{collections::HashSet, fs, io::{Cursor, Read, Write}, path::{Path, PathBuf}};
use tauri::{State, WebviewWindow};
use tempfile::NamedTempFile;
use crate::storage::Storage;

const MAX_EXPORT: usize = 192 * 1024 * 1024;

const REQUIRED_DOCX: [&str; 5] = ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml", "word/_rels/document.xml.rels"];

fn validate_xml(name: &str, bytes: &[u8]) -> Result<(), String> {
    use quick_xml::{events::Event, Reader};
    let source = std::str::from_utf8(bytes).map_err(|_| "invalid_data")?;
    if source.chars().any(|c| (c < '\u{20}' && !['\t', '\n', '\r'].contains(&c)) || c == '\u{fffe}' || c == '\u{ffff}') { return Err("invalid_data".into()); }
    let mut reader = Reader::from_str(source);
    let mut depth = 0usize;
    let mut roots = 0usize;
    let mut expected_root = false;
    let mut main_type = false;
    loop {
        let event = reader.read_event().map_err(|_| "invalid_data")?;
        let is_start = matches!(event, Event::Start(_));
        match event {
            Event::Start(e) | Event::Empty(e) => {
                if depth == 0 {
                    roots += 1;
                    expected_root |= match name {
                        "word/document.xml" => e.local_name().as_ref() == "document",
                        "word/styles.xml" => e.local_name().as_ref() == "styles",
                        "[Content_Types].xml" => e.local_name().as_ref() == "Types",
                        _ if name.ends_with(".rels") => e.local_name().as_ref() == "Relationships",
                        _ => true,
                    };
                }
                let mut kind = String::new(); let mut mode = String::new(); let mut part = String::new(); let mut content = String::new();
                for attr in e.attributes() {
                    let attr = attr.map_err(|_| "invalid_data")?;
                    let value = attr.normalized_value(quick_xml::XmlVersion::Implicit1_0).map_err(|_| "invalid_data")?.into_owned();
                    match attr.key.as_ref() {
                        "Type" => kind = value,
                        "TargetMode" => mode = value,
                        "PartName" => part = value,
                        "ContentType" => content = value,
                        _ => (),
                    }
                }
                if depth == 0 {
                    let element = e.name();
                    let namespace_key = element.as_ref().split_once(':').map(|(prefix, _)| format!("xmlns:{prefix}")).unwrap_or_else(|| "xmlns".into());
                    let expected_namespace = match name {
                        "word/document.xml" | "word/styles.xml" => Some("http://schemas.openxmlformats.org/wordprocessingml/2006/main"),
                        "[Content_Types].xml" => Some("http://schemas.openxmlformats.org/package/2006/content-types"),
                        _ if name.ends_with(".rels") => Some("http://schemas.openxmlformats.org/package/2006/relationships"),
                        _ => None,
                    };
                    if let Some(namespace) = expected_namespace {
                        let found = e.attributes().any(|attr| attr.is_ok_and(|attr| attr.key.as_ref() == namespace_key && attr.normalized_value(quick_xml::XmlVersion::Implicit1_0).is_ok_and(|value| value == namespace)));
                        if !found { return Err("invalid_data".into()); }
                    }
                }
                if kind.contains("oleObject") || kind.contains("vbaProject") || kind.ends_with("/image") && mode == "External" { return Err("invalid_data".into()); }
                if content.to_ascii_lowercase().contains("macroenabled") { return Err("invalid_data".into()); }
                if part == "/word/document.xml" && content == "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml" { main_type = true; }
                if is_start { depth += 1; }
                if depth > 128 { return Err("quota_exceeded".into()); }
            }
            Event::End(_) => { depth = depth.checked_sub(1).ok_or("invalid_data")?; }
            Event::DocType(_) => return Err("invalid_data".into()),
            Event::GeneralRef(e) => {
                if depth == 0 { return Err("invalid_data".into()); }
                let character = e.resolve_char_ref().map_err(|_| "invalid_data")?;
                if character.is_none() && !["amp", "lt", "gt", "apos", "quot"].contains(&e.as_ref()) { return Err("invalid_data".into()); }
                if character.is_some_and(|c| c < '\u{20}' && !['\t', '\n', '\r'].contains(&c) || c == '\u{fffe}' || c == '\u{ffff}') { return Err("invalid_data".into()); }
            }
            Event::Text(e) if depth == 0 => { if !e.as_ref().bytes().all(|byte| byte.is_ascii_whitespace()) { return Err("invalid_data".into()); } }
            Event::Eof => break,
            _ => (),
        }
    }
    if roots != 1 || depth != 0 || !expected_root || name == "[Content_Types].xml" && !main_type { return Err("invalid_data".into()); }
    Ok(())
}

fn validate_docx(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_EXPORT { return Err("quota_exceeded".into()); }
    if !bytes.starts_with(b"PK\x03\x04") { return Err("invalid_data".into()); }
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "invalid_data")?;
    if zip.len() > 4096 { return Err("quota_exceeded".into()); }
    let mut names = HashSet::new(); let mut total = 0u64;
    for i in 0..zip.len() {
        let mut file = zip.by_index(i).map_err(|_| "invalid_data")?;
        let name = file.name().to_string();
        if name.contains('\\') || name.starts_with('/') || name.contains(':') || name.split('/').any(|p| p == ".." || p == ".") || !names.insert(name.clone()) { return Err("invalid_data".into()); }
        if file.is_dir() { continue; }
        let lower = name.to_ascii_lowercase();
        if lower.contains("vbaproject") || lower.contains("oleobject") || lower.starts_with("word/embeddings/") || file.unix_mode().is_some_and(|mode| mode & 0o170000 == 0o120000) { return Err("invalid_data".into()); }
        total = total.checked_add(file.size()).ok_or("quota_exceeded")?;
        if total > MAX_EXPORT as u64 { return Err("quota_exceeded".into()); }
        // Bounded decompression and reading through EOF validates ZIP CRC32.
        if lower.ends_with(".xml") || lower.ends_with(".rels") {
            if file.size() > MAX_EXPORT as u64 { return Err("quota_exceeded".into()); }
            let mut xml = Vec::new();
            file.by_ref().take(MAX_EXPORT as u64 + 1).read_to_end(&mut xml).map_err(|_| "invalid_data")?;
            if xml.len() > MAX_EXPORT { return Err("quota_exceeded".into()); }
            validate_xml(&name, &xml)?;
        } else {
            let length = std::io::copy(&mut file.by_ref().take(MAX_EXPORT as u64 + 1), &mut std::io::sink()).map_err(|_| "invalid_data")?;
            if length != file.size() { return Err("invalid_data".into()); }
        }
    }
    if REQUIRED_DOCX.iter().any(|name| !names.contains(*name)) { return Err("invalid_data".into()); }
    Ok(())
}

fn target_version(path: &Path) -> Result<Option<String>, String> {
    match fs::symlink_metadata(path) {
        Ok(info) => {
            if info.file_type().is_symlink() || !info.is_file() { return Err("permission_denied".into()); }
            #[cfg(windows)] {
                use std::os::windows::fs::MetadataExt;
                if info.file_attributes() & 0x400 != 0 { return Err("permission_denied".into()); }
            }
            if info.len() > MAX_EXPORT as u64 { return Err("quota_exceeded".into()); }
            let mut bytes = Vec::new();
            fs::File::open(path).map_err(|_| "io_failed")?.take(MAX_EXPORT as u64 + 1).read_to_end(&mut bytes).map_err(|_| "io_failed")?;
            if bytes.len() > MAX_EXPORT { return Err("quota_exceeded".into()); }
            Ok(Some(crate::transaction::hash(&bytes)))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("io_failed".into()),
    }
}

fn docx_target(path: &Path) -> Result<PathBuf, String> {
    if !path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("docx")) { return Err("导出文件请使用 .docx 扩展名。".into()); }
    let parent = path.parent().ok_or("invalid_data")?.canonicalize().map_err(|_| "permission_denied")?;
    Ok(parent.join(path.file_name().ok_or("invalid_data")?))
}

fn write_docx(storage: &Storage, target: &Path, expected: Option<&str>, bytes: &[u8], before_commit: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    validate_docx(bytes)?;
    let checked = docx_target(target)?;
    if checked != target { return Err("revision_conflict".into()); }
    let sessions = storage.0.lock().map_err(|_| "io_failed")?;
    let identity = target.canonicalize().unwrap_or_else(|_| target.to_path_buf());
    if sessions.values().any(|path| path.canonicalize().unwrap_or_else(|_| path.clone()) == identity || same_file::is_same_file(target, path).unwrap_or(false)) { return Err("document_already_open".into()); }
    if target_version(target)?.as_deref() != expected { return Err("revision_conflict".into()); }
    let mut temporary = NamedTempFile::new_in(target.parent().ok_or("invalid_data")?).map_err(|_| "io_failed")?;
    temporary.write_all(bytes).map_err(|_| "io_failed")?;
    temporary.as_file().sync_all().map_err(|_| "io_failed")?;
    before_commit()?;
    if docx_target(target)? != checked || target_version(target)?.as_deref() != expected { return Err("revision_conflict".into()); }
    if expected.is_none() { temporary.persist_noclobber(target).map_err(|_| "revision_conflict")?; }
    else { temporary.persist(target).map_err(|_| "io_failed")?; }
    Ok(())
}

#[tauri::command]
pub async fn export_docx(state: State<'_, Storage>, name: String, bytes: Vec<u8>) -> Result<bool, String> {
    if bytes.len() > MAX_EXPORT { return Err("quota_exceeded".into()); }
    let storage = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        validate_docx(&bytes)?;
        let safe_name = Path::new(&name).file_name().unwrap_or_default().to_string_lossy();
        // Path authorization is exclusively this native dialog. No caller path
        // or Markdown session is created for the binary output.
        let Some(path) = rfd::FileDialog::new().add_filter("Word 文档", &["docx"]).set_file_name(safe_name.as_ref()).save_file() else { return Ok(false); };
        let target = docx_target(&path)?;
        let expected = target_version(&target)?;
        write_docx(&storage, &target, expected.as_deref(), &bytes, || Ok(()))?;
        Ok(true)
    }).await.map_err(|_| "io_failed".to_string())?
}

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
    fn package(extra: Option<(&str, &[u8])>) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for name in REQUIRED_DOCX {
            writer.start_file(name, options).unwrap();
            let xml = match name {
                "[Content_Types].xml" => "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>",
                "word/document.xml" => "<document xmlns=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><body><p>中文🙂</p></body></document>",
                "word/styles.xml" => "<styles xmlns=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"/>",
                _ => "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"/>",
            };
            writer.write_all(xml.as_bytes()).unwrap();
        }
        if let Some((name, bytes)) = extra { writer.start_file(name, options).unwrap(); writer.write_all(bytes).unwrap(); }
        writer.finish().unwrap().into_inner()
    }
    #[test]
    fn docx_checks_zip_ooxml_xml_and_restricted_parts() {
        assert_eq!(validate_docx(&package(None)), Ok(()));
        for bytes in [b"not zip".to_vec(), package(Some(("word/embeddings/object.bin", b"ole"))), package(Some(("word/vbaProject.bin", b"macro"))), package(Some(("../escape", b"outside"))), package(Some(("word/broken.xml", b"<broken>"))), package(Some(("word/dtd.xml", b"<!DOCTYPE foo><foo/>"))), package(Some(("word/_rels/unsafe.rels", b"<Relationships><Relationship Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" TargetMode=\"External\" Target=\"https://example.invalid/x.png\"/></Relationships>")))] {
            assert_eq!(validate_docx(&bytes), Err("invalid_data".into()));
        }
        let mut corrupt = package(Some(("word/media/em.png", b"picture"))); corrupt.truncate(corrupt.len() - 22);
        assert_eq!(validate_docx(&corrupt), Err("invalid_data".into()));
        let mut corrupt = package(Some(("word/media/em.png", b"picture")));
        let offset = { let mut zip = zip::ZipArchive::new(Cursor::new(&corrupt)).unwrap(); let offset = zip.by_name("word/media/em.png").unwrap().data_start() as usize; offset };
        corrupt[offset] ^= 0x40;
        assert_eq!(validate_docx(&corrupt), Err("invalid_data".into()));
        assert!(validate_xml("word/document.xml", b"<document/>").is_err());
        assert!(validate_xml("other.xml", b"<root>&undeclared;</root>").is_err());
    }
    #[test]
    fn docx_save_never_changes_source_sessions_and_rejects_wrong_extension_or_open_target() {
        let root = tempfile::tempdir().unwrap(); let storage = Storage::default(); let bytes = package(None);
        let source = root.path().join("source.md"); fs::write(&source, b"original").unwrap();
        storage.0.lock().unwrap().insert("source".into(), source.clone());
        assert!(docx_target(&source).is_err());
        let target = docx_target(&root.path().join("office.docx")).unwrap();
        write_docx(&storage, &target, None, &bytes, || Ok(())).unwrap();
        let expected = target_version(&target).unwrap();
        write_docx(&storage, &target, expected.as_deref(), &bytes, || Ok(())).unwrap();
        assert_eq!(fs::read(&source).unwrap(), b"original");
        assert_eq!(storage.0.lock().unwrap().len(), 1);
        let alias = root.path().join("alias.docx"); fs::hard_link(&source, &alias).unwrap();
        let alias = docx_target(&alias).unwrap(); let revision = target_version(&alias).unwrap();
        assert_eq!(write_docx(&storage, &alias, revision.as_deref(), &bytes, || Ok(())), Err("document_already_open".into()));
        assert_eq!(fs::read(&source).unwrap(), b"original");
        storage.0.lock().unwrap().insert("open".into(), target.clone());
        assert_eq!(write_docx(&storage, &target, expected.as_deref(), &bytes, || Ok(())), Err("document_already_open".into()));
    }
    #[test]
    fn docx_failure_and_stale_revision_preserve_existing_target() {
        let root = tempfile::tempdir().unwrap(); let storage = Storage::default();
        let target = docx_target(&root.path().join("keep.docx")).unwrap(); fs::write(&target, b"keep").unwrap();
        let expected = target_version(&target).unwrap();
        assert_eq!(write_docx(&storage, &target, expected.as_deref(), &package(None), || Err("disk_full".into())), Err("disk_full".into()));
        assert_eq!(fs::read(&target).unwrap(), b"keep");
        assert_eq!(write_docx(&storage, &target, Some("stale"), &package(None), || Ok(())), Err("revision_conflict".into()));
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }
    #[test]
    fn docx_detects_replacement_and_new_target_races_before_commit() {
        for existing in [true, false] {
            let root = tempfile::tempdir().unwrap(); let storage = Storage::default();
            let target = docx_target(&root.path().join("race.docx")).unwrap();
            if existing { fs::write(&target, b"old").unwrap(); }
            let expected = target_version(&target).unwrap();
            assert_eq!(write_docx(&storage, &target, expected.as_deref(), &package(None), || { fs::write(&target, b"external").unwrap(); Ok(()) }), Err("revision_conflict".into()));
            assert_eq!(fs::read(&target).unwrap(), b"external");
            assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
        }
    }
    #[test]
    fn docx_refuses_directories_and_symlinks() {
        let root = tempfile::tempdir().unwrap(); let path = root.path().join("directory.docx"); fs::create_dir(&path).unwrap();
        assert_eq!(target_version(&path), Err("permission_denied".into()));
        #[cfg(unix)] {
            let link = root.path().join("link.docx"); std::os::unix::fs::symlink(&path, &link).unwrap();
            assert_eq!(target_version(&link), Err("permission_denied".into()));
        }
    }
    #[test]
    fn generated_browser_fixture_passes_native_validation_and_atomic_save() {
        // CI's native jobs do not generate the browser artifact. A local 3B
        // acceptance run supplies it to check the real generator/save contract.
        let Ok(path) = std::env::var("EASYM_DOCX_FIXTURE") else { return; };
        let bytes = fs::read(path).unwrap(); validate_docx(&bytes).unwrap();
        let root = tempfile::tempdir().unwrap(); let target = docx_target(&root.path().join("actual.docx")).unwrap();
        write_docx(&Storage::default(), &target, None, &bytes, || Ok(())).unwrap();
        assert_eq!(fs::read(target).unwrap(), bytes);
    }
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
