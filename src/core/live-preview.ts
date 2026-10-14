import type { EditorState, Text } from '@codemirror/state'
import type { syntaxTree } from '@codemirror/language'

export const MAX_LIVE_DOCUMENT = 1024 * 1024
export const MAX_LIVE_BLOCK = 100_000
type Tree = ReturnType<typeof syntaxTree>
export interface SourceRange { from: number; to: number }
export interface LiveToken extends SourceRange { kind: 'hide' | 'mark' | 'line' | 'symbol'; className?: string; text?: string }

export function frontmatterEnd(doc: Text): number {
  const opening = doc.line(1).text.replace(/^\uFEFF/, '')
  if (opening !== '---' && opening !== '+++') return 0
  // An unclosed or unusually large header stays entirely in source form.
  for (let i = 2; i <= doc.lines; i++) {
    const line = doc.line(i)
    if (line.from > MAX_LIVE_BLOCK) break
    if (line.text === opening || (opening === '---' && line.text === '...')) return line.to
  }
  return doc.length
}

export function touches(ranges: readonly SourceRange[], from: number, to: number): boolean {
  return ranges.some(range => range.from <= to && range.to >= from)
}

export function activeSourceRanges(state: EditorState, tree: Tree): SourceRange[] {
  const ranges: SourceRange[] = []
  for (const selection of state.selection.ranges) {
    ranges.push({ from: state.doc.lineAt(selection.from).from, to: state.doc.lineAt(selection.to).to })
    // Resolve only selection endpoints, rather than walking the whole document.
    for (const pos of [selection.from, selection.to]) {
      let node = tree.resolveInner(pos, -1)
      while (node.parent && node.parent.name !== 'Document') node = node.parent
      if (node.name !== 'Document' && node.from <= pos && node.to >= pos) ranges.push({ from: node.from, to: node.to })
    }
    if (!selection.empty) ranges.push({ from: selection.from, to: selection.to })
  }
  return ranges
}

// Describe presentation only. None of these ranges are document changes.
export function liveTokens(state: EditorState, tree: Tree, visible: readonly SourceRange[], protectedRanges: readonly SourceRange[], headerEnd: number): LiveToken[] {
  const tokens: LiveToken[] = []
  const seen = new Set<string>()
  const add = (token: LiveToken) => {
    if (token.kind !== 'line' && token.to <= token.from) return
    const key = `${token.kind}:${token.from}:${token.to}:${token.className ?? ''}`
    if (!seen.has(key)) { seen.add(key); tokens.push(token) }
  }
  const hide = (from: number, to: number) => {
    // View-plugin replacements must never cover line breaks.
    if (state.doc.lineAt(from).number === state.doc.lineAt(to).number) add({ kind: 'hide', from, to })
  }
  for (const range of visible) tree.iterate({ from: range.from, to: range.to, enter(ref) {
    const node = ref.node
    if (node.to <= headerEnd || /^(FencedCode|CodeBlock|HTMLBlock|HTMLTag|Image|ImageReference|Table|LinkReference|LinkReferenceDefinition)$/.test(node.name)) return false
    if (touches(protectedRanges, node.from, node.to)) {
      // A selected top-level block retains every syntax marker, including nesting.
      if (node.parent?.name === 'Document') return false
      return
    }
    const heading = /^(ATXHeading|SetextHeading)([1-6])$/.exec(node.name)
    if (heading) add({ kind: 'line', from: state.doc.lineAt(node.from).from, to: state.doc.lineAt(node.from).from, className: `live-heading live-h${heading[2]}` })
    if (node.name === 'HeaderMark') {
      let from = node.from, to = node.to
      const line = state.doc.lineAt(from)
      if (from === line.from) { while (to < line.to && /[ \t]/.test(state.doc.sliceString(to, to + 1))) to++ }
      else { while (from > line.from && /[ \t]/.test(state.doc.sliceString(from - 1, from))) from-- }
      hide(from, to)
    }
    if (node.name === 'StrongEmphasis' || node.name === 'Emphasis' || node.name === 'Strikethrough' || node.name === 'InlineCode') {
      add({ kind: 'mark', from: node.from, to: node.to, className: { StrongEmphasis: 'live-strong', Emphasis: 'live-emphasis', Strikethrough: 'live-strike', InlineCode: 'live-code' }[node.name] })
    }
    if (/^(EmphasisMark|StrikethroughMark|CodeMark)$/.test(node.name)) hide(node.from, node.to)
    if (node.name === 'Link') {
      const marks = []
      for (let child = node.firstChild; child; child = child.nextSibling) if (child.name === 'LinkMark') marks.push(child)
      if (marks.length >= 2) {
        hide(node.from, marks[0].to); hide(marks[1].from, node.to)
        add({ kind: 'mark', from: marks[0].to, to: marks[1].from, className: 'live-link' })
      }
    }
    if (node.name === 'ListMark' && node.parent?.parent?.name === 'BulletList') add({ kind: 'symbol', from: node.from, to: node.to, text: '•', className: 'live-bullet' })
    if (node.name === 'TaskMarker') add({ kind: 'symbol', from: node.from, to: node.to, text: /[xX]/.test(state.doc.sliceString(node.from, node.to)) ? '☑' : '☐', className: 'live-task' })
    if (node.name === 'QuoteMark') {
      add({ kind: 'line', from: state.doc.lineAt(node.from).from, to: state.doc.lineAt(node.from).from, className: 'live-quote' })
      hide(node.from, node.to)
    }
  } })
  return tokens
}
