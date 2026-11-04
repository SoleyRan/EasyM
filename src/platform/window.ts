import { getCurrentWindow } from '@tauri-apps/api/window'
import { desktop } from './storage'

export async function listenForClose(request: () => void): Promise<() => void> {
  if (!desktop) return () => undefined
  return getCurrentWindow().onCloseRequested((event) => { event.preventDefault(); request() })
}

export async function listenForFocus(request: () => void): Promise<() => void> {
  if (!desktop) return () => undefined
  return getCurrentWindow().onFocusChanged(event => { if (event.payload) request() })
}

export async function closeWindow(): Promise<void> {
  if (desktop) await getCurrentWindow().destroy()
}

export async function minimizeWindow(): Promise<void> { if (desktop) await getCurrentWindow().minimize() }
export async function toggleMaximizeWindow(): Promise<void> { if (desktop) await getCurrentWindow().toggleMaximize() }
export async function dragWindow(): Promise<void> { if (desktop) await getCurrentWindow().startDragging() }
export async function windowState(): Promise<{ maximized: boolean }> {
  if (!desktop) return { maximized: false }
  return { maximized: await getCurrentWindow().isMaximized() }
}
export async function listenWindowState(changed: () => void): Promise<() => void> {
  if (!desktop) return () => undefined
  return getCurrentWindow().onResized(changed)
}
