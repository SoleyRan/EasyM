use std::path::Path;
use serde::Serialize;
use crate::storage::{self, ImageFile};

#[derive(Serialize)]
pub struct ClipboardImage { name: String, #[serde(flatten)] image: ImageFile }

fn is_image(path: &Path) -> bool {
    path.extension().and_then(|value| value.to_str()).map(|value| matches!(value.to_ascii_lowercase().as_str(), "png" | "jpg" | "jpeg")).unwrap_or(false)
}

// Called only from the explicit paste gesture. No clipboard polling or writes.
#[tauri::command]
pub async fn read_clipboard_image_files() -> Result<Vec<ClipboardImage>, String> {
    tauri::async_runtime::spawn_blocking(read_files).await.map_err(|_| "io_failed".to_string())?
}

#[cfg(not(windows))]
fn read_files() -> Result<Vec<ClipboardImage>, String> { Ok(Vec::new()) }

#[cfg(windows)]
fn read_files() -> Result<Vec<ClipboardImage>, String> {
    use std::{ffi::OsString, os::windows::ffi::OsStringExt, path::PathBuf, ptr};
    use windows_sys::Win32::{System::DataExchange::{OpenClipboard, CloseClipboard, IsClipboardFormatAvailable, GetClipboardData}, UI::Shell::DragQueryFileW};
    const CF_HDROP: u32 = 15;
    struct Clipboard;
    impl Drop for Clipboard { fn drop(&mut self) { unsafe { CloseClipboard(); } } }
    let paths = unsafe {
        if IsClipboardFormatAvailable(CF_HDROP) == 0 { return Ok(Vec::new()); }
        if OpenClipboard(ptr::null_mut()) == 0 { return Err("clipboard_busy".into()); }
        let _guard = Clipboard;
        let handle = GetClipboardData(CF_HDROP);
        if handle.is_null() { return Err("invalid_data".into()); }
        let count = DragQueryFileW(handle, u32::MAX, ptr::null_mut(), 0);
        if count > 64 { return Err("quota_exceeded".into()); }
        let mut paths = Vec::new();
        for index in 0..count {
            let length = DragQueryFileW(handle, index, ptr::null_mut(), 0);
            if length == 0 || length > 32767 { return Err("invalid_data".into()); }
            let mut value = vec![0u16; length as usize + 1];
            if DragQueryFileW(handle, index, value.as_mut_ptr(), value.len() as u32) != length { return Err("invalid_data".into()); }
            let path = PathBuf::from(OsString::from_wide(&value[..length as usize]));
            if is_image(&path) { paths.push(path); }
        }
        paths
    }; // Release the clipboard before file I/O.
    if paths.len() > 1 { return Err("multiple_clipboard_images".into()); }
    paths.into_iter().map(|path| {
        let path = path.canonicalize().map_err(|_| "resource_missing")?;
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        Ok(ClipboardImage { name, image: storage::read_image_path(&path)? })
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clipboard_file_filter_accepts_only_supported_extensions() {
        for name in ["图片.PNG", "photo.jpeg", "photo.JpG"] { assert!(is_image(Path::new(name))); }
        for name in ["image.svg", "note.md", "image.png.exe", "folder"] { assert!(!is_image(Path::new(name))); }
    }
}
