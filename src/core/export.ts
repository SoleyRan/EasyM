import type { ParsedDocument } from './markdown'
import { inspectImage, MAX_ASSET_BYTES, MAX_IMAGE_BYTES } from './images'
import exportStyles from './export.css?inline'

export const MAX_EXPORT_BYTES = 192 * 1024 * 1024
export interface ExportDocument { html: string; body: string; warnings: string[]; name: string }
export { exportStyles }

export function localImagePath(url: string): string | null {
  try {
    const path = decodeURIComponent(url)
    if (!path || /[\\:\x00-\x1f?#]/.test(path) || path.startsWith('/')) return null
    const parts = path.split('/').filter(part => part !== '.')
    if (parts.some(part => !part || part === '..')) return null
    return parts.join('/')
  } catch { return null }
}

async function inlineImage(blob: Blob): Promise<string> {
  if (blob.size > MAX_IMAGE_BYTES) throw new Error('图片超过 20 MB')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const { mime } = inspectImage(bytes)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return `data:${mime};base64,${btoa(binary)}`
}

// Only accept HTML produced by the sanitized Markdown renderer. DOM construction
// keeps titles, image alt text and resource warnings out of HTML interpolation.
export async function createExport(parsed: ParsedDocument, name: string, load: (path: string) => Promise<Blob>): Promise<ExportDocument> {
  const doc = document.implementation.createHTMLDocument('')
  const title = doc.querySelector('title') ?? doc.createElement('title')
  title.textContent = name.replace(/\.(md|markdown)$/i, ''); doc.head.append(title)
  doc.documentElement.lang = 'zh-CN'
  const charset = doc.createElement('meta'); charset.setAttribute('charset', 'utf-8'); doc.head.prepend(charset)
  const policy = doc.createElement('meta'); policy.httpEquiv = 'Content-Security-Policy'
  policy.content = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
  doc.head.append(policy)
  const viewport = doc.createElement('meta'); viewport.name = 'viewport'; viewport.content = 'width=device-width, initial-scale=1'; doc.head.append(viewport)
  const style = doc.createElement('style'); style.textContent = `body{margin:0;padding:24px}main{max-width:860px;margin:auto}@media print{body{padding:0}main{max-width:none}}${exportStyles}`; doc.head.append(style)
  const main = doc.createElement('main'); main.className = 'export-document'; main.innerHTML = parsed.html; doc.body.append(main)
  const warnings: string[] = []
  const cache = new Map<string, string | null>()
  let total = 0
  for (const image of main.querySelectorAll('img')) {
    const resource = image.getAttribute('data-resource') ?? ''
    const path = localImagePath(resource)
    const key = path ?? resource
    if (!cache.has(key)) {
      let data: string | null = null
      if (path) {
        try {
          const blob = await load(path)
          if (total + blob.size > MAX_ASSET_BYTES) throw new Error('文档图片资源超过 128 MB，无法导出。')
          data = await inlineImage(blob); total += blob.size
        } catch (error) {
          if (error instanceof Error && error.message.includes('128 MB')) throw error
        }
      }
      cache.set(key, data)
      if (!data) warnings.push(`${path ? '缺失或无法读取的本地图片' : '未加载的非本地图片'}：${resource}`)
    }
    const data = cache.get(key)
    if (data) image.setAttribute('src', data)
    else {
      const placeholder = doc.createElement('span'); placeholder.className = 'missing-image'
      placeholder.textContent = `［图片未加载：${image.alt || resource || '无地址'}］`; image.replaceWith(placeholder)
    }
  }
  for (const element of main.querySelectorAll('*')) {
    for (const attribute of Array.from(element.attributes)) if (attribute.name.startsWith('data-')) element.removeAttribute(attribute.name)
  }
  const html = `<!doctype html>\n${doc.documentElement.outerHTML}`
  if (new TextEncoder().encode(html).length > MAX_EXPORT_BYTES) throw new Error('导出文件超过 192 MB，请减少图片或正文后重试。')
  return { html, body: main.innerHTML, warnings, name: (name.replace(/\.(md|markdown)$/i, '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') || '未命名') + '.html' }
}
