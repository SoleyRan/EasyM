import { syntaxTree } from '@codemirror/language'
import { Decoration, ViewPlugin, type DecorationSet, type ViewUpdate, type EditorView } from '@codemirror/view'

// Inspect only visible syntax ranges, without serializing the Markdown document.
function codeLines(view: EditorView): DecorationSet {
  const starts = new Set<number>()
  for (const range of view.visibleRanges) syntaxTree(view.state).iterate({ from: range.from, to: range.to, enter(node) {
    if (node.name !== 'FencedCode' && node.name !== 'CodeBlock') return
    let line = view.state.doc.lineAt(Math.max(range.from, node.from))
    const end = Math.min(range.to, Math.max(node.from, node.to - 1))
    while (line.from <= end) {
      starts.add(line.from)
      if (line.to >= end || line.number === view.state.doc.lines) break
      line = view.state.doc.line(line.number + 1)
    }
    return false
  } })
  return Decoration.set([...starts].sort((a, b) => a - b).map(from => Decoration.line({ class: 'cm-source-code' }).range(from)))
}
export const codeAppearance = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = codeLines(view) }
  update(update: ViewUpdate) { if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) this.decorations = codeLines(update.view) }
}, { decorations: value => value.decorations })
