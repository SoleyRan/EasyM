import { useRef, useState } from 'react'
import type { Selection } from '../core/document'
import { defaultRecipe, MAX_IMAGE_BYTES, type ImageRecipe } from '../core/images'
import { parseDocument, type ImageReference } from '../core/markdown'
import { emptyResources, processImage, sourceHash, type ImageResources, type ImageResult } from '../platform/images'
import { commitImageChange } from '../platform/image-transaction'
import { desktop, readImageBlob } from '../platform/storage'
import type { ImageSession } from '../core/image-session'

interface Host {
  text: string; fileId: string | null; blocked: boolean
  selection(): Selection
  patch(from: number, to: number, insert: string): boolean
  persist(nextText: string, resources: ImageResources, operationId: string): Promise<void>
  error(message: string): void
  applied(): void
}

export function useImages(host: Host) {
  const [resources, setResources] = useState<ImageResources>(emptyResources)
  const [session, setSession] = useState<ImageSession | null>(null)
  const [busy, setBusy] = useState(false)
  const [applying, setApplying] = useState(false)
  const operation = useRef<AbortController | null>(null)
  const latest = useRef(host); latest.current = host

  async function importFiles(input: File[] | (() => Promise<File[]>)) {
    if (busy || operation.current || host.blocked || session) return
    const controller = new AbortController(); operation.current = controller; setBusy(true)
    const baseText = host.text, selection = host.selection()
    try {
      const files = typeof input === 'function' ? await input() : input
      if (!files[0] || controller.signal.aborted) return
      if (files.length > 1) throw new Error('请每次导入一张图片，以便确认插入实例。')
      if (files[0].size > MAX_IMAGE_BYTES) throw new Error('图片文件超过 20 MB。')
      const normalized = await processImage(files[0], undefined, controller.signal)
      const hash = await sourceHash(normalized.blob)
      if (latest.current.text !== baseText) throw new Error('正文已变化，请重新选择插入位置。')
      if (controller.signal.aborted) return
      const instanceId = `img-${crypto.randomUUID()}`, extension = normalized.mime === 'image/png' ? 'png' : 'jpg'
      const recipe = { ...defaultRecipe(normalized.mime), orientationNormalized: true }
      setSession({ source: normalized.blob, width: normalized.width, height: normalized.height, alt: files[0].name.replace(/\.[^.]+$/, '') || '图片', recipe, target: null, selection, baseText, operationId: crypto.randomUUID(), displayToken: crypto.randomUUID(),
        instance: { instanceId, documentId: host.fileId, sourcePath: `assets/.originals/${instanceId}-source.${extension}`, sourceHash: hash, displayPath: '', recipe, referenceRevision: 0 } })
    } catch (err) { if (!controller.signal.aborted) host.error(err instanceof Error ? err.message : '导入失败，原文保持不变。') }
    finally { operation.current = null; setBusy(false) }
  }

  async function edit(target: ImageReference) {
    if (busy || operation.current || host.blocked || session) return
    const controller = new AbortController(); operation.current = controller
    setBusy(true)
    const baseText = host.text
    try {
      const old = resources.instances.find((i) => i.displayPath === target.url)
      const path = old?.sourcePath ?? target.url
      const input = resources.assets[path] ?? (desktop && host.fileId ? await readImageBlob(host.fileId, decodeURI(path)) : null)
      if (!input) throw new Error('图片未授权或缺失，请重新导入本地副本。')
      if (old && await sourceHash(input) !== old.sourceHash) throw new Error('源副本已被外部修改，请重新导入图片；原引用保持不变。')
      const normalized = await processImage(input, undefined, controller.signal)
      if (controller.signal.aborted) return
      if (latest.current.text !== baseText) throw new Error('正文已变化，请重新选择图片。')
      const sharedReference = parseDocument(baseText).images.filter((item) => item.url === target.url).length > 1
      const instanceId = old && !sharedReference ? old.instanceId : `img-${crypto.randomUUID()}`
      const sourcePath = old?.sourcePath ?? `assets/.originals/${instanceId}-source.${normalized.mime === 'image/png' ? 'png' : 'jpg'}`
      const source = old ? input : normalized.blob
      const recipe = old?.recipe ?? { ...defaultRecipe(normalized.mime), orientationNormalized: true }
      setSession({ source, width: normalized.width, height: normalized.height, alt: target.alt, recipe, target, selection: { anchor: target.from, head: target.to }, baseText, operationId: crypto.randomUUID(), displayToken: crypto.randomUUID(),
        instance: { instanceId, documentId: host.fileId, sourcePath, sourceHash: old?.sourceHash ?? await sourceHash(source), displayPath: target.url, recipe, referenceRevision: (old?.referenceRevision ?? 0) + 1 } })
    } catch (err) { if (!controller.signal.aborted) host.error(err instanceof Error ? err.message : '读取失败。') }
    finally { operation.current = null; setBusy(false) }
  }

  async function apply(result: ImageResult, recipe: ImageRecipe, alt: string) {
    if (!session || latest.current.text !== session.baseText) throw new Error('正文已变化，请取消后重新选择图片。')
    const displayPath = `assets/${session.instance.instanceId}-v-${session.displayToken}.${result.mime === 'image/png' ? 'png' : 'jpg'}`
    setApplying(true)
    try {
      const next = await commitImageChange({ text: latest.current.text, baseText: session.baseText, selection: session.selection, replaceImage: !!session.target, resources, instance: session.instance, source: session.source, result, recipe, alt, displayPath }, (body, next) => host.persist(body, next, session.operationId), (patch) => host.patch(patch.from, patch.to, patch.insert))
      setResources(next); setSession(null); host.applied()
    } finally { setApplying(false) }
  }

  return { resources, setResources, session, setSession, busy, applying, importFiles, edit, apply,
    update: (recipe: ImageRecipe, alt: string) => setSession((current) => {
      if (!current || (current.recipe === recipe && current.alt === alt)) return current
      return { ...current, recipe, alt, operationId: crypto.randomUUID(), displayToken: crypto.randomUUID() }
    }),
    cancel: () => { operation.current?.abort(); setSession(null) } }
}
