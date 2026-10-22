mod storage;
mod resources;
mod transaction;
mod workspace;
mod clipboard;
mod export;
mod history;
mod links;
mod recent;
mod merge;
mod backup;
mod sync_identity;

pub fn run() {
    tauri::Builder::default()
        .manage(storage::Storage::default())
        .manage(backup::Backups::default())
        .manage(workspace::Workspaces::default())
        .setup(recent::setup)
        .invoke_handler(tauri::generate_handler![storage::open_document, storage::close_document, storage::inspect_document, storage::reload_document, storage::save_document, storage::read_image, workspace::open_workspace, workspace::list_workspace, workspace::search_workspace, workspace::search_workspace_filenames, workspace::cancel_workspace_search, workspace::open_workspace_document, workspace::read_workspace_image, clipboard::read_clipboard_image_files, export::export_html, export::export_docx, export::print_document, history::history_operation, history::history_directory, links::open_external_link, recent::recent_state, recent::remember_session, recent::forget_recent, recent::reopen_recent_file, recent::reopen_recent_workspace, merge::prepare_merge, merge::commit_merge, merge::merge_recovery, backup::create_document_backup, backup::inspect_document_backup, backup::restore_document_backup, backup::release_document_backup, sync_identity::sync_identity_scan, sync_identity::sync_identity_write, sync_identity::sync_identity_remove])
        .run(tauri::generate_context!())
        .expect("error while running Easy Markdown");
}
