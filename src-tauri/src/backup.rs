//! Portable backups: native pickers grant access; archive paths are data only.
use std::{collections::{BTreeMap, BTreeSet}, fs, io::{Cursor, Read, Write}, path::{Path, PathBuf}, sync::{Arc, Mutex}, time::{SystemTime, UNIX_EPOCH}};
use serde::{Deserialize, Serialize};
use tauri::State;
use tempfile::NamedTempFile;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};
use crate::{history, resources::{self, Asset, Metadata}, storage::{checked_document, read_text, Storage}, transaction};

const MAX_TEXT: usize = 10 * 1024 * 1024;
const MAX_IMAGE: usize = 20 * 1024 * 1024;
const MAX_JSON: usize = 4 * 1024 * 1024;
const MAX_RESOURCES: usize = 128 * 1024 * 1024;
const MAX_ARCHIVE: usize = 256 * 1024 * 1024;
const MAX_FILES: usize = 10_000;
const TTL: u64 = 15 * 60 * 1000;
const MAGIC: &str = "easym-document-backup";
const META: &str = "document/.easym/images.json";
type Files = BTreeMap<String, Vec<u8>>;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInput {
    id: Option<String>, name: String, bytes: Vec<u8>, assets: Vec<Asset>,
    metadata: Metadata, references: Vec<String>, unarchived_references: Vec<String>,
    include_history: bool, expected_revision: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Object { path: String, hash: String, size: usize }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    format: String, schema_version: u32, producer_version: String, created_at: u64,
    document_name: String, encoding: String, line_ending: String,
    references: Vec<String>, includes_history: bool, objects: Vec<Object>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    document_name: String, created_at: u64, files: usize, bytes: usize,
    includes_history: bool, package_hash: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Review { text: String, available_references: Vec<String> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection { token: String, summary: BackupSummary, reviews: Vec<Review> }
#[derive(Clone)]
struct Ticket { path: PathBuf, hash: String, expires: u64 }
#[derive(Clone, Default)]
pub struct Backups(Arc<Mutex<BTreeMap<String, Ticket>>>);
struct Package { manifest: Manifest, files: Files, reviews: Vec<Review>, hash: String, size: usize }
impl Package {
    fn summary(&self) -> BackupSummary {
        BackupSummary { document_name: self.manifest.document_name.clone(), created_at: self.manifest.created_at,
            files: self.files.len() + 1, bytes: self.size, includes_history: self.manifest.includes_history, package_hash: self.hash.clone() }
    }
}
fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
fn safe_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > 512 || path.contains(['\\', ':', '<', '>', '"', '|', '?', '*']) || path.chars().any(char::is_control) { return Err("backup_corrupt".into()); }
    for part in path.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.ends_with([' ', '.']) { return Err("backup_corrupt".into()); }
        let base = part.split('.').next().unwrap_or("").trim_end_matches(' ').to_uppercase();
        if ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&base.as_str())
            || ["COM", "LPT"].iter().any(|prefix| base.strip_prefix(prefix).is_some_and(|n| ["1", "2", "3", "4", "5", "6", "7", "8", "9", "¹", "²", "³"].contains(&n))) { return Err("backup_corrupt".into()); }
    }
    Ok(())
}
fn document_name(name: &str) -> Result<(), String> {
    safe_path(name)?; let lower = name.to_ascii_lowercase();
    if name.contains('/') || !(lower.ends_with(".md") || lower.ends_with(".markdown")) { return Err("invalid_data".into()); } Ok(())
}
fn insert_name(names: &mut BTreeSet<String>, name: &str) -> Result<(), String> {
    safe_path(name)?; let lower = name.to_lowercase();
    if !names.insert(lower.clone()) { return Err("backup_corrupt".into()); }
    let mut prefix = lower.as_str();
    while let Some((parent, _)) = prefix.rsplit_once('/') { if names.contains(parent) { return Err("backup_corrupt".into()); } prefix = parent; }
    if names.range(format!("{lower}/")..).next().is_some_and(|p| p.starts_with(&format!("{lower}/"))) { return Err("backup_corrupt".into()); } Ok(())
}
fn image_path(path: &str) -> Result<(), String> {
    safe_path(path)?; let lower = path.to_lowercase();
    if lower.starts_with(".easym/") || ![".png", ".jpg", ".jpeg"].iter().any(|ext| lower.ends_with(ext)) { return Err("backup_resource_missing".into()); } Ok(())
}
fn read_bounded(path: &Path, max: usize) -> Result<Vec<u8>, String> {
    checked_document(path)?; let info = fs::metadata(path).map_err(|_| "resource_missing")?;
    if !info.is_file() || info.len() > max as u64 { return Err("quota_exceeded".into()); }
    let mut bytes = Vec::new();
    fs::File::open(path).map_err(|_| "permission_denied")?.take(max as u64 + 1).read_to_end(&mut bytes).map_err(|_| "io_failed")?;
    if bytes.len() > max { return Err("quota_exceeded".into()); } Ok(bytes)
}
fn limit(name: &str) -> usize {
    if name == "manifest.json" || name.ends_with(".json") { MAX_JSON }
    else if name.to_ascii_lowercase().ends_with(".md") || name.to_ascii_lowercase().ends_with(".markdown") { MAX_TEXT } else { MAX_IMAGE }
}
fn u16_at(raw: &[u8], at: usize) -> Result<usize, String> { Ok(u16::from_le_bytes(raw.get(at..at + 2).ok_or("backup_corrupt")?.try_into().map_err(|_| "backup_corrupt")?) as usize) }
fn u32_at(raw: &[u8], at: usize) -> Result<usize, String> { Ok(u32::from_le_bytes(raw.get(at..at + 4).ok_or("backup_corrupt")?.try_into().map_err(|_| "backup_corrupt")?) as usize) }
fn extras(raw: &[u8]) -> Result<(), String> {
    let mut at = 0;
    while at < raw.len() { let tag = u16_at(raw, at)?; let len = u16_at(raw, at + 2)?; if tag == 1 || at + 4 + len > raw.len() { return Err("backup_corrupt".into()); } at += 4 + len; } Ok(())
}
// Validate raw central entries first: zip's name map can hide duplicates.
fn preflight(raw: &[u8]) -> Result<usize, String> {
    if raw.len() < 22 || raw.len() > MAX_ARCHIVE { return Err("backup_corrupt".into()); }
    let end = (raw.len().saturating_sub(65557)..=raw.len() - 22).rev().find(|&p| raw.get(p..p + 4) == Some(b"PK\x05\x06") && u16_at(raw, p + 20).is_ok_and(|n| p + 22 + n == raw.len())).ok_or("backup_corrupt")?;
    let count = u16_at(raw, end + 10)?; let start = u32_at(raw, end + 16)?;
    if u16_at(raw, end + 4)? != 0 || u16_at(raw, end + 6)? != 0 || u16_at(raw, end + 8)? != count || count == 0 || count > MAX_FILES || start + u32_at(raw, end + 12)? != end { return Err("backup_corrupt".into()); }
    let mut at = start; let mut total = 0usize; let mut names = BTreeSet::new(); let mut extents = Vec::new();
    for _ in 0..count {
        if raw.get(at..at + 4) != Some(b"PK\x01\x02") || u16_at(raw, at + 6)? > 20 { return Err("backup_corrupt".into()); }
        let flags = u16_at(raw, at + 8)?; let method = u16_at(raw, at + 10)?;
        let compressed = u32_at(raw, at + 20)?; let size = u32_at(raw, at + 24)?;
        let n = u16_at(raw, at + 28)?; let x = u16_at(raw, at + 30)?; let c = u16_at(raw, at + 32)?;
        let attributes = u32_at(raw, at + 38)?; let local = u32_at(raw, at + 42)?;
        let name_bytes = raw.get(at + 46..at + 46 + n).ok_or("backup_corrupt")?;
        let name = std::str::from_utf8(name_bytes).map_err(|_| "backup_corrupt")?; insert_name(&mut names, name)?;
        if flags & !0x080e != 0 || ![0, 8].contains(&method) || u16_at(raw, at + 34)? != 0 || attributes & 0x10 != 0 || ![0, 0x8000].contains(&((attributes >> 16) & 0xf000)) { return Err("backup_corrupt".into()); }
        if size > limit(name) || compressed > MAX_ARCHIVE || size > compressed.saturating_mul(200).saturating_add(1024 * 1024) { return Err("quota_exceeded".into()); }
        total = total.checked_add(size).ok_or("quota_exceeded")?; if total > MAX_ARCHIVE { return Err("quota_exceeded".into()); }
        extras(raw.get(at + 46 + n..at + 46 + n + x).ok_or("backup_corrupt")?)?;
        if raw.get(local..local + 4) != Some(b"PK\x03\x04") || u16_at(raw, local + 4)? > 20 || u16_at(raw, local + 6)? != flags || u16_at(raw, local + 8)? != method { return Err("backup_corrupt".into()); }
        let ln = u16_at(raw, local + 26)?; let lx = u16_at(raw, local + 28)?;
        if raw.get(local + 30..local + 30 + ln) != Some(name_bytes) { return Err("backup_corrupt".into()); }
        extras(raw.get(local + 30 + ln..local + 30 + ln + lx).ok_or("backup_corrupt")?)?;
        let mut finish = local.checked_add(30 + ln + lx + compressed).ok_or("backup_corrupt")?;
        if flags & 8 == 0 {
            if u32_at(raw, local + 14)? != u32_at(raw, at + 16)? || u32_at(raw, local + 18)? != compressed || u32_at(raw, local + 22)? != size { return Err("backup_corrupt".into()); }
        } else {
            let descriptor = finish + if raw.get(finish..finish + 4) == Some(b"PK\x07\x08") { 4 } else { 0 };
            if u32_at(raw, descriptor)? != u32_at(raw, at + 16)? || u32_at(raw, descriptor + 4)? != compressed || u32_at(raw, descriptor + 8)? != size { return Err("backup_corrupt".into()); } finish = descriptor + 12;
        }
        if finish > start { return Err("backup_corrupt".into()); }
        extents.push((local, finish)); at += 46 + n + x + c; if at > end { return Err("backup_corrupt".into()); }
    }
    extents.sort_unstable();
    if at != end || extents.first().is_none_or(|x| x.0 != 0) || extents.last().is_none_or(|x| x.1 != start) || extents.windows(2).any(|w| w[0].1 != w[1].0) { return Err("backup_corrupt".into()); } Ok(count)
}
fn stage_files(root: &Path, files: &Files) -> Result<(), String> {
    for (name, bytes) in files {
        let relative = name.strip_prefix("document/").ok_or("backup_corrupt")?; safe_path(relative)?;
        let target = root.join(relative); let parent = target.parent().ok_or("backup_corrupt")?;
        fs::create_dir_all(parent).map_err(|_| "io_failed")?; checked_document(parent)?;
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&target).map_err(|_| "io_failed")?;
        file.write_all(bytes).map_err(|_| "io_failed")?; file.sync_all().map_err(|_| "io_failed")?;
        if read_bounded(&target, bytes.len())? != *bytes { return Err("io_failed".into()); }
    } Ok(())
}
fn verify_payload(manifest: &Manifest, files: &Files) -> Result<Vec<Review>, String> {
    document_name(&manifest.document_name)?;
    if files.len() != manifest.objects.len() || files.len() >= MAX_FILES || manifest.references.len() > 4096 { return Err("backup_corrupt".into()); }
    let mut names = BTreeSet::new(); let mut total = 0usize;
    for item in &manifest.objects {
        insert_name(&mut names, &item.path)?; let bytes = files.get(&item.path).ok_or("backup_corrupt")?;
        if !item.path.starts_with("document/") || bytes.len() != item.size || transaction::hash(bytes) != item.hash { return Err("backup_corrupt".into()); }
        if bytes.len() > limit(&item.path) { return Err("quota_exceeded".into()); }
        total += bytes.len(); if total > MAX_ARCHIVE { return Err("quota_exceeded".into()); }
    }
    let body_path = format!("document/{}", manifest.document_name); let body = files.get(&body_path).ok_or("backup_corrupt")?;
    if history::text_format(body)? != (manifest.encoding.clone(), manifest.line_ending.clone()) { return Err("backup_corrupt".into()); }
    let metadata: Metadata = serde_json::from_slice(files.get(META).ok_or("backup_corrupt")?).map_err(|_| "backup_corrupt")?;
    if metadata.schema_version != 1 { return Err("backup_read_only".into()); }
    if metadata.instances.len() > 4096 { return Err("quota_exceeded".into()); }
    let refs: BTreeSet<_> = manifest.references.iter().cloned().collect(); if refs.len() != manifest.references.len() { return Err("backup_corrupt".into()); }
    let mut required = refs.clone(); let mut displays = BTreeSet::new();
    for instance in &metadata.instances {
        resources::validate_instance(instance)?;
        let source = instance["sourcePath"].as_str().ok_or("backup_corrupt")?; let display = instance["displayPath"].as_str().ok_or("backup_corrupt")?;
        if !refs.contains(display) || !displays.insert(display) { return Err("backup_corrupt".into()); }
        required.insert(source.into()); required.insert(display.into());
        let bytes = files.get(&format!("document/{source}")).ok_or("backup_resource_missing")?;
        if instance["sourceHash"].as_str() != Some(transaction::hash(bytes).as_str()) { return Err("backup_corrupt".into()); }
    }
    let mut expected = BTreeSet::from([body_path, META.into()]); let mut image_total = 0usize;
    for path in required {
        image_path(&path)?; let name = format!("document/{path}"); let bytes = files.get(&name).ok_or("backup_resource_missing")?;
        resources::verify_image(bytes)?; image_total += bytes.len(); if image_total > MAX_RESOURCES { return Err("quota_exceeded".into()); } expected.insert(name);
    }
    let mut reviews = vec![Review { text: String::from_utf8(body.clone()).map_err(|_| "backup_corrupt")?, available_references: manifest.references.clone() }];
    let history_files: BTreeSet<_> = files.keys().filter_map(|p| p.strip_prefix("document/").filter(|s| s.starts_with(".easym/history/")).map(str::to_string)).collect();
    if manifest.includes_history {
        let staged = tempfile::tempdir().map_err(|_| "io_failed")?;
        // macOS temporary directories can contain system aliases such as /var.
        // Resolve our private staging root before applying canonical-path checks.
        let root = staged.path().canonicalize().map_err(|_| "io_failed")?;
        let subset: Files = history_files.iter().map(|p| (format!("document/{p}"), files[&format!("document/{p}")].clone())).collect(); stage_files(&root, &subset)?;
        for (text, paths) in history::validate_portable_history(&root, &manifest.document_name, &history_files)? {
            for path in &paths { image_path(path)?; } reviews.push(Review { text, available_references: paths });
        } expected.extend(subset.keys().cloned());
    } else if !history_files.is_empty() { return Err("backup_corrupt".into()); }
    if expected != files.keys().cloned().collect() { return Err("backup_corrupt".into()); } Ok(reviews)
}
fn decode(raw: &[u8]) -> Result<Package, String> {
    let count = preflight(raw)?; let mut zip = ZipArchive::new(Cursor::new(raw)).map_err(|_| "backup_corrupt")?;
    if zip.len() != count || zip.offset() != 0 { return Err("backup_corrupt".into()); }
    let mut files = Files::new(); let mut total = 0usize;
    for i in 0..count {
        let file = zip.by_index(i).map_err(|_| "backup_corrupt")?; let name = file.name().to_string(); let size = file.size() as usize;
        let mut bytes = Vec::new(); file.take(limit(&name) as u64 + 1).read_to_end(&mut bytes).map_err(|_| "backup_corrupt")?;
        if bytes.len() != size || size > limit(&name) { return Err("backup_corrupt".into()); }
        total += size; if total > MAX_ARCHIVE { return Err("quota_exceeded".into()); }
        if files.insert(name, bytes).is_some() { return Err("backup_corrupt".into()); }
    }
    let bytes = files.remove("manifest.json").ok_or("backup_corrupt")?; let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "backup_corrupt")?;
    if value["format"] != MAGIC || value["schemaVersion"] != 1 { return Err("backup_read_only".into()); }
    let manifest: Manifest = serde_json::from_value(value).map_err(|_| "backup_corrupt")?; let reviews = verify_payload(&manifest, &files)?;
    Ok(Package { manifest, files, reviews, hash: transaction::hash(raw), size: raw.len() })
}
fn encode(manifest: &Manifest, files: &Files) -> Result<Vec<u8>, String> {
    let json = serde_json::to_vec_pretty(manifest).map_err(|_| "invalid_data")?; if json.len() > MAX_JSON { return Err("quota_exceeded".into()); }
    let mut zip = ZipWriter::new(Cursor::new(Vec::new())); let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored).unix_permissions(0o600);
    for (path, bytes) in std::iter::once(("manifest.json", json.as_slice())).chain(files.iter().map(|(p, b)| (p.as_str(), b.as_slice()))) {
        zip.start_file(path, options).map_err(|_| "io_failed")?; zip.write_all(bytes).map_err(|_| "io_failed")?;
    }
    let raw = zip.finish().map_err(|_| "io_failed")?.into_inner(); if raw.len() > MAX_ARCHIVE { return Err("quota_exceeded".into()); } Ok(raw)
}
fn revision(path: Option<&Path>, expected: Option<&str>) -> Result<(), String> {
    if let Some(path) = path { checked_document(path)?; if Some(transaction::hash(&read_text(path)?).as_str()) != expected { return Err("revision_conflict".into()); } }
    else if expected.is_some() { return Err("invalid_data".into()); } Ok(())
}
fn build(input: &BackupInput, path: Option<&Path>) -> Result<(Vec<u8>, BTreeMap<String, String>), String> {
    document_name(&input.name)?; revision(path, input.expected_revision.as_deref())?;
    if !input.unarchived_references.is_empty() { return Err("backup_resource_missing".into()); }
    let (encoding, line_ending) = history::text_format(&input.bytes)?;
    if input.references.len() > 4096 || input.assets.len() > 4096 || input.metadata.instances.len() > 4096 { return Err("quota_exceeded".into()); }
    let refs: BTreeSet<_> = input.references.iter().cloned().collect(); if refs.len() != input.references.len() { return Err("invalid_data".into()); }
    let mut paths = refs.clone();
    for instance in &input.metadata.instances {
        resources::validate_instance(instance)?;
        if !refs.contains(instance["displayPath"].as_str().ok_or("invalid_data")?) { return Err("invalid_data".into()); } paths.insert(instance["sourcePath"].as_str().ok_or("invalid_data")?.to_string());
    }
    let mut supplied = BTreeMap::new(); let mut sum = 0usize;
    for asset in &input.assets {
        sum = sum.checked_add(asset.bytes.len()).ok_or("quota_exceeded")?; if sum > MAX_RESOURCES { return Err("quota_exceeded".into()); }
        if !paths.contains(&asset.path) || supplied.insert(asset.path.clone(), &asset.bytes).is_some() { return Err("invalid_data".into()); }
    }
    let mut files = Files::new(); let mut disk_assets = BTreeMap::new(); let mut image_total = 0usize; files.insert(format!("document/{}", input.name), input.bytes.clone());
    let meta = serde_json::to_vec_pretty(&input.metadata).map_err(|_| "invalid_data")?; if meta.len() > MAX_JSON { return Err("quota_exceeded".into()); } files.insert(META.into(), meta);
    for relative in paths {
        image_path(&relative)?;
        let bytes = if let Some(bytes) = supplied.get(&relative) { (*bytes).clone() } else {
            let root = path.and_then(Path::parent).ok_or("backup_resource_missing")?; let source = resources::safe_existing(root, &relative).map_err(|_| "backup_resource_missing")?;
            let bytes = read_bounded(&source, MAX_IMAGE)?; disk_assets.insert(relative.clone(), transaction::hash(&bytes)); bytes
        };
        resources::verify_image(&bytes)?; image_total += bytes.len(); if image_total > MAX_RESOURCES { return Err("quota_exceeded".into()); } files.insert(format!("document/{relative}"), bytes);
    }
    if input.include_history { for (relative, bytes) in history::portable_history(path.ok_or("history_disabled")?)? { files.insert(format!("document/{relative}"), bytes); } }
    let objects = files.iter().map(|(path, bytes)| Object { path: path.clone(), hash: transaction::hash(bytes), size: bytes.len() }).collect();
    let manifest = Manifest { format: MAGIC.into(), schema_version: 1, producer_version: env!("CARGO_PKG_VERSION").into(), created_at: now(), document_name: input.name.clone(), encoding, line_ending, references: input.references.clone(), includes_history: input.include_history, objects };
    verify_payload(&manifest, &files)?; Ok((encode(&manifest, &files)?, disk_assets))
}
fn publish_backup(target: &Path, raw: &[u8], input: &BackupInput, path: Option<&Path>, disk_assets: &BTreeMap<String, String>) -> Result<BackupSummary, String> {
    if !target.to_string_lossy().to_ascii_lowercase().ends_with(".easym-backup.zip") { return Err("backup_extension".into()); }
    let parent = target.parent().ok_or("permission_denied")?; checked_document(parent)?; if fs::symlink_metadata(target).is_ok() { return Err("backup_exists".into()); }
    let mut staged = NamedTempFile::new_in(parent).map_err(|_| "io_failed")?; staged.write_all(raw).map_err(|_| "io_failed")?; staged.as_file().sync_all().map_err(|_| "io_failed")?;
    let package = decode(&read_bounded(staged.path(), MAX_ARCHIVE)?)?; revision(path, input.expected_revision.as_deref())?;
    for (relative, expected) in disk_assets {
        let root = path.and_then(Path::parent).ok_or("permission_denied")?; let source = resources::safe_existing(root, relative)?;
        if transaction::hash(&read_bounded(&source, MAX_IMAGE)?) != *expected { return Err("revision_conflict".into()); }
    }
    checked_document(parent)?; staged.persist_noclobber(target).map_err(|error| if error.error.kind() == std::io::ErrorKind::AlreadyExists { "backup_exists" } else { "io_failed" })?; Ok(package.summary())
}
fn review_references(package: &Package, references: &[Vec<String>]) -> Result<(), String> {
    if references.len() != package.reviews.len() { return Err("backup_corrupt".into()); }
    for (i, (review, refs)) in package.reviews.iter().zip(references).enumerate() {
        let supplied: BTreeSet<_> = refs.iter().collect(); let available: BTreeSet<_> = review.available_references.iter().collect();
        if supplied.len() != refs.len() || (i == 0 && supplied != available) || !supplied.is_subset(&available) { return Err("backup_resource_missing".into()); }
    } Ok(())
}
fn restore_into(package: &Package, parent: &Path) -> Result<String, String> {
    checked_document(parent)?; let staged = tempfile::Builder::new().prefix(".easym-restore-").tempdir_in(parent).map_err(|_| "io_failed")?; stage_files(staged.path(), &package.files)?;
    let mut readback = Files::new();
    for name in package.files.keys() { readback.insert(name.clone(), read_bounded(&staged.path().join(name.strip_prefix("document/").ok_or("backup_corrupt")?), limit(name))?); }
    verify_payload(&package.manifest, &readback)?; checked_document(parent)?;
    let target = parent.join(format!("EasyM-restored-{}", uuid::Uuid::new_v4())); if fs::symlink_metadata(&target).is_ok() { return Err("backup_exists".into()); }
    fs::rename(staged.path(), &target).map_err(|_| "io_failed")?; Ok(target.join(&package.manifest.document_name).to_string_lossy().into())
}
fn insert_ticket(backups: &Backups, path: PathBuf, hash: String) -> Result<String, String> {
    let mut tickets = backups.0.lock().map_err(|_| "io_failed")?; tickets.retain(|_, t| t.expires > now()); if tickets.len() >= 4 { return Err("backup_sessions_full".into()); }
    let token = uuid::Uuid::new_v4().to_string(); tickets.insert(token.clone(), Ticket { path, hash, expires: now() + TTL }); Ok(token)
}
fn ticket(backups: &Backups, token: &str) -> Result<Ticket, String> {
    let mut tickets = backups.0.lock().map_err(|_| "io_failed")?; tickets.retain(|_, t| t.expires > now()); tickets.get(token).cloned().ok_or("backup_expired".into())
}
fn reread(ticket: &Ticket) -> Result<Package, String> {
    let raw = read_bounded(&ticket.path, MAX_ARCHIVE)?; if transaction::hash(&raw) != ticket.hash { return Err("backup_changed".into()); } decode(&raw)
}
#[tauri::command]
pub async fn create_document_backup(state: State<'_, Storage>, input: BackupInput) -> Result<Option<BackupSummary>, String> {
    let storage = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        document_name(&input.name)?; let filename = format!("{}.easym-backup.zip", Path::new(&input.name).file_stem().and_then(|s| s.to_str()).ok_or("invalid_data")?);
        let Some(target) = rfd::FileDialog::new().add_filter("EasyM 文档备份", &["easym-backup.zip"]).set_file_name(filename).save_file() else { return Ok(None); };
        // A fresh picker grants the resolved location; later checks must not
        // resolve again and silently follow a replaced parent link.
        let parent = target.parent().ok_or("permission_denied")?.canonicalize().map_err(|_| "permission_denied")?;
        let target = parent.join(target.file_name().ok_or("invalid_data")?);
        let sessions = storage.0.lock().map_err(|_| "io_failed")?; let path = input.id.as_ref().map(|id| sessions.get(id).map(PathBuf::as_path).ok_or("permission_denied")).transpose()?;
        let (raw, disk_assets) = build(&input, path)?; Ok(Some(publish_backup(&target, &raw, &input, path, &disk_assets)?))
    }).await.map_err(|_| "io_failed".to_string())?
}
#[tauri::command]
pub async fn inspect_document_backup(state: State<'_, Backups>) -> Result<Option<Inspection>, String> {
    let backups = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = rfd::FileDialog::new().add_filter("EasyM 文档备份", &["easym-backup.zip"]).pick_file() else { return Ok(None); };
        let path = path.canonicalize().map_err(|_| "resource_missing")?;
        let package = decode(&read_bounded(&path, MAX_ARCHIVE)?)?; let token = insert_ticket(&backups, path, package.hash.clone())?;
        Ok(Some(Inspection { token, summary: package.summary(), reviews: package.reviews }))
    }).await.map_err(|_| "io_failed".to_string())?
}
#[tauri::command]
pub async fn restore_document_backup(state: State<'_, Backups>, token: String, references: Vec<Vec<String>>) -> Result<Option<String>, String> {
    let backups = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        ticket(&backups, &token)?; let Some(parent) = rfd::FileDialog::new().set_title("选择恢复到的父目录").pick_folder() else { return Ok(None); };
        let parent = parent.canonicalize().map_err(|_| "permission_denied")?;
        let mut tickets = backups.0.lock().map_err(|_| "io_failed")?; let grant = tickets.get(&token).filter(|t| t.expires > now()).ok_or("backup_expired")?;
        let package = reread(grant)?; review_references(&package, &references)?; let restored = restore_into(&package, &parent)?; tickets.remove(&token); Ok(Some(restored))
    }).await.map_err(|_| "io_failed".to_string())?
}
#[tauri::command]
pub fn release_document_backup(state: State<'_, Backups>, token: String) -> Result<(), String> { state.0.lock().map_err(|_| "io_failed")?.remove(&token); Ok(()) }

#[cfg(test)]
mod tests {
    use super::*;
    fn tempdir() -> tempfile::TempDir {
        // Match native picker grants, including on macOS where the default
        // temporary directory may be reached through a system symlink.
        let root = std::env::temp_dir().canonicalize().unwrap();
        tempfile::Builder::new().tempdir_in(root).unwrap()
    }
    fn input(bytes: &[u8]) -> BackupInput {
        BackupInput { id: None, name: "中文 note.md".into(), bytes: bytes.into(), assets: vec![], metadata: Metadata { schema_version: 1, instances: vec![] }, references: vec![], unarchived_references: vec![], include_history: false, expected_revision: None }
    }
    fn package(input: &BackupInput) -> Package { decode(&build(input, None).unwrap().0).unwrap() }
    fn with_objects(manifest: &Manifest, files: &Files) -> Manifest {
        let mut m = manifest.clone(); m.objects = files.iter().map(|(path, bytes)| Object { path: path.clone(), hash: transaction::hash(bytes), size: bytes.len() }).collect(); m
    }
    fn zip_files(files: &[(&str, &[u8])], method: CompressionMethod) -> Vec<u8> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in files { writer.start_file(*name, SimpleFileOptions::default().compression_method(method)).unwrap(); writer.write_all(bytes).unwrap(); }
        writer.finish().unwrap().into_inner()
    }
    fn central(raw: &[u8]) -> usize { raw.windows(4).position(|v| v == b"PK\x01\x02").unwrap() }
    #[test]
    fn exact_bytes_round_trip_and_restore_separate_directories() {
        let temp = tempdir();
        let original = temp.path().join("original.md"); fs::write(&original, b"untouched").unwrap();
        for bytes in [b"".as_slice(), "正文 😀\n".as_bytes(), b"\xef\xbb\xbf# title\r\n", b"a\r\nb\n"] {
            let p = package(&input(bytes));
            let a = PathBuf::from(restore_into(&p, temp.path()).unwrap()); let b = PathBuf::from(restore_into(&p, temp.path()).unwrap());
            assert_ne!(a, b); assert_eq!(fs::read(a).unwrap(), bytes); assert_eq!(fs::read(b).unwrap(), bytes);
        }
        assert_eq!(fs::read(original).unwrap(), b"untouched");
        assert!(!fs::read_dir(temp.path()).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with(".easym-restore-")));
    }
    #[test]
    fn images_and_managed_originals_round_trip_without_unrelated_assets() {
        let bytes = include_bytes!("../icons/32x32.png").to_vec(); let mut data = input(b"![a](assets/img-a.png)");
        data.references = vec!["assets/img-a.png".into()];
        data.assets = vec![Asset { path: "assets/img-a.png".into(), bytes: bytes.clone() }, Asset { path: "assets/.originals/img-a.png".into(), bytes: bytes.clone() }];
        data.metadata.instances = vec![serde_json::json!({"instanceId":"id","documentId":null,"sourcePath":"assets/.originals/img-a.png","displayPath":"assets/img-a.png","sourceHash":transaction::hash(&bytes),"referenceRevision":1,"recipe":{"version":1}})];
        let p = package(&data); let temp = tempdir(); let restored = PathBuf::from(restore_into(&p, temp.path()).unwrap());
        assert_eq!(fs::read(restored.parent().unwrap().join("assets/.originals/img-a.png")).unwrap(), bytes);
        assert_eq!(p.files.len(), 4);
        data.assets.push(Asset { path: "unused.png".into(), bytes: bytes.clone() }); assert!(build(&data, None).is_err()); data.assets.pop();
        data.metadata.instances[0]["sourceHash"] = serde_json::json!("bad"); assert!(build(&data, None).is_err());
    }
    #[test]
    fn history_backup_round_trip_retains_only_current_registered_document() {
        use serde_json::json;
        let temp = tempdir(); let root = temp.path().canonicalize().unwrap();
        let mut data = input(b"current draft\r\n"); let path = root.join(&data.name); fs::write(&path, b"disk").unwrap();
        data.expected_revision = Some(transaction::hash(b"disk")); data.include_history = true;
        let doc = uuid::Uuid::new_v4().to_string(); let snap = uuid::Uuid::new_v4().to_string();
        let body = b"historical ![a](old.png)\n"; let image = include_bytes!("../icons/32x32.png");
        let body_hash = transaction::hash(body).trim_start_matches("sha256:").to_string();
        let image_hash = transaction::hash(image).trim_start_matches("sha256:").to_string();
        let history = root.join(".easym/history"); fs::create_dir_all(history.join(format!("documents/{doc}/snapshots"))).unwrap(); fs::create_dir_all(history.join("objects")).unwrap();
        let index = json!({"schemaVersion":1,"budgetBytes":536870912,"deleted":[],"documents":{
            (data.name.clone()):{"documentId":doc,"enabled":true,"snapshots":[snap],"annotations":{(snap.clone()):{"name":"keep me","pinned":true}}},
            "private.md":{"documentId":uuid::Uuid::new_v4().to_string(),"enabled":true,"snapshots":[],"annotations":{}}
        }});
        let manifest = json!({"schemaVersion":1,"snapshotId":snap,"documentId":doc,"parentSnapshotId":null,"createdAt":1,"reason":"manual",
            "bodyHash":body_hash,"bodySize":body.len(),"encoding":"utf-8","lineEnding":"lf","diskRevision":null,"complete":true,
            "resources":[{"path":"old.png","hash":image_hash,"size":image.len(),"mime":"image/png","role":"plain-reference","missing":false}],
            "metadata":{"schemaVersion":1,"instances":[]}});
        fs::write(history.join("index.json"), serde_json::to_vec(&index).unwrap()).unwrap();
        fs::write(history.join(format!("documents/{doc}/snapshots/{snap}.json")), serde_json::to_vec(&manifest).unwrap()).unwrap();
        fs::write(history.join(format!("objects/{body_hash}")), body).unwrap(); fs::write(history.join(format!("objects/{image_hash}")), image).unwrap();
        fs::write(history.join("private.txt"), b"not registered").unwrap();
        let package = decode(&build(&data, Some(&path)).unwrap().0).unwrap();
        assert!(package.summary().includes_history); assert_eq!(package.reviews.len(), 2);
        review_references(&package, &[vec![], vec!["old.png".into()]]).unwrap();
        let restored = PathBuf::from(restore_into(&package, &root).unwrap()); let destination = restored.parent().unwrap();
        assert_eq!(fs::read(&restored).unwrap(), data.bytes); assert_eq!(fs::read(&path).unwrap(), b"disk");
        assert_eq!(history::portable_history(&restored).unwrap().len(), 4);
        let imported: serde_json::Value = serde_json::from_slice(&fs::read(destination.join(".easym/history/index.json")).unwrap()).unwrap();
        assert_eq!(imported["documents"].as_object().unwrap().len(), 1);
        assert_eq!(imported["documents"][&data.name]["annotations"][&snap]["name"], "keep me");
        assert_eq!(imported["documents"][&data.name]["annotations"][&snap]["pinned"], true);
        assert!(!destination.join(".easym/history/private.txt").exists());
        data.include_history = false; let without = decode(&build(&data, Some(&path)).unwrap().0).unwrap();
        assert_eq!(without.reviews.len(), 1); assert!(!without.files.keys().any(|p| p.starts_with("document/.easym/history/")));
    }
    #[test]
    fn missing_unsafe_oversized_and_unsupported_images_block_creation() {
        let mut data = input(b"![a](image.png)"); data.references = vec!["image.png".into()]; assert!(build(&data, None).is_err());
        for path in ["../image.png", "/image.png", "image.svg", ".easym/image.png"] { data.references = vec![path.into()]; assert!(build(&data, None).is_err()); }
        data.references.clear(); data.unarchived_references = vec!["file:///image.png".into()]; assert!(build(&data, None).is_err());
        assert!(build(&input(&vec![b'x'; MAX_TEXT + 1]), None).is_err());
        data = input(b"![a](image.png)"); data.references = vec!["image.png".into()]; data.assets = vec![Asset { path: "image.png".into(), bytes: b"not png".to_vec() }]; assert!(build(&data, None).is_err());
    }
    #[test]
    fn disk_revision_and_images_are_rechecked_before_atomic_publication() {
        let temp = tempdir(); let path = temp.path().canonicalize().unwrap().join("source.md"); fs::write(&path, b"disk").unwrap();
        fs::write(temp.path().join("pic.png"), include_bytes!("../icons/32x32.png")).unwrap();
        let mut data = input(b"![p](pic.png)"); data.expected_revision = Some(transaction::hash(b"disk")); data.references = vec!["pic.png".into()];
        let (raw, assets) = build(&data, Some(&path)).unwrap(); let target = temp.path().join("copy.easym-backup.zip");
        fs::write(&path, b"changed").unwrap(); assert!(publish_backup(&target, &raw, &data, Some(&path), &assets).is_err()); assert!(!target.exists());
        fs::write(&path, b"disk").unwrap(); fs::write(temp.path().join("pic.png"), b"changed").unwrap();
        assert!(publish_backup(&target, &raw, &data, Some(&path), &assets).is_err()); assert!(!target.exists());
        assert!(build(&data, Some(&path)).is_err());
    }
    #[test]
    fn backup_file_never_overwrites_existing_and_rejects_invalid_extension() {
        let temp = tempdir(); let data = input(b"current"); let (raw, assets) = build(&data, None).unwrap();
        let target = temp.path().join("copy.easym-backup.zip"); publish_backup(&target, &raw, &data, None, &assets).unwrap();
        assert_eq!(fs::read(&target).unwrap(), raw); assert!(publish_backup(&target, &raw, &data, None, &assets).is_err());
        assert!(publish_backup(&temp.path().join("bad.zip"), &raw, &data, None, &assets).is_err());
    }
    #[test]
    fn manifest_hash_size_extra_files_and_future_schemas_are_rejected() {
        let p = package(&input(b"body")); let mut files = p.files.clone(); files.insert("document/中文 note.md".into(), b"tampered".to_vec());
        assert!(decode(&encode(&p.manifest, &files).unwrap()).is_err());
        files = p.files.clone(); files.insert("document/.easym/history-location.json".into(), b"{}".to_vec()); let m = with_objects(&p.manifest, &files);
        assert!(decode(&encode(&m, &files).unwrap()).is_err());
        let mut m = p.manifest.clone(); m.objects[0].size += 1; assert!(decode(&encode(&m, &p.files).unwrap()).is_err());
        m = p.manifest.clone(); m.schema_version = 2; assert!(matches!(decode(&encode(&m, &p.files).unwrap()), Err(e) if e == "backup_read_only"));
        m = p.manifest.clone(); m.encoding = "utf-8-bom".into(); assert!(decode(&encode(&m, &p.files).unwrap()).is_err());
    }
    #[test]
    fn paths_case_aliases_and_parent_file_collisions_are_rejected_before_extraction() {
        for path in ["../a", "/a", "C:/a", "a\\b", "a/./b", "a//b", "a/.. /b", "a:stream", "CON.md", "com¹.png", "a./b", "a /b", "a\0b", "a?b"] { assert!(safe_path(path).is_err(), "{path}"); }
        for names in [["document/A.md", "document/a.md"], ["document/a", "document/a/b"], ["document/a/b", "document/a"]] {
            let raw = zip_files(&[(names[0], b"a"), (names[1], b"b")], CompressionMethod::Stored); assert!(preflight(&raw).is_err());
        }
        let mut raw = zip_files(&[("one", b"a"), ("two", b"b")], CompressionMethod::Stored);
        // Replace a central+local name with a duplicate, independently of the ZIP library's writer map.
        for at in (0..raw.len().saturating_sub(3)).filter(|&i| &raw[i..i + 3] == b"two").collect::<Vec<_>>() { raw[at..at + 3].copy_from_slice(b"one"); }
        assert!(preflight(&raw).is_err());
    }
    #[test]
    fn zip_flags_links_zip64_bombs_truncation_and_mismatched_headers_are_rejected() {
        let raw = zip_files(&[("document/a.md", b"body")], CompressionMethod::Stored); assert_eq!(preflight(&raw).unwrap(), 1); let c = central(&raw);
        let mutations = [(c + 8, 1u32, 2usize), (c + 6, 45, 2), (c + 38, 0xa000 << 16, 4), (c + 38, 0x10, 4), (c + 24, MAX_TEXT as u32 + 1, 4), (c + 20, 0, 4), (18, 999, 4)];
        for (at, value, len) in mutations { let mut bad = raw.clone(); bad[at..at + len].copy_from_slice(&value.to_le_bytes()[..len]); assert!(preflight(&bad).is_err(), "offset {at}"); }
        assert!(preflight(&raw[..raw.len() - 1]).is_err());
        let mut bad = raw.clone(); bad.splice(0..0, [0u8]); assert!(preflight(&bad).is_err());
        let bomb = zip_files(&[("document/a.md", &vec![b'a'; 2 * 1024 * 1024])], CompressionMethod::Deflated); assert!(preflight(&bomb).is_err());
    }
    #[test]
    fn deflate_archive_is_supported_and_crc_corruption_is_detected() {
        let p = package(&input(b"body")); let json = serde_json::to_vec(&p.manifest).unwrap();
        let mut files = vec![("manifest.json", json.as_slice())]; files.extend(p.files.iter().map(|(p, b)| (p.as_str(), b.as_slice())));
        let raw = zip_files(&files, CompressionMethod::Deflated); assert!(decode(&raw).is_ok());
        let mut raw = build(&input(b"unique payload"), None).unwrap().0;
        let at = raw.windows(14).position(|v| v == b"unique payload").unwrap(); raw[at] ^= 1; assert!(decode(&raw).is_err());
    }
    #[test]
    fn restore_failure_leaves_no_published_partial_directory() {
        let mut p = package(&input(b"body")); p.files.insert("document/assets/bad.png".into(), b"bad".to_vec());
        let temp = tempdir(); assert!(restore_into(&p, temp.path()).is_err()); assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
    }
    #[test]
    fn review_requires_exact_current_refs_and_history_subsets() {
        let mut p = package(&input(b"plain")); assert!(review_references(&p, &[vec![]]).is_ok()); assert!(review_references(&p, &[]).is_err());
        p.reviews[0].available_references = vec!["a.png".into()]; assert!(review_references(&p, &[vec![]]).is_err());
        p.reviews.push(Review { text: "history".into(), available_references: vec!["source.png".into(), "display.png".into()] });
        assert!(review_references(&p, &[vec!["a.png".into()], vec!["display.png".into()]]).is_ok());
        assert!(review_references(&p, &[vec!["a.png".into()], vec!["missing.png".into()]]).is_err());
    }
    #[test]
    fn tickets_expire_are_bounded_and_bind_the_exact_archive() {
        let state = Backups::default(); let temp = tempdir(); let path = temp.path().join("backup.zip"); let raw = build(&input(b"body"), None).unwrap().0; fs::write(&path, &raw).unwrap();
        let token = insert_ticket(&state, path.clone(), transaction::hash(&raw)).unwrap(); assert!(reread(&ticket(&state, &token).unwrap()).is_ok());
        fs::write(&path, build(&input(b"replacement"), None).unwrap().0).unwrap(); assert!(matches!(reread(&ticket(&state, &token).unwrap()), Err(e) if e == "backup_changed"));
        for _ in 0..3 { insert_ticket(&state, path.clone(), "hash".into()).unwrap(); } assert!(insert_ticket(&state, path.clone(), "hash".into()).is_err());
        state.0.lock().unwrap().get_mut(&token).unwrap().expires = 0; assert!(ticket(&state, &token).is_err()); assert!(insert_ticket(&state, path, "hash".into()).is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn picker_aliases_resolve_once_and_replaced_grants_remain_blocked() {
        use std::os::unix::fs::symlink;
        let temp = tempdir(); let root = temp.path();
        let granted = root.join("granted"); let outside = root.join("outside");
        fs::create_dir(&granted).unwrap(); fs::create_dir(&outside).unwrap();
        let alias = root.join("picker-alias"); symlink(&granted, &alias).unwrap();
        let data = input(b"body"); let (raw, assets) = build(&data, None).unwrap();
        let target = alias.canonicalize().unwrap().join("copy.easym-backup.zip");
        publish_backup(&target, &raw, &data, None, &assets).unwrap();
        let state = Backups::default();
        let token = insert_ticket(&state, alias.join("copy.easym-backup.zip").canonicalize().unwrap(), transaction::hash(&raw)).unwrap();
        let p = reread(&ticket(&state, &token).unwrap()).unwrap();
        let restored = restore_into(&p, &alias.canonicalize().unwrap()).unwrap();
        assert_eq!(fs::read(restored).unwrap(), b"body");
        // An unchecked alias is still rejected by the internal operations.
        assert!(publish_backup(&alias.join("other.easym-backup.zip"), &raw, &data, None, &assets).is_err());
        assert!(restore_into(&p, &alias).is_err());
        // Replacing the authorized directory after inspection must not grant
        // access to another location, even if it holds identical archive bytes.
        fs::write(outside.join("copy.easym-backup.zip"), &raw).unwrap();
        fs::rename(&granted, root.join("original-granted")).unwrap(); symlink(&outside, &granted).unwrap();
        assert!(matches!(reread(&ticket(&state, &token).unwrap()), Err(e) if e == "permission_denied"));
        assert!(publish_backup(&granted.join("other.easym-backup.zip"), &raw, &data, None, &assets).is_err());
        assert!(restore_into(&p, &granted).is_err());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
        assert_eq!(fs::read(outside.join("copy.easym-backup.zip")).unwrap(), raw);
    }
}
