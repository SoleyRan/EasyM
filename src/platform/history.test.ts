import { afterEach, expect, it, vi } from 'vitest'
const workers = vi.hoisted(() => ({ created: [] as { terminate: ReturnType<typeof vi.fn>; onmessage: ((event: { data: unknown }) => void) | null; onerror: (() => void) | null }[] }))
vi.mock('./history-diff-worker?worker&inline', () => ({ default: class {
  terminate = vi.fn(); postMessage = vi.fn(); onmessage = null; onerror = null
  constructor() { workers.created.push(this) }
} }))
import { compareHistory, historyInput, historyReferences, relocateHistoryImages } from './history'
import { unarchivedHistoryReferences } from '../core/history-resources'
afterEach(() => { workers.created.length = 0; vi.useRealTimers() })

it('rewrites inline and reference destinations without touching alt, title, prose or code', () => {
  const input = 'same assets/a.png\n\n![alt](assets/a.png "title")\n\n![ref][pic]\n\n[pic]: <assets/a.png> "caption"\n\n`![code](assets/a.png)`'
  const output = relocateHistoryImages(input, { 'assets/a.png': 'assets/img-history-hash.png' })
  expect(output).toContain('same assets/a.png')
  expect(output).toContain('![alt](assets/img-history-hash.png "title")')
  expect(output).toContain('[pic]: <assets/img-history-hash.png> "caption"')
  expect(output).toContain('`![code](assets/a.png)`')
})
it('archives only safe local image references and relevant in-memory assets', async () => {
  expect(historyReferences('![a](./assets/a.png) ![b](https://example.com/b.png) ![c](../c.png) ![d](C:/d.png)')).toEqual(['assets/a.png'])
  const bytes = new TextEncoder().encode('![a](assets/a.png)')
  const input = await historyInput(bytes, { assets: { 'assets/a.png': new Blob(['image']), 'assets/orphan.png': new Blob(['orphan']) }, instances: [] }, 'disk-hash')
  expect(input.assets.map(a => a.path)).toEqual(['assets/a.png'])
  expect(input.diskRevision).toBe('disk-hash'); expect(input.bytes).toEqual(Array.from(bytes))
  expect(unarchivedHistoryReferences('![a](../a.png) ![b](https://example.com/a.png) ![c](C:/a.png)')).toEqual(['../a.png', 'C:/a.png'])
})
it('terminates cancelled workers and does not start an already cancelled task', async () => {
  const controller = new AbortController(), task = compareHistory('before', 'after', controller.signal)
  const rejection = expect(task).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort(); await rejection
  expect(workers.created[0].terminate).toHaveBeenCalledOnce()
  await expect(compareHistory('before', 'after', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(workers.created).toHaveLength(1)
})
it('terminates timed-out and failed workers and returns a full-text fallback', async () => {
  vi.useFakeTimers()
  const task = compareHistory('before', 'after'); await vi.advanceTimersByTimeAsync(10000)
  expect((await task).fallback).toContain('10 秒'); expect(workers.created[0].terminate).toHaveBeenCalledOnce()
  const failed = compareHistory('before', 'after'); workers.created[1].onerror?.()
  expect((await failed).fallback).toContain('失败'); expect(workers.created[1].terminate).toHaveBeenCalledOnce()
})
