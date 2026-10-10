use std::{fs, io::Write, path::Path};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;
use crate::resources::{Asset, Metadata, directory, safe_existing, stage_metadata, write_assets};

pub(crate) fn hash(bytes: &[u8]) -> String { format!("sha256:{:x}", Sha256::digest(bytes)) }

#[derive(Deserialize, Serialize)]
struct Record {
    version: u32,
    document: String,
    previous: Option<String>,
    revision: String,
    metadata: Option<Metadata>,
    complete: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Phase { Assets, Prepared, Body, Metadata }

fn staged(parent: &Path, bytes: &[u8]) -> Result<NamedTempFile, String> {
    let mut file = NamedTempFile::new_in(parent).map_err(|_| "io_failed")?;
    file.write_all(bytes).map_err(|_| "io_failed")?;
    file.as_file().sync_all().map_err(|_| "io_failed")?;
    if fs::read(file.path()).map_err(|_| "io_failed")? != bytes { return Err("io_failed".into()); }
    Ok(file)
}

fn write_record(root: &Path, operation: &str, record: &Record) -> Result<(), String> {
    let parent = directory(root, ".easym/operations")?;
    let name = format!("op-{operation}.json");
    let path = parent.join(&name);
    if path.exists() { safe_existing(root, &format!(".easym/operations/{name}"))?; }
    let bytes = serde_json::to_vec(record).map_err(|_| "invalid_data")?;
    staged(&parent, &bytes)?.persist(path).map_err(|_| "io_failed")?;
    Ok(())
}

fn read_record(root: &Path, relative: &str) -> Result<Record, String> {
    let path = safe_existing(root, relative)?;
    if fs::metadata(&path).map_err(|_| "io_failed")?.len() > 3 * 1024 * 1024 { return Err("quota_exceeded".into()); }
    let record: Record = serde_json::from_slice(&fs::read(path).map_err(|_| "io_failed")?).map_err(|_| "invalid_data")?;
    if record.version != 1 { return Err("invalid_data".into()); }
    Ok(record)
}

fn check(path: &Path, expected: Option<&str>) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(info) => {
            if info.file_type().is_symlink() { return Err("permission_denied".into()); }
            if info.len() > 10 * 1024 * 1024 { return Err("quota_exceeded".into()); }
            let actual = hash(&fs::read(path).map_err(|_| "io_failed")?);
            if expected != Some(actual.as_str()) { return Err("revision_conflict".into()); }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            if expected.is_some() { return Err("revision_conflict".into()); }
        }
        Err(_) => return Err("io_failed".into()),
    }
    Ok(())
}

fn commit_metadata(root: &Path, record: &Record) -> Result<(), String> {
    if let Some(metadata) = &record.metadata {
        stage_metadata(root, metadata.clone())?.persist(root.join(".easym/images.json")).map_err(|_| "io_failed")?;
    }
    Ok(())
}

// A failed metadata commit is recoverable after the body commits; never report that the body was rolled back.
pub(crate) fn save(path: &Path, expected: Option<&str>, bytes: &[u8], assets: &[Asset], metadata: Metadata, operation: &str) -> Result<Option<String>, String> {
    save_with(path, expected, bytes, assets, metadata, operation, |_| Ok(()))
}

fn save_with(path: &Path, expected: Option<&str>, bytes: &[u8], assets: &[Asset], metadata: Metadata, operation: &str, mut phase: impl FnMut(Phase) -> Result<(), String>) -> Result<Option<String>, String> {
    let normalized_operation = uuid::Uuid::parse_str(operation).map_err(|_| "invalid_data")?.to_string();
    let operation = normalized_operation.as_str();
    let root = path.parent().ok_or("invalid_data")?.canonicalize().map_err(|_| "permission_denied")?;
    let document = path.file_name().ok_or("invalid_data")?.to_string_lossy().to_string();
    let revision = hash(bytes);
    let relative = format!(".easym/operations/op-{operation}.json");
    if root.join(&relative).exists() {
        let mut record = read_record(&root, &relative)?;
        if record.document != document || record.revision != revision { return Err("revision_conflict".into()); }
        if check(path, Some(&revision)).is_ok() {
            if !record.complete {
                if commit_metadata(&root, &record).is_err() { return Ok(Some("正文已保存，图片历史待修复；重新打开可重试恢复。".into())); }
                record.complete = true;
                write_record(&root, operation, &record)?;
            }
            return Ok(None);
        }
        if record.complete || record.previous.as_deref() != expected { return Err("revision_conflict".into()); }
    }
    check(path, expected)?;
    write_assets(&root, assets)?;
    phase(Phase::Assets)?;
    let metadata_file = if metadata.instances.is_empty() { None } else { Some(stage_metadata(&root, metadata)?) };
    let combined = match &metadata_file {
        Some(file) => Some(serde_json::from_slice::<Metadata>(&fs::read(file.path()).map_err(|_| "io_failed")?).map_err(|_| "invalid_data")?),
        None => None,
    };
    let temporary = staged(&root, bytes)?;
    let mut record = Record { version: 1, document, previous: expected.map(str::to_string), revision, metadata: combined, complete: false };
    write_record(&root, operation, &record)?;
    phase(Phase::Prepared)?;
    check(path, expected)?;
    if expected.is_none() { temporary.persist_noclobber(path).map_err(|_| "revision_conflict")?; }
    else { temporary.persist(path).map_err(|_| "io_failed")?; }
    // The body is committed from this point onwards. Return a warning on any later failure.
    let finish = (|| -> Result<(), String> {
        phase(Phase::Body)?;
        check(path, Some(&record.revision))?;
        phase(Phase::Metadata)?;
        if let Some(file) = metadata_file { file.persist(root.join(".easym/images.json")).map_err(|_| "io_failed")?; }
        record.complete = true;
        write_record(&root, operation, &record)
    })();
    Ok(finish.err().map(|_| "正文与图片已保存，恢复记录仍保留；重新打开将重试图片历史提交。".to_string()))
}

// Only finish records whose proposed body hash matches the user's current file.
pub(crate) fn recover(path: &Path) -> Option<String> {
    let root = path.parent()?.canonicalize().ok()?;
    if !root.join(".easym/operations").exists() { return None; }
    let result = (|| -> Result<bool, String> {
        let directory = safe_existing(&root, ".easym/operations")?;
        let document = path.file_name().ok_or("invalid_data")?.to_string_lossy();
        let mut repaired = false;
        for (count, entry) in fs::read_dir(directory).map_err(|_| "io_failed")?.enumerate() {
            if count > 4096 { return Err("quota_exceeded".into()); }
            let name = entry.map_err(|_| "io_failed")?.file_name().to_string_lossy().to_string();
            let Some(operation) = name.strip_prefix("op-").and_then(|s| s.strip_suffix(".json")) else { continue; };
            if uuid::Uuid::parse_str(operation).is_err() { continue; }
            let mut record = read_record(&root, &format!(".easym/operations/{name}"))?;
            if record.complete || record.document != document { continue; }
            if check(path, Some(&record.revision)).is_ok() {
                commit_metadata(&root, &record)?;
                record.complete = true;
                write_record(&root, operation, &record)?;
                repaired = true;
            }
        }
        Ok(repaired)
    })();
    match result {
        Ok(true) => Some("已恢复中断的保存操作，正文与图片历史已同步。".into()),
        Ok(false) => None,
        Err(_) => Some("保存恢复记录需要修复；已保留当前正文和原始记录。".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn empty() -> Metadata { Metadata { schema_version: 1, instances: vec![] } }

    #[test]
    fn stale_external_version_is_not_overwritten() {
        let root = tempfile::tempdir().unwrap(); let path = root.path().join("note.md");
        fs::write(&path, b"external").unwrap();
        assert_eq!(save(&path, Some(&hash(b"old")), b"local", &[], empty(), &uuid::Uuid::new_v4().to_string()).unwrap_err(), "revision_conflict");
        assert_eq!(fs::read(&path).unwrap(), b"external");
    }

    #[test]
    fn failure_before_commit_preserves_body_and_can_retry() {
        for stop in [Phase::Assets, Phase::Prepared] {
            let root = tempfile::tempdir().unwrap(); let path = root.path().join("note.md"); let operation = uuid::Uuid::new_v4().to_string();
            fs::write(&path, b"old").unwrap();
            assert!(save_with(&path, Some(&hash(b"old")), b"new", &[], empty(), &operation, |at| if at == stop { Err("disk_full".into()) } else { Ok(()) }).is_err());
            assert_eq!(fs::read(&path).unwrap(), b"old");
            save(&path, Some(&hash(b"old")), b"new", &[], empty(), &operation).unwrap();
            assert_eq!(fs::read(&path).unwrap(), b"new");
        }
    }

    #[test]
    fn interrupted_commit_recovers_without_rewriting_body() {
        let root = tempfile::tempdir().unwrap(); let path = root.path().join("note.md"); let operation = uuid::Uuid::new_v4().to_string();
        fs::write(&path, b"old").unwrap();
        assert!(save_with(&path, Some(&hash(b"old")), b"new", &[], empty(), &operation, |at| if at == Phase::Body { Err("crash".into()) } else { Ok(()) }).unwrap().is_some());
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert!(recover(&path).unwrap().contains("已恢复"));
        assert!(recover(&path).is_none());
        assert!(save(&path, Some(&hash(b"old")), b"new", &[], empty(), &operation).is_ok());
        assert!(save(&path, Some(&hash(b"new")), b"different", &[], empty(), &operation).is_err());
    }

    #[test]
    fn recovery_never_replaces_a_later_external_version() {
        let root = tempfile::tempdir().unwrap(); let path = root.path().join("note.md");
        fs::write(&path, b"old").unwrap();
        save_with(&path, Some(&hash(b"old")), b"new", &[], empty(), &uuid::Uuid::new_v4().to_string(), |at| if at == Phase::Body { Err("crash".into()) } else { Ok(()) }).unwrap();
        fs::write(&path, b"external").unwrap();
        assert!(recover(&path).is_none());
        assert_eq!(fs::read(&path).unwrap(), b"external");
    }

    fn picture_metadata() -> (Vec<Asset>, Metadata) {
        let bytes = include_bytes!("../icons/32x32.png").to_vec();
        let source = "assets/.originals/img-test-source.png";
        let display = "assets/img-test-v1.png";
        let assets = vec![Asset { path: source.into(), bytes: bytes.clone() }, Asset { path: display.into(), bytes: bytes.clone() }];
        let metadata = Metadata { schema_version: 1, instances: vec![serde_json::json!({
            "instanceId": "img-test", "documentId": null, "sourcePath": source,
            "sourceHash": hash(&bytes), "displayPath": display,
            "recipe": {"version":1,"orientationNormalized":true,"rotateDegrees":0,"flipHorizontal":false,"flipVertical":false,"output":{"mime":"image/png"}},
            "referenceRevision":1
        })] };
        (assets, metadata)
    }

    #[test]
    fn metadata_failure_recovers_real_image_history_after_restart() {
        let root = tempfile::tempdir().unwrap(); let path = root.path().join("note.md");
        fs::write(&path, b"old").unwrap();
        let (assets, metadata) = picture_metadata(); let operation = uuid::Uuid::new_v4().to_string();
        let body = b"![image](assets/img-test-v1.png)";
        assert!(save_with(&path, Some(&hash(b"old")), body, &assets, metadata.clone(), &operation, |at| if at == Phase::Metadata { Err("metadata_full".into()) } else { Ok(()) }).unwrap().is_some());
        assert_eq!(fs::read(&path).unwrap(), body);
        assert!(root.path().join("assets/img-test-v1.png").exists());
        assert!(!root.path().join(".easym/images.json").exists());
        assert!(recover(&path).is_some());
        let recovered = crate::resources::read_metadata(&root.path().canonicalize().unwrap()).0.unwrap();
        assert_eq!(recovered.instances, metadata.instances);
        save(&path, Some(&hash(b"old")), body, &assets, metadata, &operation).unwrap();
        assert_eq!(crate::resources::read_metadata(&root.path().canonicalize().unwrap()).0.unwrap().instances.len(), 1);
    }

    #[test]
    fn conflict_during_asset_write_preserves_external_body() {
        let root = tempfile::tempdir().unwrap(); let path = root.path().join("note.md");
        fs::write(&path, b"old").unwrap(); let (assets, metadata) = picture_metadata();
        let result = save_with(&path, Some(&hash(b"old")), b"local", &assets, metadata, &uuid::Uuid::new_v4().to_string(), |at| {
            if at == Phase::Assets { fs::write(&path, b"external").unwrap(); } Ok(())
        });
        assert_eq!(result.unwrap_err(), "revision_conflict");
        assert_eq!(fs::read(&path).unwrap(), b"external");
    }

    #[test]
    fn corrupt_metadata_blocks_image_commit_without_replacing_body() {
        let root = tempfile::tempdir().unwrap(); let path = root.path().join("note.md");
        fs::write(&path, b"old").unwrap(); fs::create_dir(root.path().join(".easym")).unwrap();
        fs::write(root.path().join(".easym/images.json"), b"corrupt").unwrap();
        let (assets, metadata) = picture_metadata();
        assert!(save(&path, Some(&hash(b"old")), b"new", &assets, metadata, &uuid::Uuid::new_v4().to_string()).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"old");
    }
}
