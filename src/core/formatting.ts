import type { Text } from '@codemirror/state'
import type { syntaxTree } from '@codemirror/language'
import { codeBlockCommand } from './code-block'
import type { EditCommandResult, Selection, TextPatch } from './document'

type Tree = ReturnType<typeof syntaxTree>
type Node = Tree['topNode']
export type Format = 'bold' | 'italic' | 'heading' | 'bullet' | 'ordered' | 'task' | 'quote' | 'code' | 'link'
export type FormatState = Record<Format, boolean | 'mixed'>
export const emptyFormats = (): FormatState => ({ bold: false, italic: false, heading: false, bullet: false, ordered: false, task: false, quote: false, code: false, link: false })
interface Span { from: number; to: number; start: number; end: number }

function inlineSpans(tree: Tree, from: number, to: number, kind: 'bold' | 'italic' | 'link'): Span[] {
  const spans: Span[] = []
  tree.iterate({ from, to, enter(ref) {
    const node = ref.node
    if (/^(FencedCode|CodeBlock|InlineCode)$/.test(node.name)) return false
    if (kind === 'link' ? node.name !== 'Link' && node.name !== 'LinkReference' : node.name !== (kind === 'bold' ? 'StrongEmphasis' : 'Emphasis')) return
    const marks: Node[] = []
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === (kind === 'link' ? 'LinkMark' : 'EmphasisMark')) marks.push(child)
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
  for (const kind of ['bold', 'italic', 'link'] as const) state[kind] = inlineCoverage(doc, inlineSpans(tree, from, to, kind), from, to)
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

function inlineCommand(revision: number, doc: Text, selection: Selection, tree: Tree, kind: 'bold' | 'italic' | 'link'): EditCommandResult {
  let from = Math.min(selection.anchor, selection.head), to = Math.max(selection.anchor, selection.head)
  const spans = inlineSpans(tree, from, to, kind), active = inlineCoverage(doc, spans, from, to) === true
  if (kind === 'link') {
    if (active) return result(revision, spans.flatMap(span => [{ from: span.from, to: span.start, insert: '' }, { from: span.end, to: span.to, insert: '' }]), selection)
    // Preserve existing labels rather than nesting links inside another link.
    if (spans.length) { from = Math.min(from, ...spans.map(span => span.from)); to = Math.max(to, ...spans.map(span => span.to)) }
  }
  if (from === to && active) { from = Math.min(...spans.map(span => span.start)); to = Math.max(...spans.map(span => span.end)) }
  const originalFrom = from, originalTo = to
  if (active && kind !== 'link') {
    // Nested delimiters are not visible text. If their entire label is selected,
    // cancel the outer format around those delimiters as well (***both***).
    for (const other of ['bold', 'italic', 'link'] as const) {
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
  if (from === to && !active) { plain = plain.slice(0, selectedFrom) + (kind === 'link' ? '链接文字' : '文本') + plain.slice(selectedFrom); selectedTo += kind === 'link' ? 4 : 2 }
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
  const marker = kind === 'bold' ? '**' : kind === 'italic' ? '*' : '['
  const inserts: TextPatch[] = []
  for (let [a, b] of merged) {
    // CommonMark delimiters cannot enclose leading/trailing whitespace.
    while (a < b && /\s/.test(plain[a])) a++
    while (b > a && /\s/.test(plain[b - 1])) b--
    if (a === b) continue
    inserts.push({ from: a, to: a, insert: marker }, { from: b, to: b, insert: kind === 'link' ? '](https://example.com)' : marker })
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

export function toggleFormat(revision: number, doc: Text, selection: Selection, tree: Tree, kind: Format, language = ''): EditCommandResult {
  if (kind === 'bold' || kind === 'italic' || kind === 'link') return inlineCommand(revision, doc, selection, tree, kind)
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
