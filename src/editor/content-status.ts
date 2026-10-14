import type { EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import type { CommandStatus } from '../core/commands'

// Toolbar availability uses the existing incremental tree. The command itself
// still validates the complete shared Markdown AST before making any patch.
export function contentStatus(state: EditorState, kind: 'table' | 'paragraph', offset = state.selection.main.head): CommandStatus {
  const doc = state.doc, selection = state.selection.main
  if (offset < 0 || offset > doc.length) return { enabled: false }
  const tree = syntaxTree(state)
  if (kind === 'table') {
    for (const bias of [-1, 1] as const) {
      let node = tree.resolveInner(offset, bias)
      while (node.parent) {
        if (node.name === 'Table') return { enabled: node.parent.name === 'Document', reason: '嵌套表格请使用源码编辑。' }
        node = node.parent
      }
    }
    return { enabled: false, reason: '请将光标放在顶层 GFM 表格中。' }
  }
  if (doc.length > 1024 * 1024) return { enabled: false, reason: '就地内容工具暂限 1 Mi 字符，请使用源码编辑。' }
  const from = doc.lineAt(selection.from).from, to = doc.lineAt(selection.to > selection.from && doc.lineAt(selection.to).from === selection.to ? selection.to - 1 : selection.to).to
  if (to - from > 100000) return { enabled: false, reason: '转换范围超过 100,000 字符，请缩小选区。' }
  let unsafe = false
  tree.iterate({ from, to, enter(node) {
    if (/^(FencedCode|CodeBlock|Table|HTMLBlock|HorizontalRule|LinkReference)$/.test(node.name)) { unsafe = true; return false }
  } })
  // The incremental Markdown parser has no front matter extension.
  const first = doc.line(1).text.replace(/^\uFEFF/, '')
  if (from === 0 && /^(---|\+\+\+)\s*$/.test(first)) unsafe = true
  return unsafe ? { enabled: false, reason: '复杂结构请使用源码编辑。' } : { enabled: true }
}
