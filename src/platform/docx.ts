import { invoke } from '@tauri-apps/api/core'
import DocxWorker from './docx-worker?worker&inline'
import type { DocxWorkerRequest } from './docx-worker'
import { DOCX_LIMITS, DocxQuotaError, prepareDocxResources, type DocxModel, type PreparedDocx } from '../core/docx-model'
import { defaultDocxOptions, MAX_DOCX_BYTES, type DocxOptions } from '../core/docx-options'
import type { ImageResources } from './images'
import { desktop, readImageBlob } from './storage'

const abortError = () => new DOMException('DOCX 导出已取消。', 'AbortError')

function task<T>(request: DocxWorkerRequest, signal?: AbortSignal, timeout = 60_000): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return }
    const worker = new DocxWorker()
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); worker.terminate() }
    const abort = () => { finish(); reject(abortError()) }
    const timer = window.setTimeout(() => { finish(); reject(new DOMException('DOCX 后台任务超时，请减少内容后重试。', 'TimeoutError')) }, timeout)
    signal?.addEventListener('abort', abort, { once: true })
    worker.onerror = () => { finish(); reject(new Error('DOCX 后台任务不可用，请重试。')) }
    worker.onmessage = (event: MessageEvent<{ value: T; error?: { message: string; name: string; code?: string } }>) => {
      finish()
      if (!event.data.error) resolve(event.data.value)
      else {
        const error = event.data.error.code === 'quota_exceeded' ? new DocxQuotaError(event.data.error.message) : new Error(event.data.error.message)
        error.name = event.data.error.name
        reject(error)
      }
    }
    // Clone assets so the preflight can be retried without detached buffers.
    try { worker.postMessage(request) } catch (error) { finish(); reject(error) }
  })
}

// Tauri reads cannot be interrupted in flight. Bound the wait and discard late
// results, remove listeners, and never start the next resource after cancellation.
function loadResource<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return }
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    const abort = () => { finish(); reject(abortError()) }
    const timer = window.setTimeout(() => { finish(); reject(new DOMException('读取 DOCX 图片超时。', 'TimeoutError')) }, 15_000)
    signal?.addEventListener('abort', abort, { once: true })
    Promise.resolve().then(() => { if (signal?.aborted) throw abortError(); return read() }).then(value => { finish(); resolve(value) }, error => { finish(); reject(error === 'quota_exceeded' ? new DocxQuotaError('DOCX 图片超出资源限制。') : error) })
  })
}

export interface DocxSource { text: string; name: string; id: string | null; resources: ImageResources }
export async function preflightDocx(source: DocxSource, signal?: AbortSignal): Promise<PreparedDocx> {
  const assets = { ...source.resources.assets }, documentId = source.id
  if (source.text.length > DOCX_LIMITS.textBytes || new TextEncoder().encode(source.text).length > DOCX_LIMITS.textBytes) throw new DocxQuotaError('DOCX 正文最多 10 MiB。')
  const model = await task<DocxModel>({ type: 'parse', text: source.text, name: source.name }, signal)
  return prepareDocxResources(model, (path, currentSignal) => loadResource(async () => {
    // Only the current document's in-memory display resources or authorized
    // document directory may supply bytes; no fetch or arbitrary disk path.
    if (Object.hasOwn(assets, path)) return assets[path]
    if (desktop && documentId) return readImageBlob(documentId, path)
    throw new Error('当前文档未提供这张本地图片。')
  }, currentSignal), signal, (blob, currentSignal) => task({ type: 'decode', blob }, currentSignal, 15_000))
}

export const renderDocx = (prepared: PreparedDocx, options: DocxOptions = defaultDocxOptions, signal?: AbortSignal): Promise<ArrayBuffer> => task({ type: 'generate', prepared, options }, signal)

export async function saveDocx(name: string, bytes: ArrayBuffer, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) throw abortError()
  if (bytes.byteLength > MAX_DOCX_BYTES) throw new DocxQuotaError('DOCX 输出最多 192 MiB。')
  if (!/\.docx$/i.test(name) || /[\\/:\x00-\x1f]/.test(name)) throw new Error('DOCX 文件名无效。')
  // Once dispatched, the native save dialog owns cancellation and commit.
  if (desktop) return invoke<boolean>('export_docx', { name, bytes: Array.from(new Uint8Array(bytes)) })
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }))
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = name; anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return true
}
