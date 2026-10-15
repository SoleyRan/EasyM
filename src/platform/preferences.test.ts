// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appVersion, needsGuide, completeGuide, editorFontSize, storedPreference, storePreference, defaultAppearance, loadAppearance, saveAppearance, validateAppearance, appearanceTheme } from './preferences'
import { loadMathRendering, saveMathRendering, loadMermaidRendering, saveMermaidRendering } from './preferences'
beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())
it('keeps Mermaid independent of math and appearance, including failed writes', () => {
  expect(loadMermaidRendering()).toBe(true)
  expect(saveMermaidRendering(false)).toBe(true)
  saveMathRendering(true); saveAppearance(defaultAppearance)
  expect(loadMermaidRendering()).toBe(false)
  const storage = localStorage
  vi.stubGlobal('localStorage', { getItem: storage.getItem.bind(storage), setItem: () => { throw Error('quota') } })
  try { expect(saveMermaidRendering(true)).toBe(false); expect(loadMermaidRendering()).toBe(false) }
  finally { vi.unstubAllGlobals() }
  expect(saveMermaidRendering(true)).toBe(true)
})
it('persists math rendering independently of appearance and rejects malformed disabled values', () => {
  expect(loadMathRendering()).toBe(true)
  expect(saveMathRendering(false)).toBe(true)
  saveAppearance(defaultAppearance)
  expect(loadMathRendering()).toBe(false)
  expect(saveMathRendering(true)).toBe(true)
  expect(loadMathRendering()).toBe(true)
  localStorage.setItem('easym-math-rendering', 'false')
  expect(loadMathRendering()).toBe(true)
})
it('migrates legacy preferences and validates individual fields without discarding valid settings', () => {
  localStorage.setItem('easym-theme', 'paper'); localStorage.setItem('easym-editor-font-size', '19'); localStorage.setItem('easym-toolbar', 'hidden')
  expect(loadAppearance()).toEqual({ ...defaultAppearance, theme: 'paper', fontSize: 19, toolbar: false })
  localStorage.setItem('easym-appearance', JSON.stringify({ version: 1, fontSize: 30, lineHeight: 1.75, codeFontSize: 21, contentWidth: 800, selectionTools: false, followSystem: 'true', theme: 'unknown', extra: 'ignored' }))
  expect(loadAppearance()).toEqual({ ...defaultAppearance, theme: 'paper', fontSize: 19, toolbar: false, codeFontSize: 21, selectionTools: false })
  for (const raw of ['{broken', 'null', '{"version":2,"fontSize":22}']) {
    localStorage.setItem('easym-appearance', raw); expect(loadAppearance().fontSize).toBe(19)
  }
})
it('persists bounded appearance and independently remembers system light and dark themes', () => {
  const value = { ...defaultAppearance, fontSize: 24, codeFontSize: 10, lineHeight: 2.2, contentWidth: 1080, followSystem: true, lightTheme: 'forest' as const, darkTheme: 'paper' as const }
  expect(saveAppearance(value)).toBe(true); expect(loadAppearance()).toEqual(value)
  expect(appearanceTheme(loadAppearance(), false)).toBe('forest'); expect(appearanceTheme(loadAppearance(), true)).toBe('paper')
  expect(appearanceTheme({ ...value, followSystem: false }, true)).toBe('light')
  expect(validateAppearance({ fontSize: NaN, codeFontSize: Infinity, contentWidth: '720', lineHeight: 1.3 }).lineHeight).toBe(1.3)
})
it('reset preserves other records and denied writes preserve previously saved preferences', () => {
  localStorage.setItem('history-directory', 'D:/history'); localStorage.setItem('draft', 'keep'); completeGuide()
  saveAppearance({ ...defaultAppearance, fontSize: 20 }); const old = localStorage.getItem('easym-appearance')
  const storage = localStorage
  vi.stubGlobal('localStorage', { getItem: storage.getItem.bind(storage), setItem: () => { throw new Error('quota') } })
  expect(saveAppearance(defaultAppearance)).toBe(false); expect(storage.getItem('easym-appearance')).toBe(old)
  vi.unstubAllGlobals(); expect(saveAppearance(defaultAppearance)).toBe(true); expect(loadAppearance()).toEqual(defaultAppearance)
  expect(localStorage.getItem('history-directory')).toBe('D:/history'); expect(localStorage.getItem('draft')).toBe('keep'); expect(needsGuide()).toBe(false)
})
it('shows first-run and version-change guides until acknowledged and persists completion', () => {
  expect(needsGuide()).toBe(true)
  expect(completeGuide()).toBe(true)
  expect(needsGuide()).toBe(false)
  localStorage.setItem('easym-guide-version', '0.2.0')
  expect(needsGuide()).toBe(true)
  completeGuide()
  expect(storedPreference('easym-guide-version')).toBe(appVersion)
})
it('bounds persisted font sizes and tolerates denied storage', () => {
  for (const value of ['oops', '0', '100', '14.5']) { localStorage.setItem('easym-editor-font-size', value); expect(editorFontSize()).toBe(14) }
  localStorage.setItem('easym-editor-font-size', '20'); expect(editorFontSize()).toBe(20)
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('denied') } })
  expect(storePreference('key', 'value')).toBe(false)
  vi.unstubAllGlobals()
})
