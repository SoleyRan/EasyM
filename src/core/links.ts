import type { Nodes, Definition } from 'mdast'
import { contentTree } from './content-tools'
import { parseMarkdownAst } from './markdown-ast'
import type { EditCommandResult, Selection } from './document'

export function headingAnchorOffset(text: string, fragment: string): number | null {
  let query: string
  try { query = decodeURIComponent(fragment.replace(/^#/, '')) } catch { return null }
  const counts = new Map<string, number>()
  function plain(node: Nodes): string { return 'value' in node ? node.value : 'children' in node ? node.children.map(child => plain(child as Nodes)).join('') : '' }
  for (const node of contentTree(text).children) if (node.type === 'heading') {
    const base = plain(node).toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/g, '-')
    const count = counts.get(base) ?? 0; counts.set(base, count + 1)
    if ((count ? `${base}-${count}` : base) === query) return node.position?.start.offset ?? null
  }
  return null
}

export function safeLink(url: string): string | null {
  if (!url || url.length > 4096 || /[\x00-\x20\x7f\\<>]/.test(url)) return null
  let decoded: string
  try { decoded = decodeURIComponent(url) } catch { return null }
  if (/[\x00-\x1f\x7f\\]/.test(decoded) || /^\/\//.test(decoded)) return null
  if (/^[a-z][a-z\d+.-]*:/i.test(decoded)) {
    try {
      const parsed = new URL(decoded)
      if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol) || parsed.username || parsed.password) return null
    } catch { return null }
  } else if (decoded.startsWith('/') || /^[a-z]:/i.test(decoded)) return null
  return url
}
export interface LinkTarget { from: number; to: number; label: string; url: string; title: string | null; reference: boolean }
export function linkAt(text: string, selection: Selection): LinkTarget | null {
  const tree = contentTree(text), from = Math.min(selection.anchor, selection.head), to = Math.max(selection.anchor, selection.head)
  const definitions = new Map<string, Definition>()
  for (const node of tree.children) if (node.type === 'definition' && !definitions.has(node.identifier.toLowerCase())) definitions.set(node.identifier.toLowerCase(), node)
  let found: LinkTarget | null = null
  function visit(node: Nodes) {
    if ((node.type === 'link' || node.type === 'linkReference') && node.position) {
      const a = node.position.start.offset!, b = node.position.end.offset!
      if (a <= from && b >= to) {
        const value = node.type === 'link' ? node : definitions.get(node.identifier.toLowerCase())
        const raw = text.slice(a, b)
        const labelEnd = raw.indexOf(']', (node.children.at(-1)?.position?.end.offset ?? a + 1) - a)
        const label = raw.startsWith('[') && labelEnd >= 0 ? raw.slice(1, labelEnd) : node.children.map(child => 'value' in child ? child.value : '').join('').replace(/([\\[\]])/g, '\\$1')
        if (value) found = { from: a, to: b, label, url: value.url, title: value.title ?? null, reference: node.type === 'linkReference' }
        return
      }
    }
    if ('children' in node) node.children.forEach(child => visit(child as Nodes))
  }
  visit(tree)
  return found
}
export function linkCommand(revision: number, text: string, selection: Selection, label: string, url: string): EditCommandResult {
  const target = safeLink(url)
  if (!target) throw new Error('地址无效；允许 http/https/mailto、页内锚点和相对文档路径。')
  if (!label.trim() || /[\r\n]/.test(label) || label.length > 10000) throw new Error('显示文字不能为空或包含换行，且不超过 10,000 字符。')
  const existing = linkAt(text, selection), from = existing?.from ?? Math.min(selection.anchor, selection.head), to = existing?.to ?? Math.max(selection.anchor, selection.head)
  const title = existing?.title ? ` "${existing.title.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` : ''
  const insert = `[${label}](<${target}>${title})`
  const node = parseMarkdownAst(insert).children[0]
  const unsupported = (child: Nodes): boolean => ['html', 'image', 'imageReference', 'link', 'linkReference'].includes(child.type) || ('children' in child && child.children.some(item => unsupported(item as Nodes)))
  if (node?.type !== 'paragraph' || node.children.length !== 1 || node.children[0].type !== 'link' || node.children[0].position?.end.offset !== insert.length || node.children[0].children.some(unsupported)) throw new Error('显示文字包含不支持的链接/图片或未转义括号，请调整后重试。')
  return { baseTextRevision: revision, patches: [{ from, to, insert }], selection: selection.anchor <= selection.head ? { anchor: from + 1, head: from + 1 + label.length } : { anchor: from + 1 + label.length, head: from + 1 } }
}
export function unlinkCommand(revision: number, text: string, selection: Selection): EditCommandResult {
  const target = linkAt(text, selection)
  if (!target) throw new Error('当前位置没有可解除的链接。')
  return { baseTextRevision: revision, patches: [{ from: target.from, to: target.to, insert: target.label }], selection: { anchor: target.from, head: target.from + target.label.length } }
}
