// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { usePreview } from './usePreview'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const tasks = vi.hoisted(() => [] as Array<{ terminate: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn>; onmessage?: (event: { data: unknown }) => void }>)
const presentation = vi.hoisted(() => vi.fn(async (parsed: { html: string }) => parsed))
vi.mock('../platform/mermaid', () => ({ renderMermaid: presentation }))
vi.mock('../platform/markdown-worker?worker&inline', () => ({ default: class {
  terminate = vi.fn(); postMessage = vi.fn()
  constructor() { tasks.push(this) }
} }))
afterEach(() => { vi.useRealTimers(); tasks.length = 0; presentation.mockImplementation(async parsed => parsed) })
it('terminates pending and timed-out parses, rejects stale text/options and retries after editing', async () => {
  vi.useFakeTimers()
  const host = document.createElement('div'), root = createRoot(host), error = vi.fn()
  let current: ReturnType<typeof usePreview>
  function Probe({ text, math }: { text: string; math: boolean }) { current = usePreview(text, error, math); return null }
  const render = async (text: string, math: boolean) => { await act(async () => { root.render(createElement(Probe, {text,math})) }); await act(async () => { await vi.advanceTimersByTimeAsync(120) }) }
  try {
    await render('$x$', true)
    const first = tasks[0], stale = first.onmessage!
    await render('$x$', false)
    expect(first.terminate).toHaveBeenCalledTimes(1)
    expect(current!.parsedText.current).toBe('')
    expect(tasks[1].postMessage).toHaveBeenCalledWith(expect.objectContaining({ text:'$x$', options:{math:false} }))
    const parsed = { html:'current', images:[], headings:[] }
    await act(async () => { stale({data:{revision:1,parsed:{...parsed,html:'stale'}}}); tasks[1].onmessage!({data:{revision:3,parsed}}) })
    expect(current!.parsed.html).toBe('current')
    expect(current!.parsedText.current).toBe('$x$')
    await render('$y$', false)
    expect(current!.parsedText.current).toBe('$x$')
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(tasks[1].terminate).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('超时'))
    expect(current!.parsed.html).toBe('')
    await render('$z$', true)
    expect(tasks).toHaveLength(3)
    await act(async () => { tasks[2].onmessage!({data:{revision:7,parsed}}) })
    expect(current!.parsedText.current).toBe('$z$')
  } finally { await act(async () => { root.unmount() }) }
  expect(tasks[2].terminate).toHaveBeenCalledTimes(1)
})

it('aborts diagram presentation on theme/settings/text changes and ignores a late result', async () => {
  vi.useFakeTimers()
  const pending: Array<{ resolve(parsed: { html: string }): void; signal: AbortSignal }> = []
  presentation.mockImplementation((...args: unknown[]) => new Promise(resolve => pending.push({ resolve, signal: args[3] as AbortSignal })))
  const host = document.createElement('div'), root = createRoot(host)
  let current: ReturnType<typeof usePreview>
  function Probe({ theme, enabled }: { theme: string; enabled: boolean }) { current = usePreview('same source', vi.fn(), true, enabled, theme); return null }
  const render = async (theme: string, enabled = true) => {
    await act(async () => { root.render(createElement(Probe, { theme, enabled })); await vi.advanceTimersByTimeAsync(120) })
    await act(async () => { await vi.advanceTimersByTimeAsync(120) })
  }
  const parsed = { html: 'source', images: [], headings: [] }
  try {
    await render('light')
    await act(async () => tasks[0].onmessage!({ data: { revision: 1, parsed } }))
    await render('dark')
    expect(pending[0].signal.aborted).toBe(true)
    await act(async () => { pending[0].resolve({ html: 'old image' }) })
    expect(current!.parsed.html).toBe('source')
    await act(async () => tasks[0].onmessage!({ data: { revision: 3, parsed } }))
    await render('dark', false)
    expect(pending[1].signal.aborted).toBe(true)
    await act(async () => { pending[1].resolve({ html: 'disabled image' }) })
    expect(current!.parsed.html).toBe('source')
    await act(async () => tasks[0].onmessage!({ data: { revision: 5, parsed } }))
  } finally { await act(async () => root.unmount()) }
  expect(pending[2].signal.aborted).toBe(true)
})
