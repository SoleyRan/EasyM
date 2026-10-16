import { afterEach, expect, it, vi } from 'vitest'
const workers = vi.hoisted(() => ({ created: [] as { terminate: ReturnType<typeof vi.fn>; onmessage: ((event: { data: unknown }) => void) | null; onerror: (() => void) | null }[] }))
vi.mock('./history-diff-worker?worker&inline', () => ({ default: class {
  terminate = vi.fn(); postMessage = vi.fn(); onmessage = null; onerror = null
  constructor() { workers.created.push(this) }
} }))
import { collectHistoryResources } from './history-resources'
afterEach(() => { workers.created.length = 0; vi.useRealTimers() })
it('scans small input without a worker and preserves unauthorized reference information', async () => {
  expect(await collectHistoryResources(['![a](assets/a.png) ![b](../b.png)'])).toEqual([{ references: ['assets/a.png'], unarchivedReferences: ['../b.png'] }])
  expect(workers.created).toHaveLength(0)
})
it('moves large scans into a worker and terminates after receiving the result', async () => {
  const task = collectHistoryResources(['x'.repeat(65536)])
  workers.created[0].onmessage?.({ data: { references: [{ references: [], unarchivedReferences: [] }] } })
  expect(await task).toEqual([{ references: [], unarchivedReferences: [] }])
  expect(workers.created[0].terminate).toHaveBeenCalledOnce()
})
it('moves aggregate small snapshots off the UI thread and terminates the worker', async () => {
  const task = collectHistoryResources(['x'.repeat(40000), 'y'.repeat(40000)])
  const references = [{ references: [], unarchivedReferences: [] }, { references: [], unarchivedReferences: [] }]
  expect(workers.created).toHaveLength(1)
  workers.created[0].onmessage?.({ data: { references } })
  expect(await task).toEqual(references)
  expect(workers.created[0].terminate).toHaveBeenCalledOnce()
})
it('terminates failed and timed-out scans so callers can skip history without failing normal saves', async () => {
  vi.useFakeTimers()
  const task = collectHistoryResources(['x'.repeat(65536)]), assertion = expect(task).rejects.toThrow('history_analysis_failed')
  await vi.advanceTimersByTimeAsync(10000); await assertion
  expect(workers.created[0].terminate).toHaveBeenCalledOnce()
  const failed = collectHistoryResources(['x'.repeat(65536)]), rejected = expect(failed).rejects.toThrow('history_analysis_failed')
  workers.created[1].onerror?.(); await rejected
  expect(workers.created[1].terminate).toHaveBeenCalledOnce()
})
