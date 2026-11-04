import { invoke } from '@tauri-apps/api/core'
import { desktop } from './storage'

// wry does not implement WKWebView's JavaScript confirm panel, so on macOS
// `window.confirm` returns false without showing anything. WebView2 and
// WebKitGTK show their own dialogs and keep using `window.confirm`.
const nativeConfirm = () => desktop && /Mac/i.test(navigator.platform)

export async function confirmAction(message: string): Promise<boolean> {
  if (!nativeConfirm()) return window.confirm(message)
  return invoke<boolean>('confirm_dialog', { message })
}
