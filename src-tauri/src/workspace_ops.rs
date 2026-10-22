//! v2 step 2B: controlled same-directory rename and in-app trash for workspace documents.
//! Rename is journaled under `.easym/sync/operations/<op>/`: staged bodies and the record are
//! written first, the no-clobber rename is the commit point, and everything after it (history
//! key, identity path, link rewrites in other documents) rolls forward idempotently.
use std::{collections::BTreeSet, fs, io::Write, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;
use tempfile::NamedTempFile;
use crate::{recent::Recents, resources::{directory, safe_existing}, storage::{read_text, Storage}, sync_identity, transaction, workspace::{root, Workspaces}};

const OPERATIONS: &str = ".easym/sync/operations";
const TRASH: &str = ".easym/trash";
const MAX_CANDIDATE_BYTES: usize = 64 * 1024 * 1024;
const MAX_SCAN: usize = 50_000;
const MAX_TEXT: usize = 10 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Phase { Journal, Renamed }

#[derive(Serialize)]
pub struct Candidate { path: String, bytes: Vec<u8>, revision: String }
#[derive(Serialize)]
pub struct RenamePrepared { from: String, to: String, candidates: Vec<Candidate> }
#[derive(Deserialize)]
pub struct Rewrite { path: String, expected: String, bytes: Vec<u8> }
/// Cross-directory moves only: managed image paths (relative to the document) that the moved
/// body references, found by the frontend's Markdown parser. Source images are copied, never moved.
#[derive(Default, Deserialize)]
pub struct MoveResources { #[serde(default)] references: Vec<String> }

#[derive(Deserialize, Serialize)]
struct StagedRewrite { path: String, expected: String, revision: String }
/// `history` is the moved document's history documentId for cross-directory moves; the
/// target directory already holds a copy before the commit point.
#[derive(Deserialize, Serialize)]
struct RenameRecord { version: u32, kind: String, from: String, to: String, rewrites: Vec<StagedRewrite>, #[serde(default, skip_serializing_if = "Option::is_none")] history: Option<String> }

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrashRecord { version: u32, path: String, name: String, document_id: Option<String>, deleted_at: u64, revision: String }

fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
fn operation_id(value: &str) -> Result<String, String> { Ok(uuid::Uuid::parse_str(value).map_err(|_| "invalid_data")?.to_string()) }
fn is_document(name: &str) -> bool { let lower = name.to_ascii_lowercase(); lower.ends_with(".md") || lower.ends_with(".markdown") }
fn split(relative: &str) -> (&str, &str) { relative.rsplit_once('/').unwrap_or(("", relative)) }
fn join(directory: &str, name: &str) -> String { if directory.is_empty() { name.to_string() } else { format!("{directory}/{name}") } }

/// A file name storable on Windows, macOS and Linux alike. NFC is enforced by the TS core.
/// One path component storable on Windows, macOS and Linux alike.
fn portable_name_part(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 255 || name.starts_with('.') || name.ends_with(['.', ' ']) || name.chars().any(|c| c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')) { return Err("invalid_name".into()); }
    let stem = name.split('.').next().unwrap_or_default().to_ascii_lowercase();
    if matches!(stem.as_str(), "con" | "prn" | "aux" | "nul") || ((stem.starts_with("com") || stem.starts_with("lpt")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit() && stem.as_bytes()[3] != b'0') { return Err("invalid_name".into()); }
    Ok(())
}
pub(crate) fn portable_name(name: &str) -> Result<(), String> {
    portable_name_part(name)?;
    if !is_document(name) { return Err("invalid_name".into()); }
    Ok(())
}

/// Exact-name presence, independent of the volume's case sensitivity.
fn exact_exists(directory: &Path, name: &str) -> Result<bool, String> {
    for item in fs::read_dir(directory).map_err(|_| "io_failed")? { if item.map_err(|_| "io_failed")?.file_name().to_str() == Some(name) { return Ok(true); } }
    Ok(false)
}

/// Moves a file without ever replacing an existing target. Case-only renames go through a
/// unique temporary name because the target "exists" on case-insensitive volumes.
fn move_noclobber(source: &Path, target: &Path) -> Result<(), String> {
    let parent = target.parent().ok_or("invalid_data")?;
    let name = target.file_name().and_then(|n| n.to_str()).ok_or("invalid_data")?;
    if exact_exists(parent, name)? { return Err("target_exists".into()); }
    if target.exists() {
        if !same_file::is_same_file(source, target).map_err(|_| "io_failed")? { return Err("target_exists".into()); }
        let temporary = parent.join(format!(".easym-rename-{}.tmp", uuid::Uuid::new_v4()));
        fs::rename(source, &temporary).map_err(|_| "io_failed")?;
        if fs::rename(&temporary, target).is_err() { let _ = fs::rename(&temporary, source); return Err("io_failed".into()); }
        return Ok(());
    }
    match fs::hard_link(source, target) {
        Ok(()) => fs::remove_file(source).map_err(|_| "io_failed".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err("target_exists".into()),
        // Volumes without hard links (FAT, some shares): checked above under the write queue.
        Err(_) => fs::rename(source, target).map_err(|_| "io_failed".to_string()),
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("invalid_data")?;
    let mut file = NamedTempFile::new_in(parent).map_err(|_| "io_failed")?;
    file.write_all(bytes).map_err(|_| "io_failed")?; file.as_file().sync_all().map_err(|_| "io_failed")?;
    if fs::read(file.path()).map_err(|_| "io_failed")? != bytes { return Err("io_failed".into()); }
    file.persist(path).map_err(|_| "io_failed")?; Ok(())
}
/// Updates the identity path of a renamed document, keeping its documentId. Idempotent:
/// an identity that already names `to` is left unchanged; no identity file means sync is off.
fn relocate_identity(root: &Path, from: &str, to: &str) -> Result<(), String> {
    let Some(bytes) = sync_identity::read_identity(root)? else { return Ok(()); };
    let mut value: Value = serde_json::from_slice(&bytes).map_err(|_| "identity_unreadable")?;
    if value["schemaVersion"] != 1 { return Err("identity_unreadable".into()); }
    let documents = value["documents"].as_array_mut().ok_or("identity_unreadable")?;
    if documents.iter().any(|d| d["path"] == to) && !documents.iter().any(|d| d["path"] == from) { return Ok(()); }
    if documents.iter().any(|d| d["path"] == to) { return Err("identity_conflict".into()); }
    let Some(entry) = documents.iter_mut().find(|d| d["path"] == from) else { return Ok(()); };
    entry["path"] = json!(to);
    documents.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    let mut next = serde_json::to_vec_pretty(&value).map_err(|_| "invalid_data")?; next.push(b'\n');
    sync_identity::write(root, Some(&transaction::hash(&bytes)), &next).map(|_| ())
}
/// Removes (`entry` None) or re-adds an identity entry for trash/restore. A restore that would
/// collide with a path or documentId now in use is skipped and reported instead.
fn edit_identity(root: &Path, path: &str, entry: Option<&str>) -> Result<(), String> {
    let Some(bytes) = sync_identity::read_identity(root)? else { return Ok(()); };
    let mut value: Value = serde_json::from_slice(&bytes).map_err(|_| "identity_unreadable")?;
    if value["schemaVersion"] != 1 { return Err("identity_unreadable".into()); }
    let documents = value["documents"].as_array_mut().ok_or("identity_unreadable")?;
    match entry {
        None => documents.retain(|d| d["path"] != path),
        Some(id) => {
            if documents.iter().any(|d| d["documentId"] == id && d["path"] == path) { return Ok(()); }
            if documents.iter().any(|d| d["documentId"] == id || d["path"].as_str().is_some_and(|p| p.to_lowercase() == path.to_lowercase())) { return Err("identity_conflict".into()); }
            documents.push(json!({ "documentId": id, "path": path }));
        }
    }
    documents.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    let mut next = serde_json::to_vec_pretty(&value).map_err(|_| "invalid_data")?; next.push(b'\n');
    if next == bytes { return Ok(()); }
    sync_identity::write(root, Some(&transaction::hash(&bytes)), &next).map(|_| ())
}
fn identity_of(root: &Path, path: &str) -> Option<String> {
    let bytes = sync_identity::read_identity(root).ok()??;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    value["documents"].as_array()?.iter().find(|d| d["path"] == path).and_then(|d| d["documentId"].as_str()).map(str::to_string)
}

/// Every Markdown document in the workspace (including the renamed one, for self-links),
/// read in full for link analysis.
/// Bounded; exceeding the bound fails the rename preparation instead of missing links.
fn candidates(root: &Path) -> Result<Vec<Candidate>, String> {
    let mut found = Vec::new(); let mut stack = vec![String::new()]; let mut total = 0usize; let mut scanned = 0usize;
    while let Some(relative) = stack.pop() {
        let dir = if relative.is_empty() { root.to_path_buf() } else { safe_existing(root, &relative)? };
        for item in fs::read_dir(dir).map_err(|_| "io_failed")? {
            scanned += 1; if scanned > MAX_SCAN { return Err("quota_exceeded".into()); }
            let item = item.map_err(|_| "io_failed")?; let info = item.file_type().map_err(|_| "io_failed")?;
            let Some(name) = item.file_name().to_str().map(str::to_string) else { continue; };
            if info.is_symlink() || name.starts_with('.') || matches!(name.as_str(), "node_modules" | "target") { continue; }
            let path = join(&relative, &name);
            if info.is_dir() { stack.push(path); continue; }
            if !info.is_file() || !is_document(&name) { continue; }
            let bytes = read_text(&safe_existing(root, &path)?)?;
            total += bytes.len(); if total > MAX_CANDIDATE_BYTES { return Err("quota_exceeded".into()); }
            found.push(Candidate { revision: transaction::hash(&bytes), path, bytes });
        }
    }
    found.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(found)
}

/// Validates a rename or move. Returns (source, target, source dir, target dir). The target
/// directory must already exist inside the workspace and must not be inside `.easym`.
fn preflight(root: &Path, from: &str, to: &str) -> Result<(PathBuf, PathBuf, PathBuf, PathBuf), String> {
    let (from_dir, from_name) = split(from); let (to_dir, to_name) = split(to);
    portable_name(to_name)?;
    for part in to_dir.split('/').filter(|p| !p.is_empty()) { if part.starts_with('.') { return Err("invalid_name".into()); } portable_name_part(part)?; }
    if from == to { return Err("invalid_name".into()); }
    let source = safe_existing(root, from)?;
    if !source.is_file() || !is_document(from_name) { return Err("invalid_data".into()); }
    crate::storage::checked_document(&source)?;
    let source_dir = source.parent().ok_or("invalid_data")?.to_path_buf();
    let target_dir = if to_dir.is_empty() { root.to_path_buf() } else { safe_existing(root, to_dir).map_err(|_| "target_missing")? };
    if !target_dir.is_dir() { return Err("target_missing".into()); }
    let same_dir = from_dir == to_dir;
    if exact_exists(&target_dir, to_name)? || (target_dir.join(to_name).exists() && !(same_dir && same_file::is_same_file(&source, target_dir.join(to_name)).unwrap_or(false))) { return Err("target_exists".into()); }
    if transaction::pending(&source)? { return Err("save_pending".into()); }
    if same_dir { crate::history::check_rename(&source_dir, from_name, to_name)?; }
    else if crate::history::history_identities(&target_dir)?.is_some_and(|map| map.contains_key(to_name)) { return Err("history_name_taken".into()); }
    Ok((source, target_dir.join(to_name), source_dir, target_dir))
}
/// Read-only: validates the rename and returns every other document for incoming-link analysis.
pub(crate) fn prepare_rename(root: &Path, from: &str, to: &str) -> Result<RenamePrepared, String> {
    recover_all(root)?;
    preflight(root, from, to)?;
    Ok(RenamePrepared { from: from.into(), to: to.into(), candidates: candidates(root)? })
}

/// Commits a rename and the frontend's link rewrites. Rewrites carry the revision they were
/// computed against; any concurrent change aborts before the rename, leaving nothing changed.
#[cfg(test)]
pub(crate) fn rename(root: &Path, operation: &str, from: &str, to: &str, rewrites: Vec<Rewrite>) -> Result<Value, String> {
    rename_with(root, operation, from, to, rewrites, MoveResources::default(), |_| Ok(()))
}
pub(crate) fn rename_or_move(root: &Path, operation: &str, from: &str, to: &str, rewrites: Vec<Rewrite>, resources: MoveResources) -> Result<Value, String> {
    rename_with(root, operation, from, to, rewrites, resources, |_| Ok(()))
}

/// Copies the moved document's managed images and their `images.json` instances into the
/// target directory before the commit point. Existing target files must already hold identical
/// bytes; instances whose display path is already described identically are kept as is.
fn copy_resources(source_dir: &Path, target_dir: &Path, references: &[String]) -> Result<(), String> {
    if references.is_empty() { return Ok(()); }
    let mut wanted = BTreeSet::new();
    let metadata = if source_dir.join(".easym/images.json").exists() { crate::resources::read_metadata(source_dir).0.ok_or("resources_unreadable")? } else { crate::resources::Metadata { schema_version: 1, instances: vec![] } };
    let mut instances = Vec::new();
    for reference in references {
        wanted.insert(reference.clone());
        for instance in metadata.instances.iter().filter(|i| i["displayPath"] == reference.as_str()) {
            crate::resources::validate_instance(instance)?;
            wanted.insert(instance["sourcePath"].as_str().ok_or("invalid_data")?.to_string());
            let mut copy = instance.clone(); copy["documentId"] = Value::Null; instances.push(copy);
        }
    }
    let mut assets = Vec::new(); let mut total = 0usize;
    for path in wanted {
        let file = safe_existing(source_dir, &path).map_err(|_| "resource_missing")?;
        let bytes = fs::read(&file).map_err(|_| "io_failed")?;
        total += bytes.len(); if total > 128 * 1024 * 1024 { return Err("quota_exceeded".into()); }
        assets.push(crate::resources::Asset { path, bytes });
    }
    // write_assets refuses a differing existing file, so nothing in the target is overwritten.
    crate::resources::write_assets(target_dir, &assets).map_err(|e| if e == "revision_conflict" { "resource_conflict".to_string() } else { e })?;
    if instances.is_empty() { return Ok(()); }
    let existing = if target_dir.join(".easym/images.json").exists() { crate::resources::read_metadata(target_dir).0.ok_or("resources_unreadable")? } else { crate::resources::Metadata { schema_version: 1, instances: vec![] } };
    let incoming: Vec<Value> = instances.into_iter().filter(|i| !existing.instances.iter().any(|e| e["displayPath"] == i["displayPath"] && e["sourceHash"] == i["sourceHash"] && e["recipe"] == i["recipe"])).collect();
    if incoming.iter().any(|i| existing.instances.iter().any(|e| e["displayPath"] == i["displayPath"])) { return Err("resource_conflict".into()); }
    if incoming.is_empty() { return Ok(()); }
    let staged = crate::resources::stage_metadata(target_dir, crate::resources::Metadata { schema_version: 1, instances: incoming })?;
    staged.persist(target_dir.join(".easym/images.json")).map_err(|_| "io_failed")?;
    Ok(())
}

fn rename_with(root: &Path, operation: &str, from: &str, to: &str, rewrites: Vec<Rewrite>, resources: MoveResources, mut phase: impl FnMut(Phase) -> Result<(), String>) -> Result<Value, String> {
    let operation = operation_id(operation)?;
    recover_all(root)?;
    let (source, target, source_dir, target_dir) = preflight(root, from, to)?;
    let moving = source_dir != target_dir;
    if !moving && !resources.references.is_empty() { return Err("invalid_data".into()); }
    for reference in &resources.references { if !reference.starts_with("assets/") || safe_existing(&source_dir, reference).is_err() { return Err("resource_missing".into()); } }
    let mut paths = BTreeSet::new(); let mut total = 0usize;
    for rewrite in &rewrites {
        if !paths.insert(rewrite.path.clone()) || rewrite.path == to { return Err("invalid_data".into()); }
        total += rewrite.bytes.len(); if rewrite.bytes.len() > MAX_TEXT || total > MAX_CANDIDATE_BYTES { return Err("quota_exceeded".into()); }
        std::str::from_utf8(&rewrite.bytes).map_err(|_| "invalid_data")?;
        let path = if rewrite.path == from { source.clone() } else { safe_existing(root, &rewrite.path)? };
        if !is_document(&rewrite.path) || transaction::hash(&read_text(&path)?) != rewrite.expected { return Err("revision_conflict".into()); }
    }
    let folder = directory(root, &format!("{OPERATIONS}/{operation}"))?;
    if folder.join("record.json").exists() { return Err("invalid_data".into()); }
    let mut staged = Vec::new();
    for (index, rewrite) in rewrites.iter().enumerate() {
        let name = format!("rewrite-{index}.md");
        atomic_write(&folder.join(&name), &rewrite.bytes)?;
        // The moved document's own rewrite applies at its new path.
        staged.push(StagedRewrite { path: if rewrite.path == from { to.into() } else { rewrite.path.clone() }, expected: rewrite.expected.clone(), revision: transaction::hash(&rewrite.bytes) });
    }
    // Cross-directory: copy images and history into the target first. These copies are additive
    // (immutable assets, content-addressed objects, a new index entry), so a crash before the
    // commit point leaves only unreferenced extras and never changes the source.
    // Cross-directory: the record names the history first, so recovery can undo a copy that
    // never reached the commit point. Copies are additive (immutable assets, content-addressed
    // objects, one new index entry) and never change the source.
    let to_name = split(to).1;
    let history = if moving { crate::history::history_identities(&source_dir)?.and_then(|map| map.get(split(from).1).cloned()) } else { None };
    let record = RenameRecord { version: 1, kind: "rename".into(), from: from.into(), to: to.into(), rewrites: staged, history: history.clone() };
    atomic_write(&folder.join("record.json"), &serde_json::to_vec_pretty(&record).map_err(|_| "invalid_data")?)?;
    let abort = |error: String| -> String {
        if let Some(id) = &history { let _ = crate::history::abandon_import(&target_dir, to_name, id); }
        let _ = fs::remove_dir_all(&folder); error
    };
    if moving {
        copy_resources(&source_dir, &target_dir, &resources.references).map_err(abort)?;
        if history.is_some() {
            let files = crate::history::portable_history(&source).map_err(abort)?;
            crate::history::import_history(&target_dir, to_name, &files).map_err(abort)?;
        }
    }
    phase(Phase::Journal)?;
    // Commit point. Before it, deleting the journal folder restores the original state.
    move_noclobber(&source, &target).map_err(abort)?;
    phase(Phase::Renamed)?;
    let warnings = finish(root, &operation, &record)?;
    Ok(json!({ "path": to, "warnings": warnings }))
}

/// Roll-forward after the commit point. Each step checks its own postcondition first, so a
/// crash at any point repeats only unfinished steps. A rewrite target changed by another tool
/// is skipped (reported), never overwritten.
fn dir_of(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let directory = split(relative).0;
    if directory.is_empty() { Ok(root.to_path_buf()) } else { safe_existing(root, directory) }
}
fn finish(root: &Path, operation: &str, record: &RenameRecord) -> Result<Vec<String>, String> {
    let folder = safe_existing(root, &format!("{OPERATIONS}/{operation}"))?;
    let from_name = split(&record.from).1; let to_name = split(&record.to).1;
    let parent = dir_of(root, &record.from)?; let target_dir = dir_of(root, &record.to)?;
    let mut warnings = Vec::new();
    if parent == target_dir { crate::history::rename_key(&parent, from_name, to_name)?; }
    // The target already holds the copied history; the source entry stops claiming the name.
    else if let Some(id) = &record.history { crate::history::forget_history(&parent, from_name, id)?; }
    if crate::merge::record_names(&parent).map(|names| names.contains(from_name)).unwrap_or(false) { warnings.push("merge_records_previous_name".to_string()); }
    if let Err(error) = relocate_identity(root, &record.from, &record.to) { warnings.push(format!("identity:{error}")); }
    for (index, rewrite) in record.rewrites.iter().enumerate() {
        let path = safe_existing(root, &rewrite.path)?;
        let current = transaction::hash(&read_text(&path)?);
        if current == rewrite.revision { continue; }
        if current != rewrite.expected { warnings.push(format!("link_skipped:{}", rewrite.path)); continue; }
        let bytes = fs::read(safe_existing(&folder, &format!("rewrite-{index}.md"))?).map_err(|_| "io_failed")?;
        if transaction::hash(&bytes) != rewrite.revision { return Err("journal_corrupt".into()); }
        atomic_write(&path, &bytes)?;
    }
    fs::remove_dir_all(&folder).map_err(|_| "io_failed")?;
    Ok(warnings)
}

/// Finishes or discards every rename journal. A journal whose source still exists and whose
/// target does not was never committed and is discarded; otherwise it rolls forward.
pub(crate) fn recover_all(root: &Path) -> Result<Vec<String>, String> {
    let mut warnings = Vec::new();
    if !root.join(OPERATIONS).exists() { return Ok(warnings); }
    let base = safe_existing(root, OPERATIONS)?;
    let mut names: Vec<String> = fs::read_dir(&base).map_err(|_| "io_failed")?.filter_map(|e| e.ok()?.file_name().to_str().map(str::to_string)).collect();
    names.sort();
    for name in names {
        if operation_id(&name).ok().as_deref() != Some(name.as_str()) { continue; }
        let folder = safe_existing(root, &format!("{OPERATIONS}/{name}"))?;
        let Ok(manifest) = safe_existing(&folder, "record.json") else { fs::remove_dir_all(&folder).map_err(|_| "io_failed")?; continue; };
        let record: RenameRecord = serde_json::from_slice(&fs::read(manifest).map_err(|_| "io_failed")?).map_err(|_| "journal_corrupt")?;
        if record.version != 1 || record.kind != "rename" { return Err("journal_corrupt".into()); }
        // Exact names, so a case-only rename is judged correctly on case-insensitive volumes.
        let from_name = split(&record.from).1; let to_name = split(&record.to).1;
        let (Ok(parent), Ok(target_dir)) = (dir_of(root, &record.from), dir_of(root, &record.to)) else { fs::remove_dir_all(&folder).map_err(|_| "io_failed")?; continue; };
        let committed = exact_exists(&target_dir, to_name)? && !exact_exists(&parent, from_name)?;
        if !committed {
            // A move that copied history but never committed must not keep claiming the target name.
            if let (Some(id), true) = (&record.history, parent != target_dir) { crate::history::abandon_import(&target_dir, to_name, id)?; }
            fs::remove_dir_all(&folder).map_err(|_| "io_failed")?; continue;
        }
        warnings.extend(finish(root, &name, &record)?);
    }
    Ok(warnings)
}
/// Moves a document into `.easym/trash/<op>/`, keeping its identity record so a restore keeps
/// the documentId. Images, history and other documents are untouched.
pub(crate) fn trash(root: &Path, operation: &str, path: &str, expected: &str) -> Result<Value, String> {
    let operation = operation_id(operation)?;
    recover_all(root)?;
    let source = safe_existing(root, path)?;
    let name = split(path).1;
    if !source.is_file() || !is_document(name) { return Err("invalid_data".into()); }
    crate::storage::checked_document(&source)?;
    if transaction::hash(&read_text(&source)?) != expected { return Err("revision_conflict".into()); }
    if transaction::pending(&source)? { return Err("save_pending".into()); }
    let folder = directory(root, &format!("{TRASH}/{operation}"))?;
    if fs::read_dir(&folder).map_err(|_| "io_failed")?.next().is_some() { return Err("invalid_data".into()); }
    let record = TrashRecord { version: 1, path: path.into(), name: name.into(), document_id: identity_of(root, path), deleted_at: now(), revision: expected.into() };
    atomic_write(&folder.join("record.json"), &serde_json::to_vec_pretty(&record).map_err(|_| "invalid_data")?)?;
    if let Err(error) = move_noclobber(&source, &folder.join("document.md")) { let _ = fs::remove_dir_all(&folder); return Err(error); }
    // The body is in the trash from here on; an identity failure is a warning, never a rollback.
    let warning = edit_identity(root, path, None).err().map(|e| format!("identity:{e}"));
    Ok(json!({ "operationId": operation, "path": path, "documentId": record.document_id, "warning": warning }))
}

pub(crate) fn trash_list(root: &Path) -> Result<Vec<Value>, String> {
    let mut items = Vec::new();
    if !root.join(TRASH).exists() { return Ok(items); }
    for (count, entry) in fs::read_dir(safe_existing(root, TRASH)?).map_err(|_| "io_failed")?.enumerate() {
        if count > 4096 { return Err("quota_exceeded".into()); }
        let Some(name) = entry.map_err(|_| "io_failed")?.file_name().to_str().map(str::to_string) else { continue; };
        if operation_id(&name).ok().as_deref() != Some(name.as_str()) { continue; }
        let folder = safe_existing(root, &format!("{TRASH}/{name}"))?;
        let Ok(manifest) = safe_existing(&folder, "record.json") else { continue; };
        let Ok(record) = serde_json::from_slice::<TrashRecord>(&fs::read(manifest).map_err(|_| "io_failed")?) else { continue; };
        if record.version != 1 || safe_existing(&folder, "document.md").is_err() { continue; }
        items.push(json!({ "operationId": name, "path": record.path, "deletedAt": record.deleted_at, "documentId": record.document_id }));
    }
    items.sort_by_key(|v| std::cmp::Reverse(v["deletedAt"].as_u64().unwrap_or(0)));
    Ok(items)
}

/// Restores to the original path (never overwriting) and drops the trash entry.
pub(crate) fn restore(root: &Path, operation: &str) -> Result<Value, String> {
    let operation = operation_id(operation)?;
    let folder = safe_existing(root, &format!("{TRASH}/{operation}"))?;
    let record: TrashRecord = serde_json::from_slice(&fs::read(safe_existing(&folder, "record.json")?).map_err(|_| "io_failed")?).map_err(|_| "invalid_data")?;
    if record.version != 1 { return Err("invalid_data".into()); }
    let (directory_path, name) = split(&record.path);
    portable_name(name)?;
    let parent = if directory_path.is_empty() { root.to_path_buf() } else { directory(root, directory_path)? };
    move_noclobber(&safe_existing(&folder, "document.md")?, &parent.join(name))?;
    let warning = record.document_id.as_deref().and_then(|id| edit_identity(root, &record.path, Some(id)).err()).map(|e| format!("identity:{e}"));
    fs::remove_dir_all(&folder).map_err(|_| "io_failed")?;
    Ok(json!({ "path": record.path, "warning": warning }))
}

#[tauri::command]
pub async fn workspace_rename_prepare(state: State<'_, Workspaces>, storage: State<'_, Storage>, id: String, from: String, to: String) -> Result<RenamePrepared, String> {
    let workspaces = state.inner().clone(); let storage = storage.inner().clone();
    tauri::async_runtime::spawn_blocking(move || { let _queue = storage.0.lock().map_err(|_| "io_failed")?; prepare_rename(&root(&workspaces, &id)?, &from, &to) }).await.map_err(|_| "io_failed".to_string())?
}

/// Renames under the write queue and repoints open sessions and recents, so editors keep
/// working on the same document at its new path.
#[tauri::command]
pub async fn workspace_rename(state: State<'_, Workspaces>, storage: State<'_, Storage>, recents: State<'_, Recents>, id: String, operation_id: String, from: String, to: String, rewrites: Vec<Rewrite>, resources: Option<MoveResources>) -> Result<Value, String> {
    let workspaces = state.inner().clone(); let storage = storage.inner().clone(); let recents = recents.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut sessions = storage.0.lock().map_err(|_| "io_failed")?;
        let boundary = root(&workspaces, &id)?;
        let old = safe_existing(&boundary, &from)?;
        // Open editors are allowed: the frontend refuses while a tab has unsaved edits, and
        // every session on the old path follows the file, so the editor reloads from it.
        let mut value = rename_or_move(&boundary, &operation_id, &from, &to, rewrites, resources.unwrap_or_default())?;
        let new = safe_existing(&boundary, &to)?;
        let moved: Vec<String> = sessions.iter_mut().filter(|(_, p)| **p == old).map(|(session, path)| { *path = new.clone(); session.clone() }).collect();
        value["sessions"] = json!(moved);
        if recents.relocate(&old, &new).is_err() { value["warnings"].as_array_mut().map(|w| w.push(json!("recent_not_updated"))); }
        Ok(value)
    }).await.map_err(|_| "io_failed".to_string())?
}

/// Lists workspace directories (excluding `.easym` and hidden ones) as move targets.
#[tauri::command]
pub async fn workspace_directories(state: State<'_, Workspaces>, id: String) -> Result<Vec<String>, String> {
    let workspaces = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || directories(&root(&workspaces, &id)?)).await.map_err(|_| "io_failed".to_string())?
}
fn directories(root: &Path) -> Result<Vec<String>, String> {
    let mut result = vec![String::new()]; let mut stack = vec![(String::new(), 0usize)]; let mut seen = 0usize;
    while let Some((relative, depth)) = stack.pop() {
        if depth >= 32 { continue; }
        let directory = if relative.is_empty() { root.to_path_buf() } else { safe_existing(root, &relative)? };
        for item in fs::read_dir(directory).map_err(|_| "io_failed")? {
            seen += 1; if seen > MAX_SCAN { return Err("quota_exceeded".into()); }
            let item = item.map_err(|_| "io_failed")?;
            let Some(name) = item.file_name().to_str().map(str::to_string) else { continue; };
            if name.starts_with('.') || name == "node_modules" || !item.file_type().map_err(|_| "io_failed")?.is_dir() { continue; }
            let path = join(&relative, &name);
            result.push(path.clone()); stack.push((path, depth + 1));
        }
    }
    result.sort(); Ok(result)
}

#[tauri::command]
pub async fn workspace_trash(state: State<'_, Workspaces>, storage: State<'_, Storage>, id: String, operation_id: String, path: String, expected: Option<String>) -> Result<Value, String> {
    let workspaces = state.inner().clone(); let storage = storage.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let sessions = storage.0.lock().map_err(|_| "io_failed")?;
        let boundary = root(&workspaces, &id)?;
        // An open editor would silently recreate the file on its next save; close it first.
        if sessions.values().any(|p| *p == safe_existing(&boundary, &path).unwrap_or_default()) { return Err("document_open".into()); }
        // The tree has no content witness; the current bytes are recorded and stay restorable.
        let expected = match expected { Some(value) => value, None => transaction::hash(&read_text(&safe_existing(&boundary, &path)?)?) };
        trash(&boundary, &operation_id, &path, &expected)
    }).await.map_err(|_| "io_failed".to_string())?
}

#[tauri::command]
pub async fn workspace_trash_list(state: State<'_, Workspaces>, storage: State<'_, Storage>, id: String) -> Result<Vec<Value>, String> {
    let workspaces = state.inner().clone(); let storage = storage.inner().clone();
    tauri::async_runtime::spawn_blocking(move || { let _queue = storage.0.lock().map_err(|_| "io_failed")?; trash_list(&root(&workspaces, &id)?) }).await.map_err(|_| "io_failed".to_string())?
}

#[tauri::command]
pub async fn workspace_trash_restore(state: State<'_, Workspaces>, storage: State<'_, Storage>, id: String, operation_id: String) -> Result<Value, String> {
    let workspaces = state.inner().clone(); let storage = storage.inner().clone();
    tauri::async_runtime::spawn_blocking(move || { let _queue = storage.0.lock().map_err(|_| "io_failed")?; restore(&root(&workspaces, &id)?, &operation_id) }).await.map_err(|_| "io_failed".to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    const A: &str = "a1b2c3d4-0000-4000-8000-000000000001";
    const B: &str = "a1b2c3d4-0000-4000-8000-000000000002";

    fn workspace() -> (tempfile::TempDir, PathBuf) { let temp = tempfile::tempdir().unwrap(); let root = temp.path().canonicalize().unwrap(); (temp, root) }
    fn op() -> String { uuid::Uuid::new_v4().to_string() }
    fn identity(root: &Path, documents: &[(&str, &str)]) {
        let bytes = serde_json::to_vec(&json!({"schemaVersion":1,"workspaceId":"1358f0a2-25b8-441b-9d55-379f6ca303dc","documents":documents.iter().map(|(id, p)| json!({"documentId":id,"path":p})).collect::<Vec<_>>()})).unwrap();
        sync_identity::write(root, None, &bytes).unwrap();
    }
    fn identity_paths(root: &Path) -> Vec<(String, String)> {
        let value: Value = serde_json::from_slice(&sync_identity::read_identity(root).unwrap().unwrap()).unwrap();
        value["documents"].as_array().unwrap().iter().map(|d| (d["documentId"].as_str().unwrap().into(), d["path"].as_str().unwrap().into())).collect()
    }
    fn history(dir: &Path, name: &str, id: &str) {
        fs::create_dir_all(dir.join(".easym/history")).unwrap();
        fs::write(dir.join(".easym/history/index.json"), serde_json::to_vec(&json!({"schemaVersion":1,"budgetBytes":536870912u64,"documents":{name:{"documentId":id,"enabled":true,"snapshots":[]}},"deleted":[]})).unwrap()).unwrap();
    }
    fn history_names(dir: &Path) -> Vec<String> { crate::history::history_identities(dir).unwrap().unwrap().into_keys().collect() }

    #[test]
    fn rename_keeps_identity_history_and_bytes_and_rewrites_links() {
        let (_t, root) = workspace();
        fs::create_dir(root.join("notes")).unwrap();
        let body = b"\xef\xbb\xbf# A\r\n[b](b.md)\r\n";
        fs::write(root.join("notes/a.md"), body).unwrap(); fs::write(root.join("notes/b.md"), "[a](a.md)").unwrap();
        identity(&root, &[(A, "notes/a.md"), (B, "notes/b.md")]); history(&root.join("notes"), "a.md", A);
        let prepared = prepare_rename(&root, "notes/a.md", "notes/甲.md").unwrap();
        assert_eq!(prepared.candidates.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(), vec!["notes/a.md", "notes/b.md"]);
        let rewrite = Rewrite { path: "notes/b.md".into(), expected: prepared.candidates[1].revision.clone(), bytes: "[a](%E7%94%B2.md)".into() };
        let result = rename(&root, &op(), "notes/a.md", "notes/甲.md", vec![rewrite]).unwrap();
        assert!(result["warnings"].as_array().unwrap().is_empty());
        assert!(!root.join("notes/a.md").exists());
        assert_eq!(fs::read(root.join("notes/甲.md")).unwrap(), body);
        assert_eq!(fs::read_to_string(root.join("notes/b.md")).unwrap(), "[a](%E7%94%B2.md)");
        assert!(identity_paths(&root).contains(&(A.into(), "notes/甲.md".into())));
        assert_eq!(history_names(&root.join("notes")), vec!["甲.md"]);
        assert!(!root.join(OPERATIONS).read_dir().unwrap().any(|_| true));
    }

    #[test]
    fn rename_refuses_existing_targets_cross_directory_and_unportable_names_without_changes() {
        let (_t, root) = workspace();
        fs::create_dir(root.join("x")).unwrap(); fs::write(root.join("a.md"), "a").unwrap(); fs::write(root.join("b.md"), "b").unwrap();
        for (to, error) in [("b.md", "target_exists"), ("missing/a.md", "target_missing"), (".easym/a.md", "invalid_name"), ("con.md", "invalid_name"), ("a.txt", "invalid_name"), ("bad?.md", "invalid_name"), ("trail.md.", "invalid_name"), ("trail.md ", "invalid_name"), (".hidden.md", "invalid_name")] {
            assert_eq!(rename(&root, &op(), "a.md", to, vec![]).unwrap_err(), error, "{to}");
        }
        assert_eq!(fs::read(root.join("a.md")).unwrap(), b"a"); assert_eq!(fs::read(root.join("b.md")).unwrap(), b"b");
    }

    #[test]
    fn case_only_rename_works_and_keeps_bytes() {
        let (_t, root) = workspace();
        fs::write(root.join("readme.md"), "body").unwrap(); identity(&root, &[(A, "readme.md")]);
        rename(&root, &op(), "readme.md", "README.md", vec![]).unwrap();
        assert!(exact_exists(&root, "README.md").unwrap()); assert!(!exact_exists(&root, "readme.md").unwrap());
        assert_eq!(fs::read(root.join("README.md")).unwrap(), b"body");
        assert_eq!(identity_paths(&root), vec![(A.into(), "README.md".into())]);
    }

    #[test]
    fn stale_rewrite_aborts_before_the_rename() {
        let (_t, root) = workspace();
        fs::write(root.join("a.md"), "a").unwrap(); fs::write(root.join("b.md"), "[a](a.md)").unwrap();
        let prepared = prepare_rename(&root, "a.md", "c.md").unwrap();
        fs::write(root.join("b.md"), "[a](a.md) edited elsewhere").unwrap();
        let rewrite = Rewrite { path: "b.md".into(), expected: prepared.candidates[1].revision.clone(), bytes: "[a](c.md)".into() };
        assert_eq!(rename(&root, &op(), "a.md", "c.md", vec![rewrite]).unwrap_err(), "revision_conflict");
        assert!(root.join("a.md").exists() && !root.join("c.md").exists());
        assert_eq!(fs::read_to_string(root.join("b.md")).unwrap(), "[a](a.md) edited elsewhere");
    }

    #[test]
    fn crash_before_commit_is_discarded_and_after_commit_rolls_forward() {
        for stop in [Phase::Journal, Phase::Renamed] {
            let (_t, root) = workspace();
            fs::write(root.join("a.md"), "a").unwrap(); fs::write(root.join("b.md"), "[a](a.md)").unwrap();
            identity(&root, &[(A, "a.md"), (B, "b.md")]); history(&root, "a.md", A);
            let revision = transaction::hash(b"[a](a.md)");
            let rewrite = Rewrite { path: "b.md".into(), expected: revision, bytes: "[a](c.md)".into() };
            assert_eq!(rename_with(&root, &op(), "a.md", "c.md", vec![rewrite], MoveResources::default(), |at| if at == stop { Err("crash".into()) } else { Ok(()) }).unwrap_err(), "crash");
            recover_all(&root).unwrap();
            if stop == Phase::Journal {
                assert!(root.join("a.md").exists() && !root.join("c.md").exists());
                assert_eq!(fs::read_to_string(root.join("b.md")).unwrap(), "[a](a.md)");
                assert_eq!(history_names(&root), vec!["a.md"]);
            } else {
                assert!(!root.join("a.md").exists() && root.join("c.md").exists());
                assert_eq!(fs::read_to_string(root.join("b.md")).unwrap(), "[a](c.md)");
                assert_eq!(history_names(&root), vec!["c.md"]);
                assert!(identity_paths(&root).contains(&(A.into(), "c.md".into())));
            }
            assert!(!root.join(OPERATIONS).read_dir().unwrap().any(|_| true));
            assert!(recover_all(&root).unwrap().is_empty());
        }
    }

    #[test]
    fn roll_forward_never_overwrites_a_document_edited_after_the_crash() {
        let (_t, root) = workspace();
        fs::write(root.join("a.md"), "a").unwrap(); fs::write(root.join("b.md"), "[a](a.md)").unwrap();
        let rewrite = Rewrite { path: "b.md".into(), expected: transaction::hash(b"[a](a.md)"), bytes: "[a](c.md)".into() };
        let _ = rename_with(&root, &op(), "a.md", "c.md", vec![rewrite], MoveResources::default(), |at| if at == Phase::Renamed { Err("crash".into()) } else { Ok(()) });
        fs::write(root.join("b.md"), "user edit").unwrap();
        assert_eq!(recover_all(&root).unwrap(), vec!["link_skipped:b.md"]);
        assert_eq!(fs::read_to_string(root.join("b.md")).unwrap(), "user edit");
    }

    #[test]
    fn pending_save_journal_blocks_rename() {
        let (_t, root) = workspace(); let path = root.join("a.md");
        fs::write(&path, b"old").unwrap();
        fs::create_dir_all(root.join(".easym/operations")).unwrap();
        fs::write(root.join(format!(".easym/operations/op-{}.json", op())), serde_json::to_vec(&json!({"version":1,"document":"a.md","previous":null,"revision":"sha256:x","metadata":null,"complete":false})).unwrap()).unwrap();
        assert_eq!(rename(&root, &op(), "a.md", "b.md", vec![]).unwrap_err(), "save_pending");
        assert!(path.exists());
    }

    #[test]
    fn trash_and_restore_keep_identity_and_never_overwrite() {
        let (_t, root) = workspace();
        fs::create_dir(root.join("d")).unwrap(); fs::write(root.join("d/a.md"), "body").unwrap(); fs::write(root.join("keep.md"), "k").unwrap();
        identity(&root, &[(A, "d/a.md"), (B, "keep.md")]);
        let operation = op();
        assert_eq!(trash(&root, &operation, "d/a.md", "sha256:stale").unwrap_err(), "revision_conflict");
        let result = trash(&root, &operation, "d/a.md", &transaction::hash(b"body")).unwrap();
        assert_eq!(result["documentId"], A);
        assert!(!root.join("d/a.md").exists());
        assert_eq!(identity_paths(&root), vec![(B.into(), "keep.md".into())]);
        assert_eq!(trash_list(&root).unwrap().len(), 1);
        fs::write(root.join("d/a.md"), "new file in the way").unwrap();
        assert_eq!(restore(&root, &operation).unwrap_err(), "target_exists");
        fs::remove_file(root.join("d/a.md")).unwrap();
        restore(&root, &operation).unwrap();
        assert_eq!(fs::read(root.join("d/a.md")).unwrap(), b"body");
        assert!(identity_paths(&root).contains(&(A.into(), "d/a.md".into())));
        assert!(trash_list(&root).unwrap().is_empty());
    }

    fn png() -> Vec<u8> { include_bytes!("../icons/32x32.png").to_vec() }
    fn image_setup(dir: &Path) {
        fs::create_dir_all(dir.join("assets/.originals")).unwrap(); fs::create_dir_all(dir.join(".easym")).unwrap();
        fs::write(dir.join("assets/img-a-v1.png"), png()).unwrap(); fs::write(dir.join("assets/.originals/img-a-source.png"), png()).unwrap();
        let instance = json!({"instanceId":"img-a","documentId":"process-local","sourcePath":"assets/.originals/img-a-source.png","sourceHash":transaction::hash(&png()),"displayPath":"assets/img-a-v1.png","recipe":{"version":1},"referenceRevision":1});
        fs::write(dir.join(".easym/images.json"), serde_json::to_vec(&json!({"schemaVersion":1,"instances":[instance]})).unwrap()).unwrap();
    }
    fn moved(references: &[&str]) -> MoveResources { MoveResources { references: references.iter().map(|s| s.to_string()).collect() } }

    #[test]
    fn cross_directory_move_copies_images_metadata_history_and_keeps_source_images() {
        let (_t, root) = workspace();
        fs::create_dir_all(root.join("from")).unwrap(); fs::create_dir_all(root.join("to")).unwrap();
        image_setup(&root.join("from"));
        let body = b"![p](assets/img-a-v1.png)\r\n";
        fs::write(root.join("from/a.md"), body).unwrap(); fs::write(root.join("from/other.md"), "![p](assets/img-a-v1.png)").unwrap();
        identity(&root, &[(A, "from/a.md")]);
        let path = root.join("from/a.md");
        crate::history::history_operation_for_tests(&path);
        let history_id = crate::history::history_identities(&root.join("from")).unwrap().unwrap()["a.md"].clone();
        rename_or_move(&root, &op(), "from/a.md", "to/a.md", vec![], moved(&["assets/img-a-v1.png"])).unwrap();
        assert!(!root.join("from/a.md").exists());
        assert_eq!(fs::read(root.join("to/a.md")).unwrap(), body);
        for asset in ["assets/img-a-v1.png", "assets/.originals/img-a-source.png"] {
            assert_eq!(fs::read(root.join("to").join(asset)).unwrap(), png());
            assert!(root.join("from").join(asset).exists(), "source images stay for other documents");
        }
        let meta = crate::resources::read_metadata(&root.join("to")).0.unwrap();
        assert_eq!(meta.instances.len(), 1); assert!(meta.instances[0]["documentId"].is_null());
        assert_eq!(crate::history::history_identities(&root.join("to")).unwrap().unwrap()["a.md"], history_id);
        assert!(!crate::history::history_identities(&root.join("from")).unwrap().unwrap().contains_key("a.md"));
        assert_eq!(identity_paths(&root), vec![(A.into(), "to/a.md".into())]);
    }

    #[test]
    fn cross_directory_move_refuses_conflicting_target_images_without_changes() {
        let (_t, root) = workspace();
        fs::create_dir_all(root.join("from")).unwrap(); fs::create_dir_all(root.join("to/assets")).unwrap();
        image_setup(&root.join("from"));
        fs::write(root.join("from/a.md"), "![p](assets/img-a-v1.png)").unwrap();
        fs::write(root.join("to/assets/img-a-v1.png"), include_bytes!("../icons/64x64.png")).unwrap();
        assert_eq!(rename_or_move(&root, &op(), "from/a.md", "to/a.md", vec![], moved(&["assets/img-a-v1.png"])).unwrap_err(), "resource_conflict");
        assert!(root.join("from/a.md").exists() && !root.join("to/a.md").exists());
        assert_eq!(fs::read(root.join("to/assets/img-a-v1.png")).unwrap(), include_bytes!("../icons/64x64.png"));
        assert!(!root.join(OPERATIONS).exists() || root.join(OPERATIONS).read_dir().unwrap().next().is_none());
    }

    #[test]
    fn crash_before_move_commit_undoes_history_import_and_after_commit_finishes() {
        for stop in [Phase::Journal, Phase::Renamed] {
            let (_t, root) = workspace();
            fs::create_dir_all(root.join("from")).unwrap(); fs::create_dir_all(root.join("to")).unwrap();
            fs::write(root.join("from/a.md"), "a").unwrap();
            crate::history::history_operation_for_tests(&root.join("from/a.md"));
            let _ = rename_with(&root, &op(), "from/a.md", "to/a.md", vec![], MoveResources::default(), |at| if at == stop { Err("crash".into()) } else { Ok(()) });
            recover_all(&root).unwrap();
            let target = crate::history::history_identities(&root.join("to")).unwrap().unwrap_or_default();
            let source = crate::history::history_identities(&root.join("from")).unwrap().unwrap();
            if stop == Phase::Journal {
                assert!(root.join("from/a.md").exists() && !root.join("to/a.md").exists());
                assert!(!target.contains_key("a.md"), "abandoned import must not claim the target name");
                assert!(source.contains_key("a.md"));
            } else {
                assert!(root.join("to/a.md").exists() && !root.join("from/a.md").exists());
                assert!(target.contains_key("a.md") && !source.contains_key("a.md"));
            }
            // Both directories' history stays readable after recovery.
            crate::history::history_operation_for_tests(&root.join(if stop == Phase::Journal { "from/a.md" } else { "to/a.md" }));
        }
    }

    #[test]
    fn move_into_hidden_or_missing_directories_and_existing_history_names_is_refused() {
        let (_t, root) = workspace();
        fs::create_dir_all(root.join("to")).unwrap(); fs::write(root.join("a.md"), "a").unwrap();
        history(&root.join("to"), "a.md", B);
        assert_eq!(rename_or_move(&root, &op(), "a.md", "to/a.md", vec![], MoveResources::default()).unwrap_err(), "history_name_taken");
        assert_eq!(rename_or_move(&root, &op(), "a.md", "nope/a.md", vec![], MoveResources::default()).unwrap_err(), "target_missing");
        assert_eq!(rename_or_move(&root, &op(), "a.md", ".easym/a.md", vec![], MoveResources::default()).unwrap_err(), "invalid_name");
        assert!(root.join("a.md").exists());
    }

    #[test]
    fn lists_move_target_directories_without_hidden_ones() {
        let (_t, root) = workspace();
        for dir in ["a/b", ".easym/sync", "node_modules/x", "c"] { fs::create_dir_all(root.join(dir)).unwrap(); }
        assert_eq!(directories(&root).unwrap(), vec!["", "a", "a/b", "c"]);
    }
}
