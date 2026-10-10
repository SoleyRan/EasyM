import { assetPath, MAX_ASSET_BYTES, type ImageInstance, type ImageRecipe } from '../core/images'
import ImageWorker from './image-worker?worker&inline'

export interface ImageResult { blob: Blob; width: number; height: number; mime: ImageRecipe['output']['mime'] }
export interface ImageResources { assets: Record<string, Blob>; instances: ImageInstance[] }
export const emptyResources = (): ImageResources => ({ assets: {}, instances: [] })

export function processImage(source: Blob, recipe?: ImageRecipe, signal?: AbortSignal): Promise<ImageResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('已取消图片处理', 'AbortError')); return }
    const worker = new ImageWorker()
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); worker.terminate() }
    const abort = () => { finish(); reject(new DOMException('已取消图片处理', 'AbortError')) }
    const timer = window.setTimeout(() => { finish(); reject(new Error('图片处理超时，请缩小图片后重试。')) }, 15000)
    signal?.addEventListener('abort', abort, { once: true })
    worker.onmessage = (event: MessageEvent<ImageResult & { error?: string }>) => { finish(); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data) }
    worker.onerror = () => { finish(); reject(new Error('后台图片处理不可用，原文保持不变。')) }
    worker.postMessage({ source, recipe })
  })
}

export async function sourceHash(blob: Blob): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))
  return 'sha256:' + Array.from(digest, (v) => v.toString(16).padStart(2, '0')).join('')
}

export function addResources(current: ImageResources, assets: Record<string, Blob>, instance: ImageInstance): ImageResources {
  const merged = { ...current.assets, ...assets }
  if (!Object.keys(merged).every(assetPath)) throw new Error('资源路径无效。')
  if (Object.values(merged).reduce((sum, blob) => sum + blob.size, 0) > MAX_ASSET_BYTES) throw new Error('当前文档资源超过 128 MB，请另存后重新打开。')
  // Retain earlier display recipes so undo and redo can resolve the exact old version.
  const instances = [...current.instances.filter((i) => i.displayPath !== instance.displayPath), instance]
  return { assets: merged, instances }
}
