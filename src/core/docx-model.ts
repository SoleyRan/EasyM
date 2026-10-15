import type { Definition, Nodes, Root } from 'mdast'
import { parseMarkdownAst } from './markdown-ast'
import { indexFootnotes } from './footnotes'
import { localImagePath } from './export-resource'
import { inspectImage, MAX_ASSET_BYTES, MAX_IMAGE_BYTES } from './images'

export const DOCX_LIMITS = { textBytes: 10 * 1024 * 1024, nodes: 100_000, images: 500, warnings: 1000, depth: 128 } as const
export interface DocxRange { from: number; to: number }
export type DocxWarningCode = 'unsupported_node' | 'unsafe_link' | 'unresolved_reference' | 'unused_definition' | 'wide_table' | 'deep_list' | 'restricted_image' | 'missing_image' | 'invalid_image' | 'font_fallback' | 'footnote_endnotes'
export interface DocxWarning {
  code: DocxWarningCode
  message: string
  severity: 'degradable' | 'information'
  range: DocxRange
  resource?: string
}
export interface DocxWarnings { items: DocxWarning[]; total: number; imageFailures: number }
export interface DocxStyle { bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean; superscript?: boolean }
export type DocxInline =
  | { type: 'text'; text: string; style: DocxStyle; range: DocxRange }
  | { type: 'break'; range: DocxRange }
  | { type: 'link'; url: string; children: DocxInline[]; range: DocxRange }
  | { type: 'image'; resourceId: string; alt: string; range: DocxRange }
export type DocxBlock =
  | { type: 'paragraph'; children: DocxInline[]; range: DocxRange }
  | { type: 'heading'; level: number; children: DocxInline[]; range: DocxRange }
  | { type: 'quote'; children: DocxBlock[]; range: DocxRange }
  | { type: 'list'; ordered: boolean; start: number; depth: number; staticMarkers: boolean; items: Array<{ checked: boolean | null; children: DocxBlock[]; range: DocxRange }>; range: DocxRange }
  | { type: 'code'; text: string; language: string | null; range: DocxRange }
  | { type: 'raw'; text: string; label: string; range: DocxRange }
  | { type: 'table'; align: Array<'left' | 'center' | 'right' | null>; rows: Array<Array<{ children: DocxInline[]; range: DocxRange }>>; range: DocxRange }
  | { type: 'separator'; range: DocxRange }
export interface DocxImageResource {
  id: string
  url: string
  path: string | null
  range: DocxRange
  status: 'pending' | 'unavailable' | 'ready'
}
export interface DocxModel {
  version: 1
  name: string
  blocks: DocxBlock[]
  images: DocxImageResource[]
  warnings: DocxWarnings
}
export interface DocxAsset { id: string; bytes: Uint8Array; mime: 'image/png' | 'image/jpeg'; width: number; height: number }
export interface PreparedDocx { model: DocxModel; assets: DocxAsset[] }
export class DocxQuotaError extends Error {
  readonly code = 'quota_exceeded'
  constructor(message: string) { super(message); this.name = 'DocxQuotaError' }
}

function range(node: Nodes): DocxRange {
  return { from: node.position?.start.offset ?? 0, to: node.position?.end.offset ?? 0 }
}
function warning(warnings: DocxWarnings, value: DocxWarning, imageFailure = false) {
  warnings.total++
  if (imageFailure) warnings.imageFailures++
  if (warnings.items.length < DOCX_LIMITS.warnings) warnings.items.push(value)
}
function safeLink(url: string): string | null {
  if (/[\x00-\x20\x7f]/.test(url)) return null
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol) || parsed.username || parsed.password) return null
    return parsed.href
  } catch { return null }
}

// Runs before recursive mapping so maliciously deep trees cannot exhaust the stack.
function checkTree(tree: Root) {
  const queue: Array<{ node: Nodes; depth: number }> = [{ node: tree, depth: 0 }]
  let count = 0
  while (queue.length) {
    const { node, depth } = queue.pop()!
    if (++count > DOCX_LIMITS.nodes || depth > DOCX_LIMITS.depth) throw new DocxQuotaError('文档结构过多或嵌套过深，请减少内容后重试。')
    if ('children' in node) for (const child of node.children) queue.push({ node: child as Nodes, depth: depth + 1 })
  }
}

export function createDocxModel(text: string, name: string): DocxModel {
  if (text.length > DOCX_LIMITS.textBytes || new TextEncoder().encode(text).length > DOCX_LIMITS.textBytes) throw new DocxQuotaError('DOCX 正文最多 10 MiB，请减少内容后重试。')
  const tree = parseMarkdownAst(text)
  return mapDocxAst(tree, text, name)
}

// Accepts an independent AST; neither mapping nor preflight mutates the input.
export function mapDocxAst(tree: Root, text: string, name: string): DocxModel {
  if (text.length > DOCX_LIMITS.textBytes || new TextEncoder().encode(text).length > DOCX_LIMITS.textBytes) throw new DocxQuotaError('DOCX 正文最多 10 MiB，请减少内容后重试。')
  checkTree(tree)
  const footnotes = indexFootnotes(tree)
  const usedFootnotes = new Set(footnotes.order)
  const warnings: DocxWarnings = { items: [], total: 0, imageFailures: 0 }
  const definitions = new Map<string, Definition>()
  const allDefinitions: Definition[] = []
  const usedDefinitions = new Set<Definition>()
  const images: DocxImageResource[] = []
  const imageKeys = new Map<string, DocxImageResource>()
  const definitionKey = (id: string) => id.toUpperCase()
  const visitDefinitions = (node: Nodes) => {
    if (node.type === 'definition') {
      allDefinitions.push(node)
      if (!definitions.has(definitionKey(node.identifier))) definitions.set(definitionKey(node.identifier), node)
    }
    if ('children' in node) node.children.forEach(child => visitDefinitions(child as Nodes))
  }
  visitDefinitions(tree)
  const original = (node: Nodes) => text.slice(range(node).from, range(node).to)
  const report = (node: Nodes, code: DocxWarningCode, message: string) => warning(warnings, { code, message, severity: 'degradable', range: range(node) })
  const raw = (node: Nodes): DocxBlock => {
    report(node, 'unsupported_node', `“${node.type}”将作为静态原文保留。`)
    return { type: 'raw', text: original(node), label: node.type, range: range(node) }
  }
  const reference = (node: Nodes & { identifier: string }) => {
    const key = definitionKey(node.identifier)
    const value = definitions.get(key)
    if (value) usedDefinitions.add(value)
    else report(node, 'unresolved_reference', '引用未解析，将保留原文。')
    return value
  }
  const image = (node: Nodes, url: string, alt: string): DocxInline => {
    const path = localImagePath(url)
    const allowed = path !== null && /\.(png|jpe?g)$/i.test(path)
    const key = path ?? url
    let resource = imageKeys.get(key)
    if (!resource) {
      if (images.length >= DOCX_LIMITS.images) throw new DocxQuotaError('DOCX 最多包含 500 张去重图片。')
      resource = { id: `image-${images.length + 1}`, url, path: allowed ? path : null, range: range(node), status: allowed ? 'pending' : 'unavailable' }
      imageKeys.set(key, resource); images.push(resource)
      if (!allowed) warning(warnings, { code: 'restricted_image', message: '非本地、越界或不支持格式的图片不会读取，可选择占位导出。', severity: 'degradable', range: range(node), resource: url }, true)
    }
    return { type: 'image', resourceId: resource.id, alt, range: range(node) }
  }
  const literal = (node: Nodes, value: string, style: DocxStyle): DocxInline => ({ type: 'text', text: value, style: { ...style }, range: range(node) })
  const inline = (nodes: readonly Nodes[], style: DocxStyle = {}): DocxInline[] => nodes.flatMap((node): DocxInline[] => {
    switch (node.type) {
      case 'text': return [literal(node, node.value.replace(/\r?\n/g, ' '), style)]
      case 'inlineCode': return [literal(node, node.value, { ...style, code: true })]
      case 'strong': return inline(node.children, { ...style, bold: true })
      case 'emphasis': return inline(node.children, { ...style, italic: true })
      case 'delete': return inline(node.children, { ...style, strike: true })
      case 'break': return [{ type: 'break', range: range(node) }]
      case 'footnoteReference': {
        const number = footnotes.number(node.identifier)
        return [literal(node, number === undefined ? original(node) : String(number), number === undefined ? style : { ...style, superscript: true })]
      }
      case 'image': return [image(node, node.url, node.alt ?? '')]
      case 'imageReference': {
        const value = reference(node)
        return value ? [image(node, value.url, node.alt ?? '')] : [literal(node, original(node), { ...style, code: true })]
      }
      case 'link':
      case 'linkReference': {
        const value = node.type === 'link' ? node : reference(node)
        if (!value) return [literal(node, original(node), { ...style, code: true })]
        const children = inline(node.children, style), url = safeLink(value.url)
        if (url) return [{ type: 'link', url, children, range: range(node) }]
        report(node, 'unsafe_link', '链接地址无法安全导出，将保留标签和静态地址。')
        return [...children, literal(node, ` (${value.url})`, { ...style, code: true })]
      }
      default:
        report(node, 'unsupported_node', `“${node.type}”将作为静态原文保留。`)
        return [literal(node, original(node), { ...style, code: true })]
    }
  })
  const blocks = (nodes: readonly Nodes[], depth = 0): DocxBlock[] => nodes.flatMap((node): DocxBlock[] => {
    const source = range(node)
    switch (node.type) {
      case 'definition': return []
      case 'footnoteDefinition': return usedFootnotes.has(node) ? [] : [raw(node)]
      case 'paragraph': return [{ type: 'paragraph', children: inline(node.children), range: source }]
      case 'heading': return [{ type: 'heading', level: node.depth, children: inline(node.children), range: source }]
      case 'blockquote': return [{ type: 'quote', children: blocks(node.children, depth), range: source }]
      case 'list': {
        if (depth >= 9) report(node, 'deep_list', '超过 9 层的列表将使用静态编号和缩进。')
        return [{ type: 'list', ordered: node.ordered ?? false, start: node.start ?? 1, depth, staticMarkers: depth >= 9, items: node.children.map(item => ({ checked: item.checked ?? null, children: blocks(item.children, depth + 1), range: range(item) })), range: source }]
      }
      case 'code': return [{ type: 'code', text: node.value, language: node.lang ?? null, range: source }]
      case 'thematicBreak': return [{ type: 'separator', range: source }]
      case 'table': {
        if (node.align && node.align.length > 8 || node.children.some(row => row.children.some(cell => original(cell).length > 500))) report(node, 'wide_table', '表格列数或单元格文本较多，请在目标软件检查宽度和分页。')
        return [{ type: 'table', align: node.align ?? [], rows: node.children.map(row => row.children.map(cell => ({ children: inline(cell.children), range: range(cell) }))), range: source }]
      }
      default: return [raw(node)]
    }
  })
  const output = blocks(tree.children)
  if (footnotes.order.length) {
    const source = range(footnotes.order[0])
    warning(warnings, { code: 'footnote_endnotes', message: '脚注以可编辑上标编号和文末脚注区导出，不是 Word 原生逐页脚注。', severity: 'information', range: source })
    output.push({ type: 'heading', level: 2, children: [literal(footnotes.order[0], '脚注', {})], range: source })
    footnotes.order.forEach((note, index) => {
      output.push({ type: 'paragraph', children: [literal(note, String(index + 1), { superscript: true })], range: range(note) }, ...blocks(note.children))
    })
  }
  for (const node of allDefinitions) if (!usedDefinitions.has(node)) {
    report(node, 'unused_definition', '未引用的链接定义将作为静态原文附录保留。')
    output.push({ type: 'raw', text: original(node), label: 'unused_definition', range: range(node) })
  }
  warning(warnings, { code: 'font_fallback', message: '字体和分页由目标办公软件决定，输出不嵌入字体。', severity: 'information', range: { from: 0, to: 0 } })
  const safeName = name.replace(/\.(md|markdown)$/i, '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120).replace(/[. ]+$/, '') || '未命名'
  return { version: 1, name: `${safeName}.docx`, blocks: output, images, warnings }
}

function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('DOCX 预检已取消。', 'AbortError')
}

// Resource bytes are separate from the serializable structural model. Invalid
// resources require an explicit placeholder choice; hard quotas never degrade.
export async function prepareDocxResources(input: DocxModel, load: (path: string, signal?: AbortSignal) => Promise<Blob>, signal?: AbortSignal, decode?: (blob: Blob, signal?: AbortSignal) => Promise<{ width: number; height: number }>): Promise<PreparedDocx> {
  // Rebuild from the current source for a retry, rather than accumulating stale
  // missing-image warnings or returning ready resources without their bytes.
  if (input.images.some(resource => resource.path && resource.status !== 'pending')) throw new Error('请从当前正文重新建立 DOCX 预检。')
  const model = structuredClone(input)
  const assets: DocxAsset[] = []
  let total = 0
  cancelled(signal)
  for (const resource of model.images) {
    if (!resource.path) continue
    cancelled(signal)
    let blob: Blob
    try { blob = await load(resource.path, signal) }
    catch (error) {
      cancelled(signal)
      if (error instanceof DocxQuotaError || error instanceof Error && (['AbortError', 'TimeoutError'].includes(error.name) || 'code' in error && error.code === 'quota_exceeded')) throw error
      resource.status = 'unavailable'
      warning(model.warnings, { code: 'missing_image', message: '本地图片缺失或无法读取，可选择占位导出。', severity: 'degradable', range: resource.range, resource: resource.path }, true)
      continue
    }
    cancelled(signal)
    if (blob.size > MAX_IMAGE_BYTES) throw new DocxQuotaError('单张 DOCX 图片最多 20 MiB。')
    if (total + blob.size > MAX_ASSET_BYTES) throw new DocxQuotaError('DOCX 图片资源最多 128 MiB。')
    total += blob.size
    const bytes = new Uint8Array(await blob.arrayBuffer())
    cancelled(signal)
    try {
      const inspected = inspectImage(bytes)
      const dimensions = decode ? await decode(new Blob([bytes as BlobPart], { type: inspected.mime }), signal) : inspected
      cancelled(signal)
      assets.push({ id: resource.id, bytes, ...inspected, ...dimensions })
      resource.status = 'ready'
    } catch (error) {
      cancelled(signal)
      if (error instanceof DocxQuotaError || error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) throw error
      if (error instanceof Error && error.message.includes('尺寸超限')) throw new DocxQuotaError(error.message)
      resource.status = 'unavailable'
      warning(model.warnings, { code: 'invalid_image', message: '图片头或尺寸无效，可选择占位导出。', severity: 'degradable', range: resource.range, resource: resource.path }, true)
    }
  }
  return { model, assets }
}

export function canGenerateDocx(model: DocxModel, allowImagePlaceholders = false): boolean {
  return !model.images.some(image => image.status === 'pending') && (allowImagePlaceholders || model.warnings.imageFailures === 0)
}
