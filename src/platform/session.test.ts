// @vitest-environment happy-dom
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { SESSION_KEY, loadSession, saveSession, validateSession, reconcileSession } from './session'
beforeEach(() => localStorage.clear())
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
it('restores ordered surviving drafts, active tab and orphan drafts without trusting native handles', () => {
  const index = validateSession({ version: 1, tabs: [{ draftKey: 'document:b', name: '同名.md', fileId: 'stale', path: 'C:/secret' }, { draftKey: 'document:missing', name: 'missing.md' }, { draftKey: 'current', name: '中文.md' }], activeDraftKey: 'current' })
  saveSession(index)
  expect(localStorage.getItem(SESSION_KEY)).not.toContain('secret')
  expect(localStorage.getItem(SESSION_KEY)).not.toContain('stale')
  expect(reconcileSession(loadSession().index, ['current', 'document:b', 'document:orphan', 'foreign-key'])).toEqual({ version: 1, tabs: [{ draftKey: 'document:b', name: '同名.md' }, { draftKey: 'current', name: '中文.md' }, { draftKey: 'document:orphan', name: '未命名.md' }], activeDraftKey: 'current' })
  expect(reconcileSession(index, ['document:b']).activeDraftKey).toBe('document:b')
})
it('retains damaged and future-version records and still finds independent drafts', () => {
  for (const raw of ['{broken', JSON.stringify({ version: 2, tabs: [] }), 'x'.repeat(100_001)]) {
    localStorage.setItem(SESSION_KEY, raw)
    const result = loadSession()
    expect(result.index).toBeNull(); expect(result.error).toContain('无法读取')
    expect(localStorage.getItem(SESSION_KEY)).toBe(raw)
    expect(reconcileSession(result.index, ['document:safe']).activeDraftKey).toBe('document:safe')
  }
})
it('rejects duplicate, oversized, malformed keys and unknown active labels', () => {
  const tab = { draftKey: 'current', name: 'ok.md' }
  for (const value of [{ version: 1, tabs: [tab, tab], activeDraftKey: 'current' }, { version: 1, tabs: [{ ...tab, draftKey: 'native-id' }], activeDraftKey: null }, { version: 1, tabs: [tab], activeDraftKey: 'document:absent' }, { version: 1, tabs: [{ ...tab, name: 'x'.repeat(513) }], activeDraftKey: null }, { version: 1, tabs: Array.from({ length: 101 }, (_, i) => ({ ...tab, draftKey: `document:${i}` })), activeDraftKey: null }]) expect(() => validateSession(value)).toThrow()
})
it('reports denied reads and writes and does not replace the previous record', () => {
  const storage = localStorage, previous = { version: 1 as const, tabs: [], activeDraftKey: null }
  saveSession(previous)
  vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('quota') } })
  expect(loadSession().error).toContain('denied')
  expect(() => saveSession(previous)).toThrow('quota')
  expect(storage.getItem(SESSION_KEY)).toBe(JSON.stringify(previous))
})
