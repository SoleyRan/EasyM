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
mod workspace_ops;
mod sync_native;
mod sync_local;

pub fn run() {
    tauri::Builder::default()
        .manage(storage::Storage::default())
        .manage(backup::Backups::default())
        .manage(workspace::Workspaces::default())
        .setup(|app| { recent::setup(app)?; sync_native::setup(app) })
        .invoke_handler(tauri::generate_handler![storage::open_document, storage::close_document, storage::inspect_document, storage::reload_document, storage::save_document, storage::read_image, workspace::open_workspace, workspace::list_workspace, workspace::search_workspace, workspace::search_workspace_filenames, workspace::cancel_workspace_search, workspace::open_workspace_document, workspace::read_workspace_image, clipboard::read_clipboard_image_files, export::export_html, export::export_docx, export::print_document, history::history_operation, history::history_directory, links::open_external_link, recent::recent_state, recent::remember_session, recent::forget_recent, recent::reopen_recent_file, recent::reopen_recent_workspace, merge::prepare_merge, merge::commit_merge, merge::merge_recovery, backup::create_document_backup, backup::inspect_document_backup, backup::restore_document_backup, backup::release_document_backup, sync_identity::sync_identity_scan, sync_identity::sync_identity_write, sync_identity::sync_identity_remove, workspace_ops::workspace_rename_prepare, workspace_ops::workspace_rename, workspace_ops::workspace_directories, workspace_ops::workspace_trash, workspace_ops::workspace_trash_list, workspace_ops::workspace_trash_restore, sync_native::sync_binding, sync_native::sync_probe, sync_native::sync_probe_workspace, sync_native::sync_bind, sync_native::sync_unbind, sync_native::sync_rejoin, sync_native::sync_state_read, sync_native::sync_state_write, sync_native::sync_heads, sync_native::sync_head, sync_native::sync_publish, sync_native::sync_object, sync_native::sync_put_object, sync_native::sync_retired, sync_native::sync_retire, sync_native::sync_device_info, sync_native::sync_publish_info, sync_local::sync_local_revisions, sync_local::sync_local_read, sync_local::sync_local_asset, sync_local::sync_local_write, sync_local::sync_local_move, sync_local::sync_local_trash, sync_local::sync_local_open, sync_local::sync_local_resolve])
        .run(tauri::generate_context!())
        .expect("error while running Easy Markdown");
}
