import { invoke } from '@tauri-apps/api/core'
import { version } from '../../package.json'

export const appVersion = version
export function loadMathRendering(): boolean { return storedPreference('easym-math-rendering') !== 'disabled' }
export function saveMathRendering(enabled: boolean): boolean { return storePreference('easym-math-rendering', enabled ? 'enabled' : 'disabled') }
export const themes = { light: '清爽浅色', dark: '午夜深色', paper: '暖纸', forest: '护眼绿' }
export type Theme = keyof typeof themes
export interface Appearance {
  version: 1; fontSize: number; lineHeight: number; contentWidth: number; codeFontSize: number; codeWrap: boolean;
  followSystem: boolean; theme: Theme; lightTheme: Theme; darkTheme: Theme; toolbar: boolean; selectionTools: boolean
}
export const defaultAppearance: Appearance = { version: 1, fontSize: 14, lineHeight: 1.6, contentWidth: 0, codeFontSize: 14, codeWrap: true, followSystem: false, theme: 'light', lightTheme: 'light', darkTheme: 'dark', toolbar: true, selectionTools: true }
const validTheme = (value: unknown, fallback: Theme): Theme => typeof value === 'string' && Object.hasOwn(themes, value) ? value as Theme : fallback
export function validateAppearance(value: unknown, fallback: Appearance = defaultAppearance): Appearance {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const integer = (key: keyof Appearance, min: number, max: number) => typeof data[key] === 'number' && Number.isInteger(data[key]) && Number(data[key]) >= min && Number(data[key]) <= max ? Number(data[key]) : Number(fallback[key])
  const boolean = (key: keyof Appearance) => typeof data[key] === 'boolean' ? data[key] as boolean : fallback[key] as boolean
  return { version: 1, fontSize: integer('fontSize', 12, 24), codeFontSize: integer('codeFontSize', 10, 22),
    lineHeight: typeof data.lineHeight === 'number' && data.lineHeight >= 1.2 && data.lineHeight <= 2.2 && Math.abs(data.lineHeight * 10 - Math.round(data.lineHeight * 10)) < 1e-8 ? data.lineHeight : fallback.lineHeight,
    contentWidth: [0, 720, 900, 1080].includes(data.contentWidth as number) ? data.contentWidth as number : fallback.contentWidth,
    codeWrap: boolean('codeWrap'), followSystem: boolean('followSystem'), toolbar: boolean('toolbar'), selectionTools: boolean('selectionTools'),
    theme: validTheme(data.theme, fallback.theme), lightTheme: validTheme(data.lightTheme, fallback.lightTheme), darkTheme: validTheme(data.darkTheme, fallback.darkTheme) }
}
export function loadAppearance(): Appearance {
  const legacy = { ...defaultAppearance, fontSize: editorFontSize(), theme: validTheme(storedPreference('easym-theme'), 'light'), toolbar: storedPreference('easym-toolbar') !== 'hidden', selectionTools: storedPreference('easym-selection-tools') !== 'hidden' }
  try { const value = JSON.parse(storedPreference('easym-appearance') ?? 'null'); return value?.version === 1 ? validateAppearance(value, legacy) : legacy } catch { return legacy }
}
export function saveAppearance(value: Appearance): boolean {
  const validated = validateAppearance(value)
  // Write the validated structure first. Never clear unrelated or failed records.
  if (!storePreference('easym-appearance', JSON.stringify(validated))) return false
  return [['easym-theme', validated.theme], ['easym-editor-font-size', String(validated.fontSize)], ['easym-toolbar', validated.toolbar ? 'visible' : 'hidden'], ['easym-selection-tools', validated.selectionTools ? 'visible' : 'hidden']].map(([key, item]) => storePreference(key, item)).every(Boolean)
}
export function appearanceTheme(value: Appearance, dark: boolean): Theme { return value.followSystem ? dark ? value.darkTheme : value.lightTheme : value.theme }
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
