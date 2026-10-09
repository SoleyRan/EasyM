import { getCurrentWindow } from '@tauri-apps/api/window'
import { desktop } from './storage'

export async function listenForClose(request: () => void): Promise<() => void> {
  if (!desktop) return () => undefined
  return getCurrentWindow().onCloseRequested((event) => { event.preventDefault(); request() })
}

export async function closeWindow(): Promise<void> {
  if (desktop) await getCurrentWindow().destroy()
}
