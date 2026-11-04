//! Native confirmation prompt. macOS WKWebView under wry does not implement
//! `runJavaScriptConfirmPanel`, so `window.confirm` returns false there without
//! showing anything; the frontend routes confirmations through this command.

const MAX_MESSAGE: usize = 2000;

fn validate(message: &str) -> Result<(), String> {
    if message.trim().is_empty() || message.chars().count() > MAX_MESSAGE || message.chars().any(|c| c.is_control() && c != '\n') {
        return Err("invalid_data".into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn buttons() -> rfd::MessageButtons { rfd::MessageButtons::OkCancelCustom("确定".into(), "取消".into()) }
#[cfg(not(target_os = "macos"))]
fn buttons() -> rfd::MessageButtons { rfd::MessageButtons::OkCancel }

fn accepted(result: &rfd::MessageDialogResult) -> bool {
    match result {
        rfd::MessageDialogResult::Ok | rfd::MessageDialogResult::Yes => true,
        rfd::MessageDialogResult::Custom(label) => label == "确定",
        _ => false,
    }
}

#[tauri::command]
pub async fn confirm_dialog(message: String) -> Result<bool, String> {
    validate(&message)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = rfd::MessageDialog::new().set_level(rfd::MessageLevel::Warning).set_title("EasyM").set_description(message).set_buttons(buttons()).show();
        Ok(accepted(&result))
    }).await.map_err(|_| "io_failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_oversized_and_control_messages() {
        assert!(validate("删除？\n可撤销").is_ok());
        assert!(validate("  ").is_err());
        assert!(validate(&"字".repeat(MAX_MESSAGE + 1)).is_err());
        assert!(validate("a\u{7}b").is_err());
    }

    #[test]
    fn only_the_confirm_button_counts_as_accepted() {
        assert!(accepted(&rfd::MessageDialogResult::Ok));
        assert!(accepted(&rfd::MessageDialogResult::Custom("确定".into())));
        assert!(!accepted(&rfd::MessageDialogResult::Custom("取消".into())));
        assert!(!accepted(&rfd::MessageDialogResult::Cancel));
        assert!(!accepted(&rfd::MessageDialogResult::No));
    }
}
