import { afterEach, expect, it, vi } from 'vitest'
const workers = vi.hoisted(() => ({ created: [] as { terminate: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn>; onmessage: ((event: { data: unknown }) => void) | null; onerror: (() => void) | null; onmessageerror: (() => void) | null }[], fails: false, sendFails: false }))
vi.mock('./history-diff-worker?worker&inline', () => ({ default: class {
  terminate = vi.fn(); postMessage = vi.fn(() => { if (workers.sendFails) throw new Error('send failed') }); onmessage = null; onerror = null; onmessageerror = null
  constructor() { if (workers.fails) throw new Error('no worker'); workers.created.push(this) }
} }))
import { analyzeMerge } from './merge'
afterEach(() => { workers.created.length = 0; workers.fails = false; workers.sendFails = false; vi.useRealTimers() })

it('sends all three independent inputs and terminates after success', async () => {
  const task = analyzeMerge('base', 'local', 'disk')
  expect(workers.created[0].postMessage).toHaveBeenCalledWith({ type: 'merge', base: 'base', local: 'local', disk: 'disk' })
  workers.created[0].onmessage?.({ data: { status: 'clean', chunks: [], conflicts: 0, text: 'merged' } })
  expect(await task).toMatchObject({ status: 'clean', text: 'merged' })
  expect(workers.created[0].terminate).toHaveBeenCalledOnce()
})
it('cancels without leaking a worker or resolving from its late result', async () => {
  const controller = new AbortController(), task = analyzeMerge('base', 'local', 'disk', controller.signal)
  const rejection = expect(task).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort(); await rejection
  workers.created[0].onmessage?.({ data: { status: 'clean', text: 'obsolete' } })
  expect(workers.created[0].terminate).toHaveBeenCalledOnce()
  await expect(analyzeMerge('', '', '', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(workers.created).toHaveLength(1)
})
it('bounds total task time and ignores late responses after fallback', async () => {
  vi.useFakeTimers()
  const task = analyzeMerge('', 'local', 'disk')
  await vi.advanceTimersByTimeAsync(10000)
  expect(await task).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('10 秒') })
  workers.created[0].onmessage?.({ data: { status: 'clean', text: 'late' } })
  expect(workers.created[0].terminate).toHaveBeenCalledOnce()
})
it('returns a safe fallback for creation, send, runtime and message failures', async () => {
  workers.fails = true
  expect(await analyzeMerge('', '', '')).toHaveProperty('status', 'unavailable')
  workers.fails = false
  for (const event of ['onerror', 'onmessageerror'] as const) {
    const task = analyzeMerge('', '', ''), worker = workers.created.at(-1)!
    worker[event]?.()
    expect(await task).toHaveProperty('status', 'unavailable')
    expect(worker.terminate).toHaveBeenCalledOnce()
  }
  workers.sendFails = true
  expect(await analyzeMerge('', '', '')).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('发送') })
  expect(workers.created.at(-1)!.terminate).toHaveBeenCalledOnce()
})
