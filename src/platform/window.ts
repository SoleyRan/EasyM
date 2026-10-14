import { getCurrentWindow } from '@tauri-apps/api/window'
import { desktop } from './storage'

export async function listenForClose(request: () => void): Promise<() => void> {
  if (!desktop) return () => undefined
  return getCurrentWindow().onCloseRequested((event) => { event.preventDefault(); request() })
}

export async function closeWindow(): Promise<void> {
  if (desktop) await getCurrentWindow().destroy()
}

export async function minimizeWindow(): Promise<void> { if (desktop) await getCurrentWindow().minimize() }
export async function toggleMaximizeWindow(): Promise<void> { if (desktop) await getCurrentWindow().toggleMaximize() }
export async function dragWindow(): Promise<void> { if (desktop) await getCurrentWindow().startDragging() }
export async function windowState(): Promise<{ maximized: boolean; fullscreen: boolean }> {
  if (!desktop) return { maximized: false, fullscreen: !!document.fullscreenElement }
  const win = getCurrentWindow()
  const [maximized, fullscreen] = await Promise.all([win.isMaximized(), win.isFullscreen()])
  return { maximized, fullscreen }
}
export async function setFullscreen(fullscreen: boolean): Promise<void> {
  if (desktop) await getCurrentWindow().setFullscreen(fullscreen)
  else if (fullscreen && !document.fullscreenElement) await document.documentElement.requestFullscreen()
  else if (!fullscreen && document.fullscreenElement) await document.exitFullscreen()
}
export async function listenWindowState(changed: () => void): Promise<() => void> {
  if (desktop) return getCurrentWindow().onResized(changed)
  document.addEventListener('fullscreenchange', changed)
  return () => document.removeEventListener('fullscreenchange', changed)
}
