import type { Text } from '@codemirror/state'
import type { syntaxTree } from '@codemirror/language'
import { codeBlockCommand } from './code-block'
import type { EditCommandResult, Selection, TextPatch } from './document'
import { frontmatterEnd } from './live-preview'

type Tree = ReturnType<typeof syntaxTree>
type Node = Tree['topNode']
export type Format = 'bold' | 'italic' | 'strike' | 'inlineCode' | 'heading' | 'bullet' | 'ordered' | 'task' | 'quote' | 'code' | 'link'
export type FormatState = Record<Format, boolean | 'mixed'>
export const emptyFormats = (): FormatState => ({ bold: false, italic: false, strike: false, inlineCode: false, heading: false, bullet: false, ordered: false, task: false, quote: false, code: false, link: false })
interface Span { from: number; to: number; start: number; end: number }

export function inlineFormatStatus(doc: Text, selection: Selection, tree: Tree, kind: InlineFormat): { enabled: boolean; reason?: string } {
  const from = Math.min(selection.anchor, selection.head), to = Math.max(selection.anchor, selection.head)
  if (to - from > 10000 || doc.sliceString(from, to).includes('\n')) return { enabled: false, reason: '请选择单个逻辑行内的文字；跨段格式请分段操作。' }
  if (from < frontmatterEnd(doc)) return { enabled: false, reason: 'Front matter 请使用源码编辑。' }
  let unsafe = false
  tree.iterate({ from, to, enter(ref) {
    if (/^(FencedCode|CodeBlock|Table|HTMLBlock|HTMLTag|LinkReferenceDefinition|Image|ImageReference)$/.test(ref.name)) unsafe = true
    if (from !== to && /^(HeaderMark|QuoteMark|ListMark|TaskMarker)$/.test(ref.name) && ref.from < to && ref.to > from) unsafe = true
    if (from !== to && ref.name === 'URL' && ref.from < to && ref.to > from && kind !== 'link') unsafe = true
    if (ref.name === 'InlineCode') {
      if (kind !== 'inlineCode') unsafe = true
      else {
        const span = inlineSpans(tree, from, to, 'inlineCode').find(span => span.from === ref.from)
        if (span) {
          const body = doc.sliceString(span.start, span.end)
          if (body.startsWith(' ') && body.endsWith(' ') && !/^ +$/.test(body)) { span.start++; span.end-- }
        }
        if (span && from !== to && !(from <= span.start && to >= span.end)) unsafe = true
      }
    }
  } })
  return unsafe ? { enabled: false, reason: '代码、表格、图片和复杂语法选区请使用源码编辑。' } : { enabled: true }
}

type InlineFormat = 'bold' | 'italic' | 'strike' | 'inlineCode' | 'link'
function inlineSpans(tree: Tree, from: number, to: number, kind: InlineFormat): Span[] {
  const spans: Span[] = []
  tree.iterate({ from, to, enter(ref) {
    const node = ref.node
    if (/^(FencedCode|CodeBlock)$/.test(node.name) || (node.name === 'InlineCode' && kind !== 'inlineCode')) return false
    const target = kind === 'link' ? /^(Link|LinkReference)$/ : kind === 'bold' ? /^StrongEmphasis$/ : kind === 'italic' ? /^Emphasis$/ : kind === 'strike' ? /^Strikethrough$/ : /^InlineCode$/
    if (!target.test(node.name)) return
    const marks: Node[] = []
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === (kind === 'link' ? 'LinkMark' : kind === 'strike' ? 'StrikethroughMark' : kind === 'inlineCode' ? 'CodeMark' : 'EmphasisMark')) marks.push(child)
    }
    if (marks.length < 2) return
    const span = { from: node.from, to: node.to, start: marks[0].to, end: marks[1].from }
    if (kind !== 'link') span.end = marks.at(-1)!.from
    if (from === to ? from >= span.start && from <= span.end : from < span.end && to > span.start) spans.push(span)
  } })
  return spans
}

function coverage(spans: Span[], from: number, to: number): boolean | 'mixed' {
  if (!spans.length) return false
  if (from === to) return true
  let covered = from
  for (const span of [...spans].sort((a, b) => a.from - b.from)) {
    if (span.from > covered) return 'mixed'
    covered = Math.max(covered, span.to)
  }
  return covered >= to ? true : 'mixed'
}

function inlineCoverage(doc: Text, spans: Span[], from: number, to: number) {
  if (from === to) return coverage(spans, from, to)
  while (from < to && /\s/.test(doc.sliceString(from, from + 1))) from++
  while (to > from && /\s/.test(doc.sliceString(to - 1, to))) to--
  return from === to ? false : coverage(spans, from, to)
}

function enclosing(tree: Tree, from: number, to: number, names: RegExp): Node | null {
  for (const bias of [1, -1] as const) {
    let node: Node | null = tree.resolveInner(from, bias)
    while (node) {
      if (names.test(node.name) && node.from <= from && node.to >= to) return node
      node = node.parent
    }
  }
  return null
}

function lines(doc: Text, from: number, to: number) {
  // A selection ending at the next line's start does not select that line.
  const first = doc.lineAt(from).number, last = doc.lineAt(to > from && doc.lineAt(to).from === to ? to - 1 : to).number
  return Array.from({ length: last - first + 1 }, (_, index) => doc.line(first + index))
}

function lineParts(text: string) {
  const quote = /^([ \t]*)(?:>[ \t]?)+/.exec(text)
  const container = quote?.[0] ?? /^[ \t]*/.exec(text)![0]
  const rest = text.slice(container.length)
  const list = /^(?:([-+*])[ \t]+|(\d+[.)])[ \t]+)(\[[ xX]\][ \t]+)?/.exec(rest)
  const heading = /^(#{1,6})(?:[ \t]+|$)/.exec(rest)
  return { container, quote, list, heading }
}

export function formatState(doc: Text, selection: Selection, tree: Tree): FormatState {
  const from = Math.min(selection.anchor, selection.head), to = Math.max(selection.anchor, selection.head)
  const state = emptyFormats()
  for (const kind of ['bold', 'italic', 'strike', 'inlineCode', 'link'] as const) state[kind] = inlineCoverage(doc, inlineSpans(tree, from, to, kind), from, to)
  state.code = !!enclosing(tree, from, to, /^FencedCode$/)
  const selected = lines(doc, from, to)
  for (const kind of ['heading', 'bullet', 'ordered', 'task', 'quote'] as const) {
    const active = selected.map(line => {
      if (enclosing(tree, line.from, line.to, /^(FencedCode|CodeBlock)$/)) return false
      const parts = lineParts(line.text)
      if (kind === 'heading') return !!parts.heading || !!enclosing(tree, line.from, line.to, /^SetextHeading/)
      if (kind === 'quote') return !!parts.quote
      if (kind === 'task') return !!parts.list?.[3]
      if (kind === 'bullet') return !!parts.list?.[1] && !parts.list[3]
      return !!parts.list?.[2] && !parts.list[3]
    })
    state[kind] = active.every(Boolean) ? true : active.some(Boolean) ? 'mixed' : false
  }
  return state
}

function mapped(pos: number, patches: TextPatch[], after = true) {
  let shift = 0
  for (const patch of patches) {
    if (pos < patch.from || (pos === patch.from && !after)) break
    if (pos <= patch.to) return patch.from + shift + (after ? patch.insert.length : 0)
    shift += patch.insert.length - (patch.to - patch.from)
  }
  return pos + shift
}

function result(revision: number, patches: TextPatch[], selection: Selection): EditCommandResult {
  patches.sort((a, b) => a.from - b.from)
  return { baseTextRevision: revision, patches, selection: { anchor: mapped(selection.anchor, patches), head: mapped(selection.head, patches) } }
}

function inlineCommand(revision: number, doc: Text, selection: Selection, tree: Tree, kind: InlineFormat): EditCommandResult {
  let from = Math.min(selection.anchor, selection.head), to = Math.max(selection.anchor, selection.head)
  const spans = inlineSpans(tree, from, to, kind), active = inlineCoverage(doc, spans, from, to) === true
  if (kind === 'inlineCode') for (const span of spans) {
    const body = doc.sliceString(span.start, span.end)
    if (body.startsWith(' ') && body.endsWith(' ') && !/^ +$/.test(body)) { span.start++; span.end-- }
  }
  if (kind === 'link') {
    if (active) return result(revision, spans.flatMap(span => [{ from: span.from, to: span.start, insert: '' }, { from: span.end, to: span.to, insert: '' }]), selection)
    throw new Error('请使用链接工具输入显示文字和地址。')
  }
  if (from === to && active) { from = Math.min(...spans.map(span => span.start)); to = Math.max(...spans.map(span => span.end)) }
  const originalFrom = from, originalTo = to
  if (active) {
    // Nested delimiters are not visible text. If their entire label is selected,
    // cancel the outer format around those delimiters as well (***both***).
    for (const other of ['bold', 'italic', 'strike', 'inlineCode', 'link'] as const) {
      if (other === kind) continue
      for (const nested of inlineSpans(tree, from, to, other)) {
        if (nested.start >= from && nested.end <= to && spans.some(span => span.start <= nested.from && span.end >= nested.to)) {
          from = Math.min(from, nested.from); to = Math.max(to, nested.to)
        }
      }
    }
  }
  const start = Math.min(from, ...spans.map(span => span.from)), end = Math.max(to, ...spans.map(span => span.to))
  const deletions = spans.flatMap(span => [{ from: span.from, to: span.start, insert: '' }, { from: span.end, to: span.to, insert: '' }]).sort((a, b) => a.from - b.from)
  let plain = doc.sliceString(start, end)
  for (const patch of [...deletions].reverse()) plain = plain.slice(0, patch.from - start) + plain.slice(patch.to - start)
  let selectedFrom = mapped(from, deletions) - start, selectedTo = mapped(to, deletions) - start
  if (from === to && !active) { plain = plain.slice(0, selectedFrom) + '文本' + plain.slice(selectedFrom); selectedTo += 2 }
  const ranges: Array<[number, number]> = []
  for (const span of spans) {
    const a = mapped(span.start, deletions) - start, b = mapped(span.end, deletions) - start
    if (a < selectedFrom) ranges.push([a, Math.min(b, selectedFrom)])
    if (b > selectedTo) ranges.push([Math.max(a, selectedTo), b])
  }
  if (!active) ranges.push([selectedFrom, selectedTo])
  ranges.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const [a, b] of ranges) {
    if (merged.length && merged.at(-1)![1] >= a) merged.at(-1)![1] = Math.max(b, merged.at(-1)![1])
    else merged.push([a, b])
  }
  const marker = kind === 'bold' ? '**' : kind === 'italic' ? '*' : kind === 'strike' ? '~~' : kind === 'inlineCode' ? '`' : '['
  const inserts: TextPatch[] = []
  for (let [a, b] of merged) {
    // CommonMark delimiters cannot enclose leading/trailing whitespace.
    while (a < b && /\s/.test(plain[a])) a++
    while (b > a && /\s/.test(plain[b - 1])) b--
    if (a === b) continue
    let startMarker = marker, endMarker = marker
    if (kind === 'inlineCode') {
      let longest = 0
      for (const match of plain.slice(a, b).matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
      startMarker = endMarker = '`'.repeat(longest + 1)
      if (plain[a] === '`' || plain[b - 1] === '`') { startMarker += ' '; endMarker = ' ' + endMarker }
    }
    inserts.push({ from: a, to: a, insert: startMarker }, { from: b, to: b, insert: endMarker })
  }
  inserts.sort((a, b) => a.from - b.from)
  const selectionFrom = from === originalFrom ? selectedFrom : mapped(originalFrom, deletions) - start
  const selectionTo = to === originalTo ? selectedTo : mapped(originalTo, deletions) - start
  selectedFrom = mapped(selectionFrom, inserts)
  selectedTo = mapped(selectionTo, inserts, false)
  for (const patch of [...inserts].reverse()) plain = plain.slice(0, patch.from) + patch.insert + plain.slice(patch.to)
  const anchor = start + selectedFrom, head = start + selectedTo
  return { baseTextRevision: revision, patches: [{ from: start, to: end, insert: plain }], selection: selection.anchor <= selection.head ? { anchor, head } : { anchor: head, head: anchor } }
}

const listItem = /^([ \t]*)(?:([-+*])|(\d{1,9})([.)]))([ \t]+|$)/
const width = (indent: string) => indent.replace(/\t/g, '    ').length

/**
 * Tab / Shift+Tab inside list items. Tab nests the selected items under the previous item
 * (indent = that item's content column, so CommonMark nests ordered children too) and restarts
 * ordered markers at 1. Shift+Tab moves them back to the parent's marker column and continues
 * the parent's numbering. Deeper lines that follow (children, continuation text) move along.
 * Returns null when the selection is not on list items, so Tab keeps its keyboard-navigation
 * meaning; on list items that cannot move it returns an empty edit so focus stays in the editor.
 */
export function indentListItems(revision: number, doc: Text, selection: Selection, tree: Tree, outdent: boolean): EditCommandResult | null {
  const from = Math.min(selection.anchor, selection.head), to = Math.max(selection.anchor, selection.head)
  if (from < frontmatterEnd(doc)) return null
  const selected = lines(doc, from, to)
  // Quotes, code blocks and tables keep their own Tab meaning (or none).
  if (selected.some(line => enclosing(tree, line.from, line.to, /^(FencedCode|CodeBlock|Table|Blockquote)$/))) return null
  const items = selected.map(line => ({ line, match: listItem.exec(line.text) }))
  if (!items.some(item => item.match)) return null
  if (items.some(item => !item.match && item.line.text.trim())) return null
  const first = items.find(item => item.match)!
  const indent = width(first.match![1])
  // On list items Tab is always consumed, even when nothing can move, so focus does not jump away.
  const none = { baseTextRevision: revision, patches: [], selection }
  if (items.some(item => item.match && width(item.match[1]) < indent)) return none
  // Walk up: the nearest same-level item is the previous sibling, the first shallower item is the
  // parent. Deeper items and blank/continuation lines belong to the list; shallower plain text ends it.
  let previous: RegExpExecArray | null = null, parent: RegExpExecArray | null = null
  for (let number = first.line.number - 1; number >= 1; number--) {
    const text = doc.line(number).text
    const match = listItem.exec(text)
    const level = width(/^[ \t]*/.exec(text)![0])
    if (!match) { if (text.trim() && level < indent) break; continue }
    if (level < indent) { parent = match; break }
    if (level === indent && !previous) previous = match
  }
  const target = outdent ? parent : previous
  if (!target) return none
  // Content column of the target item; 1–4 spaces after the marker count, more means an indented code start.
  const gap = width(target[5])
  const column = outdent ? width(target[1]) : width(target[1]) + (target[2] ?? target[3] + target[4]).length + (gap >= 1 && gap <= 4 ? gap : 1)
  const shift = column - indent
  const patches: TextPatch[] = []
  let number = outdent && target[3] ? Number(target[3]) + 1 : 1
  for (const { line, match } of items) {
    if (!match) continue
    const own = width(match[1]), next = Math.max(0, own + shift)
    // One patch per line (indent plus, on the moved level, the renumbered marker) so patches never touch.
    // Only items on the moved level are renumbered; deeper selected items keep their numbers.
    const renumber = !!match[3] && own === indent
    patches.push({ from: line.from, to: line.from + match[1].length + (renumber ? match[3].length : 0), insert: ' '.repeat(next) + (renumber ? String(number++) : '') })
  }
  // Children and continuation lines of the last moved item keep their position relative to it.
  for (let number = selected.at(-1)!.number + 1; number <= doc.lines; number++) {
    const line = doc.line(number)
    if (!line.text.trim()) continue
    const lead = /^[ \t]*/.exec(line.text)![0]
    if (width(lead) <= indent) break
    patches.push({ from: line.from, to: line.from + lead.length, insert: ' '.repeat(Math.max(0, width(lead) + shift)) })
  }
  return result(revision, patches, selection)
}

export function toggleFormat(revision: number, doc: Text, selection: Selection, tree: Tree, kind: Format, language = ''): EditCommandResult {
  if (kind === 'bold' || kind === 'italic' || kind === 'strike' || kind === 'inlineCode' || kind === 'link') {
    const status = inlineFormatStatus(doc, selection, tree, kind)
    if (!status.enabled) throw new Error(status.reason)
    return inlineCommand(revision, doc, selection, tree, kind)
  }
  const from = Math.min(selection.anchor, selection.head), to = Math.max(selection.anchor, selection.head)
  if (kind === 'code') {
    const node = enclosing(tree, from, to, /^FencedCode$/)
    const opening = node?.firstChild, closing = node?.lastChild
    if (node && opening?.name === 'CodeMark' && closing?.name === 'CodeMark' && closing.from > opening.to) {
      const start = doc.lineAt(node.from).to + 1, end = doc.lineAt(closing.from).from
      const bodyEnd = end > start ? end - 1 : end
      return result(revision, [{ from: node.from, to: start, insert: '' }, { from: bodyEnd, to: node.to, insert: '' }], selection)
    }
    if (node && opening?.name === 'CodeMark') {
      const line = doc.lineAt(node.from)
      return result(revision, [{ from: node.from, to: Math.min(doc.length, line.to + 1), insert: '' }], selection)
    }
    return codeBlockCommand(revision, doc.toString(), selection, language, null)
  }
  const active = formatState(doc, selection, tree)[kind] === true
  const patches: TextPatch[] = []
  const setext = new Set<number>()
  const selectedLines = lines(doc, from, to)
  for (const line of selectedLines) {
    const parts = lineParts(line.text), container = parts.container.length
    if (kind === 'quote') {
      const indent = /^[ \t]*/.exec(line.text)![0].length
      const quote = /^>[ \t]?/.exec(line.text.slice(indent))
      if (active && quote) patches.push({ from: line.from + indent, to: line.from + indent + quote[0].length, insert: '' })
      else if (!quote) patches.push({ from: line.from + indent, to: line.from + indent, insert: '> ' })
      continue
    }
    if (kind === 'heading') {
      const node = enclosing(tree, line.from, line.to, /^SetextHeading/)
      if (node) {
        const underline = node.lastChild
        if (underline?.name === 'HeaderMark' && line.from === doc.lineAt(underline.from).from) continue
        if (underline?.name === 'HeaderMark' && !setext.has(underline.from)) {
          setext.add(underline.from)
          patches.push({ from: doc.lineAt(underline.from).from - 1, to: doc.lineAt(underline.to).to, insert: '' })
        }
      }
      if (!active || parts.heading) patches.push({ from: line.from + container, to: line.from + container + (parts.heading?.[0].length ?? 0), insert: active ? '' : '## ' })
      const closing = parts.heading && /[ \t]+#+[ \t]*$/.exec(line.text)
      if (active && closing) patches.push({ from: line.from + Math.max(closing.index, container + parts.heading![0].length), to: line.to, insert: '' })
    } else {
      patches.push({ from: line.from + container, to: line.from + container + (parts.list?.[0].length ?? 0), insert: active ? '' : { bullet: '- ', ordered: '1. ', task: '- [ ] ' }[kind] })
    }
  }
  return result(revision, patches, selection)
}
