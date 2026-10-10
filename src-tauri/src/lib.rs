mod storage;
mod resources;
mod transaction;
mod workspace;
mod clipboard;
mod export;

pub fn run() {
    tauri::Builder::default()
        .manage(storage::Storage::default())
        .manage(workspace::Workspaces::default())
        .invoke_handler(tauri::generate_handler![storage::open_document, storage::close_document, storage::reload_document, storage::save_document, storage::read_image, workspace::open_workspace, workspace::list_workspace, workspace::search_workspace, workspace::cancel_workspace_search, workspace::open_workspace_document, workspace::read_workspace_image, clipboard::read_clipboard_image_files, export::export_html, export::print_document])
        .run(tauri::generate_context!())
        .expect("error while running Easy Markdown");
}
