import type { Nodes, Root } from 'mdast'
import { parseMarkdownAst } from './markdown-ast'
import type { EditCommandResult, Selection } from './document'
import type { FencedBlock } from './code-block'

let cachedText: string | undefined, cachedTree: Root
export function contentTree(text: string): Root {
  if (text.length > 1024 * 1024) throw new Error('就地内容工具暂限 1 Mi 字符，请使用源码编辑。')
  if (cachedText !== text) {
    const bom = text.startsWith('\uFEFF')
    cachedTree = parseMarkdownAst(bom ? text.slice(1) : text)
    if (bom) {
      const shift = (node: Nodes) => {
        if (node.position) for (const point of [node.position.start, node.position.end]) { if (point.offset !== undefined) point.offset++; if (point.line === 1) point.column++ }
        if ('children' in node) node.children.forEach(child => shift(child as Nodes))
      }
      shift(cachedTree)
    }
    cachedText = text
  }
  return cachedTree
}
const start = (node: Nodes) => node.position?.start.offset ?? -1
const end = (node: Nodes) => node.position?.end.offset ?? -1
export function codeAt(text: string, offset: number): FencedBlock {
  const node = contentTree(text).children.find(node => node.type === 'code' && start(node) <= offset && end(node) >= offset)
  if (!node || node.type !== 'code' || !/^[`~]{3,}/.test(text.slice(start(node)))) throw new Error('请选择顶层围栏代码块；嵌套代码请使用源码语言入口。')
  return { from: start(node), to: end(node), language: node.lang ?? '' }
}

export type ParagraphKind = 'paragraph' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'bullet' | 'ordered' | 'task' | 'quote'
export const paragraphKinds: Array<[ParagraphKind, string]> = [['paragraph', '正文'], ['h1', 'H1'], ['h2', 'H2'], ['h3', 'H3'], ['h4', 'H4'], ['h5', 'H5'], ['h6', 'H6'], ['bullet', '无序列表'], ['ordered', '有序列表'], ['task', '任务列表'], ['quote', '引用']]
export interface ParagraphTarget { from: number; to: number; lineFrom: number; lineTo: number }
export function paragraphTarget(text: string, selection: Selection): ParagraphTarget {
  const a = Math.min(selection.anchor, selection.head), b = Math.max(selection.anchor, selection.head)
  if (![a, b].every(value => Number.isInteger(value) && value >= 0 && value <= text.length)) throw new Error('选区无效。')
  let from = a === 0 ? 0 : text.lastIndexOf('\n', a - 1) + 1
  let to = text.indexOf('\n', b > a && text[b - 1] === '\n' ? b - 1 : b)
  if (to < 0) to = text.length
  const tree = contentTree(text)
  const touched = tree.children.filter(node => start(node) < Math.max(to, from + 1) && end(node) > from)
  if (a === b) {
    const node = touched.find(node => start(node) <= a && end(node) >= a)
    if (node && (node.type === 'paragraph' || node.type === 'heading')) { from = start(node); to = end(node) }
  }
  const supported = (node: Nodes): boolean => {
    if (node.type === 'paragraph' || node.type === 'heading') return true
    if (node.type === 'list') return node.children.every(item => item.children.length === 1 && item.children[0].type === 'paragraph' && item.position?.start.line === item.position?.end.line)
    if (node.type === 'blockquote') return node.children.every(item => item.type === 'paragraph' && item.position?.start.line === item.position?.end.line)
    return false
  }
  if (touched.some(node => !supported(node)) || /^[ \t]{2,}\S/m.test(text.slice(from, to))) throw new Error('代码、表格、Front matter、HTML 和复杂嵌套结构请在源码中编辑。')
  // A selected setext heading always includes its underline.
  for (const node of touched) if (node.type === 'heading' && /\n[ \t]*[=-]+[ \t]*$/.test(text.slice(start(node), end(node)))) {
    from = Math.min(from, start(node)); to = Math.max(to, end(node))
  }
  if (from === 0 && text.startsWith('\uFEFF')) from++
  if (to - from > 100000) throw new Error('转换范围超过 100,000 字符，请缩小选区。')
  return { from, to, lineFrom: text.slice(0, from).split('\n').length, lineTo: text.slice(0, to).split('\n').length }
}
export function paragraphCommand(revision: number, text: string, selection: Selection, kind: ParagraphKind): EditCommandResult {
  if (!paragraphKinds.some(([value]) => value === kind)) throw new Error('转换类型无效。')
  const target = paragraphTarget(text, selection), source = text.slice(target.from, target.to)
  const setext = new Set<number>()
  for (const node of contentTree(text).children) if (node.type === 'heading' && start(node) >= target.from - (text.startsWith('\uFEFF') ? 1 : 0) && end(node) <= target.to) {
    const raw = text.slice(start(node), end(node)), match = /\r?\n[ \t]*[=-]+[ \t]*$/.exec(raw)
    if (match) setext.add(start(node) + match.index - target.from)
  }
  // Remove only the setext underline and its preceding EOL, retaining all other EOL bytes.
  let offset = 0
  const pieces = source.split(/(\r?\n)/)
  const insert = pieces.map((line, index) => {
    const at = offset; offset += line.length
    if (index % 2 && setext.has(at)) return ''
    if (!(index % 2) && index > 0 && setext.has(at - pieces[index - 1].length)) return ''
    if (index % 2 || !line.trim()) return line
    let body = line.replace(/^(?: {0,3}> ?| {0,3}#{1,6}(?:[ \t]+|$)| {0,3}(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/, '')
    if (/^ {0,3}#{1,6}(?:[ \t]+|$)/.test(line)) body = body.replace(/[ \t]+#+[ \t]*$/, '')
    const prefix = kind === 'paragraph' ? '' : kind.startsWith('h') ? '#'.repeat(Number(kind.slice(1))) + ' ' : { bullet: '- ', ordered: '1. ', task: '- [ ] ', quote: '> ' }[kind as 'bullet' | 'ordered' | 'task' | 'quote']
    return prefix + body
  }).join('')
  return { baseTextRevision: revision, patches: [{ from: target.from, to: target.to, insert }], selection: selection.anchor <= selection.head ? { anchor: target.from, head: target.from + insert.length } : { anchor: target.from + insert.length, head: target.from } }
}
