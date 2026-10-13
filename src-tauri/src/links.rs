fn validate_external(url: &str) -> Result<(), String> {
    if url.len() > 4096 || url.chars().any(|c| c.is_control() || c.is_whitespace() || matches!(c, '\\' | '<' | '>')) {
        return Err("unsafe_link".into());
    }
    for part in url.as_bytes().windows(3) {
        if part[0] == b'%' {
            if let Some(value) = std::str::from_utf8(&part[1..]).ok().and_then(|s| u8::from_str_radix(s, 16).ok()) {
                if value < 32 || value == 127 || value == b'\\' { return Err("unsafe_link".into()); }
            }
        }
    }
    let parsed = tauri::Url::parse(url).map_err(|_| "unsafe_link")?;
    if !matches!(parsed.scheme(), "https" | "http" | "mailto") || !parsed.username().is_empty() || parsed.password().is_some()
        || (matches!(parsed.scheme(), "http" | "https") && parsed.host_str().is_none()) {
        return Err("unsafe_link".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn open_external_link(url: String) -> Result<(), String> {
    validate_external(&url)?;
    tauri::async_runtime::spawn_blocking(move || open(&url)).await.map_err(|_| "open_link_failed".to_string())?
}

#[cfg(windows)]
fn open(url: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    let target: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
    let verb: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
    let result = unsafe { ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), target.as_ptr(), std::ptr::null(), std::ptr::null(), 1) };
    if result as isize <= 32 { Err("open_link_failed".into()) } else { Ok(()) }
}

#[cfg(not(windows))]
fn open(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(not(target_os = "macos"))]
    let mut command = std::process::Command::new("xdg-open");
    command.arg(url).status().map_err(|_| "open_link_failed".to_string()).and_then(|s| if s.success() { Ok(()) } else { Err("open_link_failed".into()) })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn limits_external_targets() {
        for url in ["https://example.com/中文?a=b", "http://localhost:8080", "mailto:test@example.com?subject=hello"] { assert!(validate_external(url).is_ok()); }
        for url in ["javascript:alert(1)", "file:///C:/private.md", "data:text/html,x", "//example.com", "../doc.md", "--help", "https://user:pass@example.com", "https://example.com/%0a", "mailto:a%0Db@example.com", "https://example.com\\x", "https://example.com/\n"] { assert!(validate_external(url).is_err(), "{url}"); }
    }
}
