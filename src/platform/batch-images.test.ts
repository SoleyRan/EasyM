import { afterEach, expect, it, vi } from 'vitest'
import { defaultRecipe } from '../core/images'
const state = vi.hoisted(() => ({ workers: [] as { terminate: ReturnType<typeof vi.fn>; onmessage: ((e: { data: unknown }) => void) | null }[], reads: vi.fn(), process: vi.fn() }))
vi.mock('./storage', () => ({ readImageBlob: state.reads }))
vi.mock('./images', () => ({ processImage: state.process, sourceHash: async () => 'sha256:hash' }))
vi.mock('./history-diff-worker?worker&inline', () => ({ default: class { terminate = vi.fn(); onmessage = null; onerror = null; postMessage = vi.fn(); constructor() { state.workers.push(this) } } }))
import { collectBatchReferences, generateBatch, prepareBatch, type BatchItem } from './batch-images'
const options = { maxSide: 100, format: 'keep' as const, quality: .8, stripMetadata: true, background: null }
afterEach(() => { state.workers.length = 0; state.process.mockReset(); vi.useRealTimers() })
it('terminates large AST scans on cancellation and timeout', async () => {
  const controller = new AbortController(), pending = collectBatchReferences('x'.repeat(65536), controller.signal), rejected = expect(pending).rejects.toThrow('已取消')
  controller.abort(); await rejected; expect(state.workers[0].terminate).toHaveBeenCalledOnce()
  vi.useFakeTimers(); const timeout = collectBatchReferences('x'.repeat(65536)), assertion = expect(timeout).rejects.toThrow('超时')
  await vi.advanceTimersByTimeAsync(10000); await assertion; expect(state.workers[1].terminate).toHaveBeenCalledOnce()
})
it('aborts an entire batch after a later image fails without exposing earlier output', async () => {
  const source = new Blob(['source']), item: BatchItem = { reference: { from: 0, to: 25, url: 'assets/img-old.png', path: 'assets/img-old.png', alt: 'x' }, source, width: 400, height: 200, mime: 'image/png' }
  state.process.mockResolvedValueOnce({ blob: new Blob(['result']), width: 100, height: 50, mime: 'image/png' }).mockRejectedValueOnce(new Error('second failed'))
  const progress = vi.fn(); await expect(generateBatch([item, item], options, 'file', new AbortController().signal, progress)).rejects.toThrow('second failed')
  expect(progress).toHaveBeenCalledOnce(); expect(state.process).toHaveBeenCalledTimes(2)
})
it('retains old source/display recipes for undo and prepares only one body patch per selected occurrence', async () => {
  const text = '![a](assets/img-old.png)', reference = (await collectBatchReferences(text))[0]
  const old = { instanceId: 'img-old', documentId: 'file', sourcePath: 'assets/.originals/img-old.png', displayPath: 'assets/img-old.png', sourceHash: 'sha256:old', recipe: defaultRecipe(), referenceRevision: 1 }
  const instance = { ...old, instanceId: 'img-new', sourcePath: 'assets/.originals/img-new.png', displayPath: 'assets/img-new.png' }
  const source = new Blob(['source']), blob = new Blob(['result'])
  const prepared = await prepareBatch(text, { assets: { [old.displayPath]: source }, instances: [old] }, [{ reference, source, instance, result: { blob, width: 100, height: 50, mime: 'image/png' }, beforeHash: 'sha256:source', afterHash: 'sha256:result', previous: old }])
  expect(prepared.text).toBe('![a](assets/img-new.png)'); expect(prepared.patches).toHaveLength(1)
  expect(prepared.resources.instances).toEqual([old, instance]); expect(prepared.resources.assets[old.displayPath]).toBe(source)
})
