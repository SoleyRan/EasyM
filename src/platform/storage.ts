import { invoke, isTauri } from '@tauri-apps/api/core'
import { zipArchive } from '../core/archive'
import type { ImageMetadata } from '../core/images'
import type { ImageResources } from './images'
import { MAX_ASSET_BYTES } from '../core/images'
import { parseDocument } from '../core/markdown'

export interface OpenedFile { id: string | null; name: string; bytes: Uint8Array; revision: string | null; metadata?: ImageMetadata; warning?: string }
export interface SavedFile { id: string | null; name: string; revision: string | null; destination: 'disk' | 'download'; warning?: string }
export const desktop = isTauri()

export async function releaseDocument(id: string | null): Promise<void> {
  if (desktop && id) await invoke('close_document', { id })
}

export async function openDocument(): Promise<OpenedFile | null> {
  if (desktop) {
    const file = await invoke<(Omit<OpenedFile, 'bytes'> & { bytes: number[] }) | null>('open_document')
    return file ? { ...file, bytes: new Uint8Array(file.bytes) } : null
  }
  return new Promise((resolve, reject) => {
    const picker = document.createElement('input')
    picker.type = 'file'
    picker.accept = '.md,.markdown,text/markdown,text/plain'
    picker.hidden = true
    // Keep the input connected until selection/cancellation; detached file inputs
    // are not consistently exposed by browsers and automation implementations.
    document.body.append(picker)
    picker.oncancel = () => { picker.remove(); resolve(null) }
    picker.onchange = async () => {
      try {
        const file = picker.files?.[0]
        picker.remove()
        if (!file) { resolve(null); return }
        if (file.size > 10 * 1024 * 1024) throw new Error('当前验证版限制文本文件大小为 10 MB。')
        resolve({ id: null, name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), revision: null })
      } catch (error) { reject(error) }
    }
    picker.click()
  })
}

export async function saveDocument(file: { id: string | null; name: string; revision: string | null }, bytes: Uint8Array, saveAs = false, resources?: ImageResources, operationId: string = crypto.randomUUID()): Promise<SavedFile | null> {
  if (desktop) {
    const copied = saveAs ? await materializeResources(file.id, resources ?? { assets: {}, instances: [] }) : resources
    if (saveAs) {
      const references = parseDocument(new TextDecoder().decode(bytes)).images
      if (references.some((image) => !/^https?:\/\//i.test(image.url) && !copied?.assets[decodeURI(image.url)])) throw new Error('另存为包含未托管或缺失图片，请先导入这些图片的本地副本，再另存整个文档。')
    }
    const assets = await Promise.all(Object.entries(copied?.assets ?? {}).map(async ([path, blob]) => ({ path, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) })))
    const saved = await invoke<Omit<SavedFile, 'destination'> | null>('save_document', {
      id: file.id, name: file.name, expectedRevision: file.revision, bytes: Array.from(bytes), saveAs,
      assets, metadata: { schemaVersion: 1, instances: resources?.instances ?? [] }, operationId,
    })
    if (saved && file.id && saved.id !== file.id) void releaseDocument(file.id).catch(() => undefined)
    return saved ? { ...saved, destination: 'disk' } : null
  }
  const assetEntries = Object.entries(resources?.assets ?? {})
  const archive = assetEntries.length ? zipArchive([
    { path: file.name.replace(/[\\/:\x00-\x1f]/g, '_') || 'note.md', bytes },
    ...await Promise.all(assetEntries.map(async ([path, blob]) => ({ path, bytes: new Uint8Array(await blob.arrayBuffer()) }))),
    { path: '.easym/images.json', bytes: new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, instances: resources?.instances ?? [] }, null, 2)) },
  ]) : null
  const blob = new Blob([(archive ?? bytes) as BlobPart], { type: archive ? 'application/zip' : 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = archive ? file.name.replace(/\.(md|markdown)$/i, '') + '-workspace.zip' : file.name
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 10000)
  return { id: null, name: file.name, revision: null, destination: 'download' }
}

export async function materializeResources(id: string | null, resources: ImageResources): Promise<ImageResources> {
  const assets = { ...resources.assets }
  let total = Object.values(assets).reduce((sum, blob) => sum + blob.size, 0)
  for (const path of new Set(resources.instances.flatMap((instance) => [instance.sourcePath, instance.displayPath]))) {
    if (assets[path]) continue
    if (!id || !desktop) throw new Error('草稿图片副本缺失，请重新打开原文档或重新导入图片。')
    const blob = await readImageBlob(id, path)
    total += blob.size
    if (total > MAX_ASSET_BYTES) throw new Error('文档图片资源超过 128 MB，无法生成完整副本。')
    assets[path] = blob
  }
  return { assets, instances: resources.instances }
}

export async function readImage(id: string, relativePath: string): Promise<string> {
  return URL.createObjectURL(await readImageBlob(id, decodeURI(relativePath)))
}

export async function readImageBlob(id: string, relativePath: string): Promise<Blob> {
  const result = await invoke<{ bytes: number[]; mime: string }>('read_image', { id, relativePath })
  return new Blob([new Uint8Array(result.bytes)], { type: result.mime })
}

export async function reloadDocument(id: string): Promise<OpenedFile> {
  const file = await invoke<Omit<OpenedFile, 'bytes'> & { bytes: number[] }>('reload_document', { id })
  return { ...file, bytes: new Uint8Array(file.bytes) }
}
