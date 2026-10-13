// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { createDocxModel, DocxQuotaError } from '../core/docx-model'
import { preflightDocx, renderDocx, saveDocx } from './docx'

const mocks = vi.hoisted(() => ({ read: vi.fn(), invoke: vi.fn(), behavior: undefined as undefined | ((request: { type: string }) => unknown), workers: [] as Array<{ terminated: boolean }> }))
vi.mock('./storage', () => ({ desktop: true, readImageBlob: mocks.read }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('./docx-worker?worker&inline', () => ({ default: class {
  terminated = false
  onmessage?: (event: { data: unknown }) => void
  constructor() { mocks.workers.push(this) }
  terminate() { this.terminated = true }
  postMessage(request: { type: string; text: string; name: string }) {
    queueMicrotask(() => {
      if (this.terminated) return
      if (mocks.behavior) { this.onmessage?.({ data: mocks.behavior(request) }); return }
      this.onmessage?.({ data: { value: request.type === 'parse' ? createDocxModel(request.text, request.name) : request.type === 'decode' ? { width: 128, height: 128 } : new ArrayBuffer(8) } })
    })
  }
} }))
const png = () => new Blob([readFileSync('Docs/samples/v0.3/assets/em.png')])
const source = (text = '![当前显示](assets/display.png)') => ({ text, name: '测试.md', id: 'authorized-document', resources: { assets: {} as Record<string, Blob>, instances: [] } })
afterEach(() => {
  expect(mocks.workers.every(worker => worker.terminated)).toBe(true)
  mocks.workers.length = 0; mocks.behavior = undefined
  mocks.read.mockReset(); mocks.invoke.mockReset(); vi.useRealTimers()
})

it('reads current display bytes from memory before disk and snapshots document authority', async () => {
  const input = source(), blob = png(); input.resources.assets['assets/display.png'] = blob
  const promise = preflightDocx(input)
  input.resources.assets = {}; input.id = 'other-document'
  const prepared = await promise
  expect(prepared.assets).toHaveLength(1)
  expect(mocks.read).not.toHaveBeenCalled()
  expect(prepared.assets[0].bytes).toEqual(new Uint8Array(await blob.arrayBuffer()))
})

it('only reads safe relative PNG/JPEG paths via the current authorized document id', async () => {
  mocks.read.mockResolvedValue(png())
  const prepared = await preflightDocx(source('![local](assets/display.png)\n\n![remote](https://example.invalid/x.png)\n\n![escape](%2e%2e/x.png)\n\n![absolute](C:/private.png)\n\n![svg](assets/x.svg)'))
  expect(mocks.read).toHaveBeenCalledExactlyOnceWith('authorized-document', 'assets/display.png')
  expect(prepared.model.warnings.imageFailures).toBe(4)
  const draft = source(); draft.id = ''
  await preflightDocx(draft)
  expect(mocks.read).toHaveBeenCalledTimes(1)
})

it('cancels in-flight resource reads and stops subsequent loads without stale completion', async () => {
  let finish!: (value: Blob) => void
  mocks.read.mockImplementation(() => new Promise<Blob>(resolve => { finish = resolve }))
  const controller = new AbortController(), pending = preflightDocx(source('![one](assets/one.png)\n\n![two](assets/two.png)'), controller.signal)
  await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1))
  controller.abort()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  finish(png()); await Promise.resolve()
  expect(mocks.read).toHaveBeenCalledTimes(1)
})

it('treats resource timeouts and quota errors as hard failures, never placeholders', async () => {
  mocks.read.mockRejectedValue('quota_exceeded')
  await expect(preflightDocx(source())).rejects.toBeInstanceOf(DocxQuotaError)
  mocks.read.mockImplementation(() => new Promise(() => {}))
  vi.useFakeTimers()
  const pending = preflightDocx(source())
  const assertion = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
  await vi.advanceTimersByTimeAsync(15_000)
  await assertion
})

it('propagates worker quota errors and cleans up when generation fails', async () => {
  const prepared = await preflightDocx(source('text'))
  mocks.behavior = () => ({ error: { code: 'quota_exceeded', name: 'DocxQuotaError', message: 'output too large' } })
  await expect(renderDocx(prepared, { page: 'a4', style: 'default', allowImagePlaceholders: true })).rejects.toBeInstanceOf(DocxQuotaError)
})

it('uses the independent binary native save command and preserves dialog cancellation', async () => {
  const bytes = new Uint8Array([80, 75, 3, 4]).buffer
  mocks.invoke.mockResolvedValue(false)
  expect(await saveDocx('测试.docx', bytes)).toBe(false)
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('export_docx', { name: '测试.docx', bytes: [80, 75, 3, 4] })
  await expect(saveDocx('../test.docx', bytes)).rejects.toThrow('文件名')
  const controller = new AbortController(); controller.abort()
  await expect(saveDocx('测试.docx', bytes, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(mocks.invoke).toHaveBeenCalledTimes(1)
})
