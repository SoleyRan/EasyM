use std::{fs, io::Write, path::{Component, Path, PathBuf}};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;

const MAX_IMAGE: usize = 20 * 1024 * 1024;
const MAX_TOTAL: usize = 128 * 1024 * 1024;
const MAX_META: u64 = 2 * 1024 * 1024;

#[derive(Deserialize)]
pub struct Asset { pub path: String, pub bytes: Vec<u8> }
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata { pub schema_version: u32, pub instances: Vec<serde_json::Value> }

pub fn read_metadata(root: &Path) -> (Option<Metadata>, Option<String>) {
    let path = root.join(".easym/images.json");
    if !path.exists() { return (None, Some("图片元数据缺失；正文和当前图片可读，编辑历史无法恢复。".into())); }
    let result = (|| -> Result<Metadata, String> {
        let path = safe_existing(root, ".easym/images.json")?;
        if fs::metadata(&path).map_err(|_| "io_failed")?.len() > MAX_META { return Err("quota_exceeded".into()); }
        let metadata: Metadata = serde_json::from_slice(&fs::read(path).map_err(|_| "io_failed")?).map_err(|_| "invalid_data")?;
        if metadata.schema_version != 1 { return Err("图片元数据版本不兼容；只读保留元数据，请使用新版应用。".into()); }
        for instance in &metadata.instances { validate_instance(instance)?; }
        Ok(metadata)
    })();
    match result { Ok(value) => (Some(value), None), Err(error) => (None, Some(error)) }
}

fn relative(path: &str) -> Result<&Path, String> {
    let value = Path::new(path);
    if value.as_os_str().is_empty() || path.contains('\\') || path.contains(':') || value.components().any(|c| !matches!(c, Component::Normal(_))) { return Err("permission_denied".into()); }
    Ok(value)
}

pub fn safe_existing(root: &Path, path: &str) -> Result<PathBuf, String> {
    let relative = relative(path)?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        let info = fs::symlink_metadata(&current).map_err(|_| "resource_missing")?;
        if info.file_type().is_symlink() { return Err("permission_denied".into()); }
        if !current.canonicalize().map_err(|_| "io_failed")?.starts_with(root) { return Err("permission_denied".into()); }
    }
    Ok(current)
}

fn managed(path: &str) -> bool {
    let suffix = path.strip_prefix("assets/.originals/").or_else(|| path.strip_prefix("assets/"));
    suffix.is_some_and(|name| name.starts_with("img-") && (name.ends_with(".png") || name.ends_with(".jpg")) && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.'))
}

fn validate_instance(instance: &serde_json::Value) -> Result<(), String> {
    for key in ["sourcePath", "displayPath"] { if !instance.get(key).and_then(|v| v.as_str()).is_some_and(managed) { return Err("invalid_data".into()); } }
    if instance.get("recipe").and_then(|v| v.get("version")).and_then(|v| v.as_u64()) != Some(1) { return Err("invalid_data".into()); }
    Ok(())
}

pub(crate) fn directory(root: &Path, path: &str) -> Result<PathBuf, String> {
    let mut current = root.to_path_buf();
    for component in relative(path)?.components() {
        current.push(component);
        if !current.exists() { fs::create_dir(&current).map_err(|_| "io_failed")?; }
        let info = fs::symlink_metadata(&current).map_err(|_| "io_failed")?;
        if info.file_type().is_symlink() || !info.is_dir() || !current.canonicalize().map_err(|_| "io_failed")?.starts_with(root) { return Err("permission_denied".into()); }
    }
    Ok(current)
}

fn verify_image(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_IMAGE { return Err("quota_exceeded".into()); }
    let reader = image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format().map_err(|_| "invalid_data")?;
    if !matches!(reader.format(), Some(image::ImageFormat::Png | image::ImageFormat::Jpeg)) { return Err("invalid_data".into()); }
    let (width, height) = reader.into_dimensions().map_err(|_| "invalid_data")?;
    if width == 0 || height == 0 || width > 8192 || height > 8192 || u64::from(width) * u64::from(height) > 24_000_000 { return Err("quota_exceeded".into()); }
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format().map_err(|_| "invalid_data")?;
    let mut limits = image::Limits::default(); limits.max_image_width = Some(8192); limits.max_image_height = Some(8192); limits.max_alloc = Some(128 * 1024 * 1024); reader.limits(limits);
    reader.decode().map_err(|_| "invalid_data")?;
    Ok(())
}

// New files are immutable. An identical retry succeeds; a different payload never overwrites a source.
pub fn write_assets(root: &Path, assets: &[Asset]) -> Result<(), String> {
    if assets.iter().map(|a| a.bytes.len()).sum::<usize>() > MAX_TOTAL { return Err("quota_exceeded".into()); }
    for asset in assets { if !managed(&asset.path) { return Err("permission_denied".into()); } verify_image(&asset.bytes)?; }
    for asset in assets {
        let path = relative(&asset.path)?;
        // Keep serialized resource separators independent of the host OS.
        let parent = directory(root, asset.path.rsplit_once('/').ok_or("invalid_data")?.0)?;
        let target = parent.join(path.file_name().ok_or("invalid_data")?);
        if target.exists() {
            let existing = safe_existing(root, &asset.path)?;
            if fs::metadata(&existing).map_err(|_| "io_failed")?.len() > MAX_IMAGE as u64 { return Err("quota_exceeded".into()); }
            if Sha256::digest(fs::read(existing).map_err(|_| "io_failed")?) != Sha256::digest(&asset.bytes) { return Err("revision_conflict".into()); }
            continue;
        }
        let mut temporary = NamedTempFile::new_in(&parent).map_err(|_| "io_failed")?;
        temporary.write_all(&asset.bytes).map_err(|_| "io_failed")?; temporary.as_file().sync_all().map_err(|_| "io_failed")?;
        if fs::read(temporary.path()).map_err(|_| "io_failed")? != asset.bytes { return Err("io_failed".into()); }
        temporary.persist_noclobber(target).map_err(|_| "io_failed")?;
    }
    Ok(())
}

pub fn stage_metadata(root: &Path, incoming: Metadata) -> Result<NamedTempFile, String> {
    if incoming.schema_version != 1 { return Err("invalid_data".into()); }
    let path = root.join(".easym/images.json");
    let mut combined = if path.exists() { read_metadata(root).0.ok_or("invalid_data")? } else { Metadata { schema_version: 1, instances: vec![] } };
    for instance in incoming.instances {
        validate_instance(&instance)?;
        for key in ["sourcePath", "displayPath"] { safe_existing(root, instance[key].as_str().ok_or("invalid_data")?)?; }
        combined.instances.retain(|i| i["displayPath"] != instance["displayPath"]);
        combined.instances.push(instance);
    }
    let bytes = serde_json::to_vec_pretty(&combined).map_err(|_| "invalid_data")?;
    if bytes.len() > MAX_META as usize { return Err("quota_exceeded".into()); }
    let parent = directory(root, ".easym")?;
    let mut temporary = NamedTempFile::new_in(parent).map_err(|_| "io_failed")?;
    temporary.write_all(&bytes).map_err(|_| "io_failed")?; temporary.as_file().sync_all().map_err(|_| "io_failed")?;
    serde_json::from_slice::<Metadata>(&fs::read(temporary.path()).map_err(|_| "io_failed")?).map_err(|_| "invalid_data")?;
    Ok(temporary)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_are_scoped() {
        for path in ["../a", "/a", "C:/a", "assets/../a", "assets\\a", "assets/a:stream"] { assert!(relative(path).is_err()); }
        assert!(managed("assets/.originals/img-abc-source.png"));
        assert!(!managed("assets/../source.png"));
    }
    #[test]
    fn missing_metadata_never_replaces_body() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("note.md"), "body").unwrap();
        let (metadata, warning) = read_metadata(root.path());
        assert!(metadata.is_none()); assert!(warning.is_some());
        assert_eq!(fs::read_to_string(root.path().join("note.md")).unwrap(), "body");
    }

    #[test]
    fn managed_source_is_immutable_and_nested_paths_work_on_windows() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let source = "assets/.originals/img-test-source.png";
        let bytes = include_bytes!("../icons/32x32.png").to_vec();
        write_assets(&root, &[Asset { path: source.into(), bytes: bytes.clone() }]).unwrap();
        write_assets(&root, &[Asset { path: source.into(), bytes: bytes.clone() }]).unwrap();
        let different = include_bytes!("../icons/64x64.png").to_vec();
        assert_eq!(write_assets(&root, &[Asset { path: source.into(), bytes: different }]).unwrap_err(), "revision_conflict");
        assert_eq!(fs::read(root.join(source)).unwrap(), bytes);
    }

    #[test]
    fn invalid_image_does_not_leave_a_visible_asset() {
        let root = tempfile::tempdir().unwrap();
        assert!(write_assets(root.path(), &[Asset { path: "assets/img-bad.png".into(), bytes: b"not an image".to_vec() }]).is_err());
        assert!(!root.path().join("assets/img-bad.png").exists());
    }

    #[test]
    fn higher_schema_is_retained_read_only() {
        let root = tempfile::tempdir().unwrap(); fs::create_dir(root.path().join(".easym")).unwrap();
        let path = root.path().join(".easym/images.json");
        let original = br#"{"schemaVersion":2,"instances":[]}"#;
        fs::write(&path, original).unwrap();
        assert!(read_metadata(root.path()).0.is_none());
        assert!(stage_metadata(root.path(), Metadata { schema_version: 1, instances: vec![] }).is_err());
        assert_eq!(fs::read(path).unwrap(), original);
    }
}
