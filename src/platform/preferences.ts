import { invoke } from '@tauri-apps/api/core'
import { version } from '../../package.json'

export const appVersion = version
export const themes = { light: '清爽浅色', dark: '午夜深色', paper: '暖纸', forest: '护眼绿' }
export type Theme = keyof typeof themes
export function storedPreference(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
export function storePreference(key: string, value: string): boolean {
  try { localStorage.setItem(key, value); return true } catch { return false }
}
export function needsGuide(): boolean { return storedPreference('easym-guide-version') !== appVersion }
export function completeGuide(): boolean { return storePreference('easym-guide-version', appVersion) }
export function editorFontSize(): number {
  const size = Number(storedPreference('easym-editor-font-size'))
  return Number.isInteger(size) && size >= 12 && size <= 24 ? size : 14
}
export interface HistoryDirectory { path: string; documentDirectory: string; custom: boolean; retainedPath?: string; backupPath?: string | null }
export const historyDirectory = (id: string, action: 'status' | 'choose' | 'reset') => invoke<HistoryDirectory | null>('history_directory', { id, action })
