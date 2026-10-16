//! Mandatory, immutable pre-merge recovery copies, independent of opt-in history.
use std::{collections::BTreeSet, fs, io::Write, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;
use crate::{resources::{self, Asset, Metadata}, storage::{Storage, checked_document, read_text}, transaction};

const BASE: &str = ".easym/merges";
const MAX_TEXT: usize = 10 * 1024 * 1024;
const MAX_ARCHIVE: u64 = 512 * 1024 * 1024;
const MAX_RECORDS: usize = 128;

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct References { references: Vec<String>, unarchived_references: Vec<String> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeInput {
    base_revision: String, disk_revision: String,
    base: Vec<u8>, local: Vec<u8>, disk: Vec<u8>, result: Vec<u8>,
    references: Vec<References>, assets: Vec<Asset>, metadata: Metadata,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Object { name: String, hash: String, size: usize }
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    schema_version: u32, operation_id: String, document: String, created_at: u64,
    base_revision: String, disk_revision: String, objects: Vec<Object>, assets: Vec<Object>, metadata: Metadata,
}
fn safe(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = resources::safe_existing(root, relative)?;
    checked_document(&path)?; Ok(path)
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|_| "io_failed")?;
    file.write_all(bytes).map_err(|_| "io_failed")?; file.sync_all().map_err(|_| "io_failed")?;
    if fs::read(path).map_err(|_| "io_failed")? != bytes { return Err("merge_archive_corrupt".into()); }
    Ok(())
}
fn utf8(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_TEXT { return Err("quota_exceeded".into()); }
    let text = std::str::from_utf8(bytes).map_err(|_| "invalid_data")?;
    if text.contains('\0') { return Err("invalid_data".into()); } Ok(())
}
fn check_revision(path: &Path, expected: &str) -> Result<(), String> {
    checked_document(path)?;
    if transaction::hash(&read_text(path)?) != expected { return Err("revision_conflict".into()); } Ok(())
}
fn read_object(root: &Path, object: &Object, max: usize) -> Result<Vec<u8>, String> {
    let path = safe(root, &object.name)?;
    if !path.is_file() || object.size > max || fs::metadata(&path).map_err(|_| "io_failed")?.len() != object.size as u64 { return Err("merge_archive_corrupt".into()); }
    let bytes = fs::read(path).map_err(|_| "io_failed")?;
    if bytes.len() != object.size || transaction::hash(&bytes) != object.hash { return Err("merge_archive_corrupt".into()); } Ok(bytes)
}
fn read_record(root: &Path, operation: &str, document: &str) -> Result<(PathBuf, Record), String> {
    let operation = uuid::Uuid::parse_str(operation).map_err(|_| "invalid_data")?.to_string();
    let folder = safe(root, &format!("{BASE}/{operation}"))?;
    let manifest = safe(&folder, "record.json")?;
    if fs::metadata(&manifest).map_err(|_| "io_failed")?.len() > 2 * 1024 * 1024 { return Err("quota_exceeded".into()); }
    let record: Record = serde_json::from_slice(&fs::read(manifest).map_err(|_| "io_failed")?).map_err(|_| "merge_archive_corrupt")?;
    if record.schema_version != 1 || record.operation_id != operation || record.document != document || record.objects.len() != 4 || record.assets.len() > 2000 || record.metadata.schema_version != 1 { return Err("merge_archive_corrupt".into()); }
    for (object, name) in record.objects.iter().zip(["base.md", "local.md", "disk.md", "result.md"]) { if object.name != name { return Err("merge_archive_corrupt".into()); } }
    if record.objects[0].hash != record.base_revision || record.objects[2].hash != record.disk_revision { return Err("merge_archive_corrupt".into()); }
    Ok((folder, record))
}
fn verify(root: &Path, record: &Record) -> Result<(Vec<Vec<u8>>, Vec<Asset>), String> {
    let mut bodies = vec![];
    for object in &record.objects { let bytes = read_object(root, object, MAX_TEXT)?; utf8(&bytes)?; bodies.push(bytes); }
    let mut total = 0usize; let mut names = BTreeSet::new(); let mut assets = vec![];
    for object in &record.assets {
        if !names.insert(object.name.to_lowercase()) { return Err("merge_archive_corrupt".into()); }
        total = total.checked_add(object.size).ok_or("quota_exceeded")?;
        if total > 128 * 1024 * 1024 { return Err("quota_exceeded".into()); }
        let bytes = read_object(root, object, 20 * 1024 * 1024)?;
        resources::verify_image(&bytes)?;
        assets.push(Asset { path: object.name.clone(), bytes });
    }
    for instance in &record.metadata.instances { resources::validate_instance(instance)?; }
    Ok((bodies, assets))
}
fn archive_usage(folder: &Path) -> Result<(u64, usize), String> {
    let mut bytes = 0u64; let mut count = 0;
    let mut pending = vec![folder.to_path_buf()]; let mut files = 0;
    while let Some(current) = pending.pop() {
        checked_document(&current)?;
        for entry in fs::read_dir(&current).map_err(|_| "io_failed")? {
            let path = entry.map_err(|_| "io_failed")?.path(); checked_document(&path)?;
            files += 1; if files > 20000 { return Err("merge_archive_quota".into()); }
            let info = fs::symlink_metadata(&path).map_err(|_| "io_failed")?;
            if info.is_dir() { if current == folder { count += 1; } pending.push(path); }
            else if info.is_file() { bytes += info.len(); }
            else { return Err("permission_denied".into()); }
            if bytes > MAX_ARCHIVE || count >= MAX_RECORDS { return Err("merge_archive_quota".into()); }
        }
    }
    Ok((bytes, count))
}
fn prepare(path: &Path, input: MergeInput) -> Result<Value, String> {
    prepare_with(path, input, || Ok(()))
}
fn prepare_with(path: &Path, input: MergeInput, after_archive: impl FnOnce() -> Result<(), String>) -> Result<Value, String> {
    for body in [&input.base, &input.local, &input.disk, &input.result] { utf8(body)?; }
    if transaction::hash(&input.base) != input.base_revision || transaction::hash(&input.disk) != input.disk_revision || input.references.len() != 4 || input.metadata.schema_version != 1 { return Err("invalid_data".into()); }
    check_revision(path, &input.disk_revision)?;
    // Existing images have no opened-byte witness in pre-v0.7 file sessions. Never assume path equality proves identity.
    if !input.references[0].references.is_empty() || !input.references[2].references.is_empty() || input.references.iter().any(|r| !r.unarchived_references.is_empty()) { return Err("merge_resources_unverified".into()); }
    let mut names = BTreeSet::new();
    let mut total = 0usize;
    for asset in &input.assets {
        if !names.insert(asset.path.clone()) { return Err("invalid_data".into()); }
        total = total.checked_add(asset.bytes.len()).ok_or("quota_exceeded")?;
    }
    if total > 128 * 1024 * 1024 || input.assets.len() > 2000 || input.metadata.instances.len() > 1000 { return Err("quota_exceeded".into()); }
    for refs in &input.references { for reference in &refs.references {
        if !names.contains(reference) || !input.metadata.instances.iter().any(|i| i["displayPath"].as_str() == Some(reference)) { return Err("merge_resources_unverified".into()); }
    } }
    for instance in &input.metadata.instances {
        resources::validate_instance(instance)?;
        for key in ["sourcePath", "displayPath"] { if !names.contains(instance[key].as_str().ok_or("invalid_data")?) { return Err("merge_resources_unverified".into()); } }
        let source = input.assets.iter().find(|a| a.path == instance["sourcePath"].as_str().unwrap()).ok_or("merge_resources_unverified")?;
        if instance["sourceHash"].as_str() != Some(transaction::hash(&source.bytes).as_str()) { return Err("merge_resources_unverified".into()); }
    }
    let root = path.parent().ok_or("invalid_data")?;
    let archive = resources::directory(root, BASE)?; checked_document(&archive)?;
    let (used, _) = archive_usage(&archive)?;
    let proposed = total as u64 + [&input.base, &input.local, &input.disk, &input.result].iter().map(|b| b.len() as u64).sum::<u64>() + 2 * 1024 * 1024;
    if used + proposed > MAX_ARCHIVE { return Err("merge_archive_quota".into()); }
    let operation = uuid::Uuid::new_v4().to_string();
    let staged = tempfile::tempdir_in(&archive).map_err(|_| "io_failed")?;
    let mut objects = vec![];
    for (name, bytes) in ["base.md", "local.md", "disk.md", "result.md"].iter().zip([&input.base, &input.local, &input.disk, &input.result]) {
        write_new(&staged.path().join(name), bytes)?;
        objects.push(Object { name: name.to_string(), hash: transaction::hash(bytes), size: bytes.len() });
    }
    resources::write_assets(staged.path(), &input.assets)?;
    let assets = input.assets.iter().map(|a| Object { name: a.path.clone(), hash: transaction::hash(&a.bytes), size: a.bytes.len() }).collect();
    let record = Record { schema_version: 1, operation_id: operation.clone(), document: path.file_name().ok_or("invalid_data")?.to_string_lossy().to_string(), created_at: SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "io_failed")?.as_millis() as u64, base_revision: input.base_revision, disk_revision: input.disk_revision, objects, assets, metadata: input.metadata };
    let bytes = serde_json::to_vec_pretty(&record).map_err(|_| "invalid_data")?;
    if bytes.len() > 2 * 1024 * 1024 { return Err("quota_exceeded".into()); }
    write_new(&staged.path().join("record.json"), &bytes)?;
    verify(staged.path(), &record)?;
    let destination = archive.join(&operation);
    fs::rename(staged.path(), &destination).map_err(|_| "io_failed")?;
    // A later conflict leaves the already-published recovery copies available.
    after_archive()?;
    check_revision(path, &record.disk_revision)?;
    Ok(json!({"operationId":operation,"recoveryPath":destination}))
}
fn commit(path: &Path, operation: &str) -> Result<Value, String> {
    let root = path.parent().ok_or("invalid_data")?;
    let document = path.file_name().ok_or("invalid_data")?.to_string_lossy();
    let (folder, record) = read_record(root, operation, &document)?;
    let (bodies, assets) = verify(&folder, &record)?;
    checked_document(path)?;
    // Validate asset collisions before committing any body. Existing source/display bytes are immutable.
    for asset in &assets { if root.join(&asset.path).exists() {
        let target = safe(root, &asset.path)?;
        if fs::metadata(&target).map_err(|_| "io_failed")?.len() > 20 * 1024 * 1024 || transaction::hash(&fs::read(target).map_err(|_| "io_failed")?) != transaction::hash(&asset.bytes) { return Err("merge_resources_unverified".into()); }
    } }
    if !record.metadata.instances.is_empty() && root.join(".easym/images.json").exists() {
        let existing = resources::read_metadata(root).0.ok_or("merge_resources_unverified")?;
        for incoming in &record.metadata.instances {
            if existing.instances.iter().any(|previous| previous["displayPath"] == incoming["displayPath"] && previous != incoming) { return Err("merge_resources_unverified".into()); }
        }
    }
    let warning = transaction::save(path, Some(&record.disk_revision), &bodies[3], &assets, record.metadata, operation)?;
    Ok(json!({"revision":transaction::hash(&bodies[3]),"warning":warning,"recoveryPath":folder}))
}
fn records(path: &Path) -> Result<Value, String> {
    let root = path.parent().ok_or("invalid_data")?;
    if !root.join(BASE).exists() { return Ok(json!({"records":[],"warnings":[]})); }
    let folder = safe(root, BASE)?;
    let document = path.file_name().ok_or("invalid_data")?.to_string_lossy();
    let mut values = vec![]; let mut warnings = vec![];
    for (index, entry) in fs::read_dir(&folder).map_err(|_| "io_failed")?.enumerate() {
        if index > 1000 { return Err("merge_archive_quota".into()); }
        let entry = entry.map_err(|_| "io_failed")?; let name = entry.file_name().to_string_lossy().to_string();
        if uuid::Uuid::parse_str(&name).is_err() { continue; }
        match read_record(root, &name, &document) {
            Ok((folder, record)) => values.push(json!({"operationId":name,"createdAt":record.created_at,"recoveryPath":folder,"resultRevision":record.objects[3].hash})),
            Err(_) => warnings.push("有其他文档、损坏或不兼容的记录未列出；原始文件保持不变。"),
        }
    }
    values.sort_by_key(|v| std::cmp::Reverse(v["createdAt"].as_u64().unwrap_or(0)));
    warnings.dedup(); Ok(json!({"records":values,"warnings":warnings}))
}
fn restore_copy(path: &Path, operation: &str, side: &str, parent: &Path) -> Result<Value, String> {
    let index = match side { "base" => 0, "local" => 1, "disk" => 2, "result" => 3, _ => return Err("invalid_data".into()) };
    let root = path.parent().ok_or("invalid_data")?;
    let document = path.file_name().ok_or("invalid_data")?.to_string_lossy();
    let (folder, record) = read_record(root, operation, &document)?;
    let (bodies, assets) = verify(&folder, &record)?;
    checked_document(parent)?;
    let parent = parent.canonicalize().map_err(|_| "permission_denied")?;
    let destination = parent.join(format!("EasyM-recovered-{}", uuid::Uuid::new_v4()));
    let staged = tempfile::tempdir_in(&parent).map_err(|_| "io_failed")?;
    write_new(&staged.path().join(&record.document), &bodies[index])?;
    if index == 1 || index == 3 {
        resources::write_assets(staged.path(), &assets)?;
        if !record.metadata.instances.is_empty() {
            let easym = resources::directory(staged.path(), ".easym")?;
            write_new(&easym.join("images.json"), &serde_json::to_vec_pretty(&record.metadata).map_err(|_| "invalid_data")?)?;
        }
    }
    fs::rename(staged.path(), &destination).map_err(|_| "io_failed")?;
    Ok(json!({"path":destination.join(&record.document)}))
}

#[tauri::command]
pub async fn prepare_merge(state: State<'_, Storage>, id: String, input: MergeInput) -> Result<Value, String> {
    let storage = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let sessions = storage.0.lock().map_err(|_| "io_failed")?;
        prepare(sessions.get(&id).ok_or("permission_denied")?, input)
    }).await.map_err(|_| "io_failed".to_string())?
}
#[tauri::command]
pub async fn commit_merge(state: State<'_, Storage>, id: String, operation_id: String) -> Result<Value, String> {
    let storage = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let sessions = storage.0.lock().map_err(|_| "io_failed")?;
        commit(sessions.get(&id).ok_or("permission_denied")?, &operation_id)
    }).await.map_err(|_| "io_failed".to_string())?
}
#[tauri::command]
pub async fn merge_recovery(state: State<'_, Storage>, id: String, operation_id: Option<String>, side: Option<String>) -> Result<Value, String> {
    let storage = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let selected = if operation_id.is_some() { rfd::FileDialog::new().set_title("选择恢复副本的父目录（将新建目录）").pick_folder() } else { None };
        if operation_id.is_some() && selected.is_none() { return Ok(Value::Null); }
        let sessions = storage.0.lock().map_err(|_| "io_failed")?;
        let path = sessions.get(&id).ok_or("permission_denied")?;
        match operation_id { None => records(path), Some(operation) => restore_copy(path, &operation, side.as_deref().ok_or("invalid_data")?, &selected.unwrap()) }
    }).await.map_err(|_| "io_failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(base: &[u8], local: &[u8], disk: &[u8], result: &[u8]) -> MergeInput {
        MergeInput { base_revision: transaction::hash(base), disk_revision: transaction::hash(disk), base: base.to_vec(), local: local.to_vec(), disk: disk.to_vec(), result: result.to_vec(), references: (0..4).map(|_| References::default()).collect(), assets: vec![], metadata: Metadata { schema_version: 1, instances: vec![] } }
    }
    fn operation(value: &Value) -> &str { value["operationId"].as_str().unwrap() }
    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap(); let path = temp.path().canonicalize().unwrap().join("中文.md"); fs::write(&path, b"disk").unwrap(); (temp, path)
    }
    #[test]
    fn prepare_archives_exact_versions_without_writing_body_or_enabling_history() {
        let (_temp, path) = fixture();
        let value = prepare(&path, input(b"\xef\xbb\xbfbase\r\n", b"local\n", b"disk", b"merged")).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"disk");
        assert!(!path.parent().unwrap().join(".easym/history").exists());
        let (folder, record) = read_record(path.parent().unwrap(), operation(&value), "中文.md").unwrap();
        let (bodies, _) = verify(&folder, &record).unwrap();
        assert_eq!(bodies[0], b"\xef\xbb\xbfbase\r\n"); assert_eq!(bodies[1], b"local\n"); assert_eq!(bodies[2], b"disk");
        assert!(records(&path).unwrap()["records"].as_array().unwrap().len() == 1);
    }
    #[test]
    fn commit_uses_archived_candidate_can_retry_and_never_overwrites_a_newer_external_body() {
        let (_temp, path) = fixture(); let value = prepare(&path, input(b"base", b"local", b"disk", b"merged")).unwrap();
        commit(&path, operation(&value)).unwrap(); assert_eq!(fs::read(&path).unwrap(), b"merged");
        commit(&path, operation(&value)).unwrap();
        fs::write(&path, b"external newer").unwrap();
        assert_eq!(commit(&path, operation(&value)).unwrap_err(), "revision_conflict");
        assert_eq!(fs::read(&path).unwrap(), b"external newer");
    }
    #[test]
    fn external_write_between_prepare_and_commit_retains_both_recovery_copies() {
        let (_temp, path) = fixture(); let value = prepare(&path, input(b"base", b"local", b"disk", b"merged")).unwrap();
        fs::write(&path, b"racing disk").unwrap();
        assert_eq!(commit(&path, operation(&value)).unwrap_err(), "revision_conflict");
        let (folder, record) = read_record(path.parent().unwrap(), operation(&value), "中文.md").unwrap();
        let (bodies, _) = verify(&folder, &record).unwrap(); assert_eq!(bodies[1], b"local"); assert_eq!(bodies[2], b"disk");
        assert_eq!(fs::read(&path).unwrap(), b"racing disk");
    }
    #[test]
    fn interrupted_preparation_and_post_archive_race_preserve_original_and_published_record() {
        let (_temp, path) = fixture();
        assert!(prepare_with(&path, input(b"base", b"local", b"disk", b"merged"), || Err("simulated_crash".into())).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"disk");
        assert_eq!(records(&path).unwrap()["records"].as_array().unwrap().len(), 1);
        assert_eq!(prepare_with(&path, input(b"base", b"local", b"disk", b"merged"), || { fs::write(&path, b"raced").unwrap(); Ok(()) }).unwrap_err(), "revision_conflict");
        assert_eq!(fs::read(&path).unwrap(), b"raced");
    }
    #[test]
    fn archive_failure_and_corrupt_record_prevent_body_write() {
        let (_temp, path) = fixture(); let root = path.parent().unwrap();
        fs::write(root.join(".easym"), b"cannot create directory").unwrap();
        assert!(prepare(&path, input(b"base", b"local", b"disk", b"merged")).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"disk"); fs::remove_file(root.join(".easym")).unwrap();
        let value = prepare(&path, input(b"base", b"local", b"disk", b"merged")).unwrap();
        let folder = PathBuf::from(value["recoveryPath"].as_str().unwrap());
        fs::write(folder.join("local.md"), b"corrupt").unwrap();
        assert_eq!(commit(&path, operation(&value)).unwrap_err(), "merge_archive_corrupt");
        assert_eq!(fs::read(&path).unwrap(), b"disk");
        assert!(restore_copy(&path, operation(&value), "local", root).is_err());
    }
    #[test]
    fn restore_copies_survive_restart_and_do_not_overwrite_originals() {
        let (_temp, path) = fixture(); let value = prepare(&path, input(b"base", b"local", b"disk", b"merged")).unwrap();
        let operation = operation(&value).to_string(); drop(value);
        let target = tempfile::tempdir().unwrap();
        for (side, expected) in [("base", "base"), ("local", "local"), ("disk", "disk"), ("result", "merged")] {
            let copy = restore_copy(&path, &operation, side, &target.path().canonicalize().unwrap()).unwrap();
            assert_eq!(fs::read_to_string(copy["path"].as_str().unwrap()).unwrap(), expected);
        }
        assert_eq!(fs::read_dir(target.path()).unwrap().count(), 4); assert_eq!(fs::read(&path).unwrap(), b"disk");
    }
    #[test]
    fn invalid_inputs_unknown_formats_and_quota_are_rejected() {
        let (_temp, path) = fixture(); let root = path.parent().unwrap();
        let mut invalid = input(b"base", b"local", b"disk", b"merged"); invalid.base_revision = "forged".into();
        assert_eq!(prepare(&path, invalid).unwrap_err(), "invalid_data");
        assert!(prepare(&path, input(b"base", b"local", b"disk", &[0xff])).is_err());
        let value = prepare(&path, input(b"base", b"local", b"disk", b"merged")).unwrap();
        let manifest = PathBuf::from(value["recoveryPath"].as_str().unwrap()).join("record.json");
        let mut record: Value = serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap(); record["schemaVersion"] = json!(2);
        fs::write(&manifest, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(commit(&path, operation(&value)).is_err());
        assert!(commit(&path, "../escape").is_err());
        let file = fs::File::create(root.join(BASE).join("huge")).unwrap(); file.set_len(MAX_ARCHIVE + 1).unwrap();
        assert_eq!(prepare(&path, input(b"base", b"local", b"disk", b"merged")).unwrap_err(), "merge_archive_quota");
        assert_eq!(fs::read(&path).unwrap(), b"disk");
    }
    #[test]
    fn existing_or_unverifiable_image_references_are_blocked() {
        let (_temp, path) = fixture();
        for side in [0, 2] { let mut value = input(b"base", b"local", b"disk", b"merged"); value.references[side].references.push("assets/img-a.png".into()); assert_eq!(prepare(&path, value).unwrap_err(), "merge_resources_unverified"); }
        let mut value = input(b"base", b"local", b"disk", b"merged"); value.references[1].unarchived_references.push("../outside.png".into());
        assert_eq!(prepare(&path, value).unwrap_err(), "merge_resources_unverified");
        assert_eq!(fs::read(&path).unwrap(), b"disk");
    }
    fn with_image() -> MergeInput {
        let mut value = input(b"base", b"![local](assets/img-a.png)", b"disk", b"![local](assets/img-a.png)\nmerged");
        let bytes = include_bytes!("../icons/32x32.png").to_vec();
        value.assets = vec![Asset { path: "assets/.originals/img-a.png".into(), bytes: bytes.clone() }, Asset { path: "assets/img-a.png".into(), bytes: bytes.clone() }];
        value.metadata.instances = vec![json!({"instanceId":"img-a","sourcePath":"assets/.originals/img-a.png","displayPath":"assets/img-a.png","sourceHash":transaction::hash(&bytes),"recipe":{"version":1}})];
        value.references[1].references.push("assets/img-a.png".into()); value.references[3].references.push("assets/img-a.png".into()); value
    }
    #[test]
    fn self_contained_local_images_are_archived_committed_and_recovered_immutably() {
        let (_temp, path) = fixture(); let value = prepare(&path, with_image()).unwrap();
        commit(&path, operation(&value)).unwrap();
        let root = path.parent().unwrap(); assert_eq!(fs::read(root.join("assets/img-a.png")).unwrap(), include_bytes!("../icons/32x32.png"));
        let target = tempfile::tempdir().unwrap(); let copy = restore_copy(&path, operation(&value), "local", &target.path().canonicalize().unwrap()).unwrap();
        let parent = Path::new(copy["path"].as_str().unwrap()).parent().unwrap();
        assert!(parent.join("assets/.originals/img-a.png").is_file()); assert!(parent.join(".easym/images.json").is_file());
        fs::write(root.join("assets/img-a.png"), include_bytes!("../icons/64x64.png")).unwrap();
        assert_eq!(commit(&path, operation(&value)).unwrap_err(), "merge_resources_unverified");
    }
    #[cfg(unix)]
    #[test]
    fn archive_symlink_never_expands_authorization() {
        let (_temp, path) = fixture(); let outside = tempfile::tempdir().unwrap();
        fs::create_dir(path.parent().unwrap().join(".easym")).unwrap();
        std::os::unix::fs::symlink(outside.path(), path.parent().unwrap().join(BASE)).unwrap();
        assert!(prepare(&path, input(b"base", b"local", b"disk", b"merged")).is_err());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }
}
