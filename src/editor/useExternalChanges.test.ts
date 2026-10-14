// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useExternalChanges } from './useExternalChanges'
import { inspectDocument } from '../platform/storage'

vi.mock('../platform/storage', () => ({ desktop: true, inspectDocument: vi.fn() }))
vi.mock('../platform/window', () => ({ listenForFocus: async () => () => undefined }))
let root: Root, node: HTMLDivElement, result: ReturnType<typeof useExternalChanges>
beforeEach(() => {
  vi.useFakeTimers(); vi.mocked(inspectDocument).mockReset()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  node = document.createElement('div'); document.body.append(node); root = createRoot(node)
})
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.useRealTimers(); vi.restoreAllMocks() })
function Harness({ id = 'a', revision = 'base', enabled = true }) { result = useExternalChanges(id, revision, enabled); return null }
async function render(props = {}) { await act(async () => root.render(createElement(Harness, props))) }
async function advance(ms = 150) { await act(async () => vi.advanceTimersByTimeAsync(ms)) }
const disk = (revision: string, text: string) => ({ revision, bytes: new TextEncoder().encode(text) })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }

it('detects raw-byte changes even when normalized text is equal, and blocks writes until a new baseline', async () => {
  vi.mocked(inspectDocument).mockResolvedValueOnce(disk('external', '\uFEFF# body\r\n')).mockResolvedValue({ revision: 'external', bytes: null })
  await render()
  expect(result.change).toMatchObject({ revision: 'external', snapshot: { text: '# body\n', encoding: 'utf-8-bom', lineEnding: 'crlf' } })
  expect(result.blocked.current).toBe(true)
  await render({ revision: 'external' })
  expect(result.change).toBe(null); expect(result.blocked.current).toBe(false)
})

it('keeps at most one native read and discards a result from the previous tab generation', async () => {
  const first = deferred<Awaited<ReturnType<typeof inspectDocument>>>()
  vi.mocked(inspectDocument).mockReturnValueOnce(first.promise).mockResolvedValue({ revision: 'base', bytes: null })
  await render(); await render({ enabled: false }); await render({ id: 'b' })
  expect(inspectDocument).toHaveBeenCalledTimes(1)
  await act(async () => first.resolve(disk('old-a', '# old tab'))); await advance()
  expect(inspectDocument).toHaveBeenCalledTimes(2)
  expect(inspectDocument).toHaveBeenLastCalledWith('b', 'base')
  expect(result.change).toBe(null); expect(result.blocked.current).toBe(false)
})

it('debounces focus checks without reading on body renders', async () => {
  vi.mocked(inspectDocument).mockResolvedValue({ revision: 'base', bytes: null })
  await render(); await render(); await render()
  expect(inspectDocument).toHaveBeenCalledTimes(1)
  await act(async () => { for (let i = 0; i < 5; i++) window.dispatchEvent(new Event('focus')) })
  await advance(); expect(inspectDocument).toHaveBeenCalledTimes(2)
})

it('retains a timed-out read slot, blocks writes, and ignores its late result', async () => {
  const first = deferred<Awaited<ReturnType<typeof inspectDocument>>>()
  vi.mocked(inspectDocument).mockReturnValueOnce(first.promise).mockResolvedValue({ revision: 'base', bytes: null })
  await render(); await advance(10000)
  expect(result.change).toMatchObject({ error: expect.stringContaining('超时') }); expect(result.blocked.current).toBe(true)
  await act(async () => result.recheck()); await advance()
  expect(inspectDocument).toHaveBeenCalledTimes(1)
  await act(async () => first.resolve(disk('late', '# obsolete'))); await advance()
  expect(inspectDocument).toHaveBeenCalledTimes(2); expect(result.change).toBe(null)
})

it('preserves missing or unreadable disk errors and invalid UTF-8 instead of replacing memory', async () => {
  vi.mocked(inspectDocument).mockRejectedValueOnce('resource_missing').mockResolvedValueOnce({ revision: 'invalid', bytes: new Uint8Array([0xff]) })
  await render(); expect(result.change).toEqual({ error: 'resource_missing' }); expect(result.blocked.current).toBe(true)
  await act(async () => result.recheck()); await advance()
  expect(result.change).toHaveProperty('error'); expect(result.blocked.current).toBe(true)
})

it('also bounds waiting on an obsolete generation without starting another native read', async () => {
  const first = deferred<Awaited<ReturnType<typeof inspectDocument>>>()
  vi.mocked(inspectDocument).mockReturnValue(first.promise)
  await render(); await render({ enabled: false }); await render({ id: 'b' }); await advance(10000)
  expect(inspectDocument).toHaveBeenCalledTimes(1)
  expect(result.change).toMatchObject({ error: expect.stringContaining('上一项') }); expect(result.checking).toBe(false)
  await act(async () => root.unmount()); root = createRoot(node)
  await act(async () => first.resolve(disk('old-a', '# obsolete')))
})
