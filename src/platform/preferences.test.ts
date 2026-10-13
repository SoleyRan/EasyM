// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appVersion, needsGuide, completeGuide, editorFontSize, storedPreference, storePreference } from './preferences'
beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())
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
