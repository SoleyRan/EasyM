import { batchRecipe, batchReferences, batchPatches, type BatchOptions, type BatchReference } from '../core/batch-images'
import { inspectImage, MAX_ASSET_BYTES, type ImageInstance } from '../core/images'
import { applyPatches } from '../core/document'
import { processImage, sourceHash, type ImageResources, type ImageResult } from './images'
import { readImageBlob } from './storage'
import HistoryWorker from './history-diff-worker?worker&inline'

export async function collectBatchReferences(text: string, signal?: AbortSignal): Promise<BatchReference[]> {
  if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
  if (text.length < 65536) return batchReferences(text)
  return new Promise((resolve, reject) => {
    const worker = new HistoryWorker()
    const finish = () => { clearTimeout(timer); worker.terminate(); signal?.removeEventListener('abort', abort) }
    const abort = () => { finish(); reject(new DOMException('已取消', 'AbortError')) }
    const timer = globalThis.setTimeout(() => { finish(); reject(new Error('图片引用预检超时。')) }, 10000)
    signal?.addEventListener('abort', abort, { once: true })
    worker.onmessage = event => { finish(); event.data.error ? reject(new Error('图片引用预检失败。')) : resolve(event.data.references) }
    worker.onerror = () => { finish(); reject(new Error('图片引用预检失败。')) }
    try { worker.postMessage({ type: 'batchReferences', texts: [text] }) } catch { finish(); reject(new Error('后台引用任务未能启动。')) }
  })
}

export interface BatchItem { reference: BatchReference; source?: Blob; width?: number; height?: number; mime?: ImageResult['mime']; error?: string; previous?: ImageInstance }
export interface BatchOutput { reference: BatchReference; source: Blob; result: ImageResult; instance: ImageInstance; beforeHash: string; afterHash: string; previous?: ImageInstance }
export async function inspectBatch(text: string, resources: ImageResources, fileId: string, signal: AbortSignal): Promise<BatchItem[]> {
  const references = await collectBatchReferences(text, signal)
  if (references.length > 4096) throw new Error('图片引用超过 4096 个，请拆分文档。')
  const cache = new Map<string, Blob>(), geometry = new Map<string, { width: number; height: number; mime: ImageResult['mime'] }>(), result: BatchItem[] = []
  let total = 0
  for (const reference of references) {
    if (signal.aborted) throw new DOMException('已取消', 'AbortError')
    const item: BatchItem = { reference, previous: resources.instances.find(i => i.displayPath === reference.path) }
    try {
      if (!reference.path) throw new Error('远程或未授权引用不能批量处理。')
      let source = cache.get(reference.path)
      if (!source) {
        source = resources.assets[reference.path] ?? await readImageBlob(fileId, reference.path)
        total += source.size
        if (total > MAX_ASSET_BYTES) throw new Error('输入资源超过 128 MiB，请拆分文档。')
        cache.set(reference.path, source)
      }
      let info = geometry.get(reference.path)
      if (!info) {
        const header = inspectImage(new Uint8Array(await source.arrayBuffer()))
        const normalized = await processImage(source, undefined, signal)
        info = { mime: header.mime, width: normalized.width, height: normalized.height }; geometry.set(reference.path, info)
      }
      Object.assign(item, info, { source })
    } catch (e) { item.error = e instanceof Error ? e.message : String(e) }
    result.push(item)
  }
  return result
}
export async function generateBatch(items: BatchItem[], options: BatchOptions, fileId: string, signal: AbortSignal, progress: (done: number, total: number) => void): Promise<BatchOutput[]> {
  if (!items.length || items.length > 100) throw new Error('每批请选择 1–100 个图片实例。')
  const results: BatchOutput[] = [], sources = new Set<Blob>(); let total = 0, generatedBytes = 0
  for (const item of items) {
    if (signal.aborted) throw new DOMException('已取消', 'AbortError')
    if (!item.source || !item.width || !item.height || !item.mime || item.error) throw new Error(item.error ?? '图片缺失。')
    if (!sources.has(item.source)) { total += item.source.size; sources.add(item.source) }
    if (total > MAX_ASSET_BYTES) throw new Error('输入资源超过 128 MiB。')
    const recipe = batchRecipe(item.width, item.height, item.mime, options)
    const result = await processImage(item.source, recipe, signal, options)
    generatedBytes += item.source.size + result.blob.size
    if (generatedBytes > MAX_ASSET_BYTES) throw new Error('生成的基准源与显示副本超过 128 MiB，请减少选择数量。')
    const instanceId = `img-${crypto.randomUUID()}`
    const beforeHash = await sourceHash(item.source), afterHash = await sourceHash(result.blob)
    if (signal.aborted) throw new DOMException('已取消', 'AbortError')
    const instance: ImageInstance = { instanceId, documentId: fileId, sourcePath: `assets/.originals/${instanceId}-source.${item.mime === 'image/png' ? 'png' : 'jpg'}`, sourceHash: beforeHash, displayPath: `assets/${instanceId}-batch.${result.mime === 'image/png' ? 'png' : 'jpg'}`, recipe, referenceRevision: (item.previous?.referenceRevision ?? 0) + 1 }
    results.push({ reference: item.reference, source: item.source, result, instance, beforeHash, afterHash, previous: item.previous })
    progress(results.length, items.length)
  }
  return results
}
export async function prepareBatch(text: string, resources: ImageResources, outputs: BatchOutput[]) {
  const references = await collectBatchReferences(text)
  const patches = batchPatches(text, outputs, references), assets = { ...resources.assets }, instances = [...resources.instances]
  for (const output of outputs) { assets[output.instance.sourcePath] = output.source; assets[output.instance.displayPath] = output.result.blob; instances.push(output.instance) }
  if (Object.values(assets).reduce((n, b) => n + b.size, 0) > MAX_ASSET_BYTES) throw new Error('待保存资源超过 128 MiB，请另存并重新打开后重试。')
  return { text: applyPatches(text, patches), patches, resources: { assets, instances } }
}
