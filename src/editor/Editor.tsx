import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view'
import { history, historyKeymap, defaultKeymap, undo, redo } from '@codemirror/commands'
import { isolateHistory } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { tags } from '@lezer/highlight'
import type { FencedBlock } from '../core/code-block'
import type { TextPatch, Selection } from '../core/document'
import { WORKSPACE_IMAGE_TYPE, workspaceImageData, type WorkspaceImage } from '../platform/workspace'
import { nativeClipboardFiles, supportedImageFiles } from '../platform/clipboard'

export interface EditorHandle {
  selection(): Selection
  patch(patches: TextPatch[], selection?: Selection): boolean
  jump(offset: number): void
  undo(): void
  redo(): void
  composing(): boolean
  fencedCode(): FencedBlock | null
  scrollToSource(offset: number, ratio: number): void
}

const tokenStyle = HighlightStyle.define([
  { tag: tags.keyword, class: 'syntax-keyword' },
  { tag: [tags.string, tags.special(tags.string)], class: 'syntax-string' },
  { tag: [tags.number, tags.bool, tags.null], class: 'syntax-number' },
  { tag: tags.comment, class: 'syntax-comment' },
  { tag: [tags.function(tags.variableName), tags.typeName, tags.className], class: 'syntax-title' },
  { tag: [tags.propertyName, tags.attributeName], class: 'syntax-attribute' },
  { tag: tags.heading, class: 'syntax-heading' },
  { tag: tags.strong, fontWeight: 'bold' }, { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, textDecoration: 'underline' },
])

export interface SourceScroll { offset: number; fraction: number; ratio: number }
function fencedCode(editor: EditorView): FencedBlock | null {
  let node = syntaxTree(editor.state).resolveInner(editor.state.selection.main.head, -1)
  while (node.name !== 'FencedCode' && node.parent) node = node.parent
  if (node.name !== 'FencedCode') return null
  const opening = editor.state.doc.lineAt(node.from)
  const language = /^[`~]{3,}\s*([^\s]*)/.exec(editor.state.doc.sliceString(node.from, opening.to))?.[1] ?? ''
  return { from: node.from, to: node.to, language }
}

interface Props { initialText: string; onChange(text: string): void; onSave(): void; onCommand?(kind: string): void; onImages?(files: File[]): void; onClipboardFiles?(): void; onWorkspaceImage?(image: WorkspaceImage): void; onScroll?(position: SourceScroll): void; onCodeLanguage?(language: string | null): void }

export const Editor = forwardRef<EditorHandle, Props>(function Editor({ initialText, onChange, onSave, onCommand = () => undefined, onImages = () => undefined, onClipboardFiles = () => undefined, onWorkspaceImage = () => undefined, onScroll, onCodeLanguage }, ref) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const callbacks = useRef({ onChange, onSave, onCommand, onImages, onClipboardFiles, onWorkspaceImage, onScroll, onCodeLanguage })
  callbacks.current = { onChange, onSave, onCommand, onImages, onClipboardFiles, onWorkspaceImage, onScroll, onCodeLanguage }
  useImperativeHandle(ref, () => ({
    selection: () => view.current?.state.selection.main ?? { anchor: 0, head: 0 },
    composing: () => view.current?.composing ?? false,
    fencedCode: () => view.current ? fencedCode(view.current) : null,
    patch: (patches, selection) => {
      const editor = view.current
      if (!editor || editor.composing) return false
      editor.dispatch({ changes: patches, selection, userEvent: 'input.toolbar', annotations: isolateHistory.of('full') })
      editor.focus()
      return true
    },
    jump: (offset) => {
      const editor = view.current
      if (!editor) return
      const pos = Math.min(Math.max(offset, 0), editor.state.doc.length)
      editor.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 8 }) })
      editor.focus()
    },
    undo: () => { if (view.current && !view.current.composing) undo(view.current) },
    redo: () => { if (view.current && !view.current.composing) redo(view.current) },
    scrollToSource: (offset, ratio) => {
      const v = view.current
      if (!v) return
      v.requestMeasure({
        read: () => {
          const position = Math.min(v.state.doc.length, Math.max(0, Math.floor(offset)))
          const line = v.state.doc.lineAt(position)
          const block = v.lineBlockAt(position)
          const range = v.scrollDOM.scrollHeight - v.scrollDOM.clientHeight
          return ratio <= .001 ? 0 : ratio >= .999 ? range : block.top + (offset - line.from) / (line.length + 1) * block.height + v.documentTop - v.scrollDOM.getBoundingClientRect().top + v.scrollDOM.scrollTop
        },
        write: (top) => { v.scrollDOM.scrollTop = Math.max(0, top) },
      })
    },
  }), [])

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initialText,
        extensions: [
          lineNumbers(), history(), drawSelection(), highlightActiveLine(), EditorView.lineWrapping,
          markdown({ codeLanguages: languages }), syntaxHighlighting(tokenStyle),
          keymap.of([{ key: 'Mod-s', run: (v) => { if (!v.composing) callbacks.current.onSave(); return true } }, ...defaultKeymap, ...historyKeymap]),
          keymap.of([['Mod-b', 'bold'], ['Mod-i', 'italic'], ['Mod-k', 'link'], ['Mod-Shift-h', 'heading'], ['Mod-Shift-u', 'bullet'], ['Mod-Shift-o', 'ordered'], ['Mod-Shift-t', 'task'], ['Mod-Shift-q', 'quote'], ['Mod-Shift-c', 'code'], ['Mod-Shift-p', 'image']].map(([key, kind]) => ({ key, run: (v: EditorView) => { if (!v.composing) callbacks.current.onCommand(kind); return true } }))),
          EditorView.domEventHandlers({
            scroll: (_event, v) => {
              const scroll = v.scrollDOM
              const height = Math.max(0, scroll.getBoundingClientRect().top - v.documentTop)
              const line = v.lineBlockAtHeight(height)
              const range = scroll.scrollHeight - scroll.clientHeight
              callbacks.current.onScroll?.({ offset: line.from, fraction: Math.min(1, Math.max(0, (height - line.top) / line.height)), ratio: range > 0 ? scroll.scrollTop / range : 0 })
              return false
            },
            paste: (event, v) => {
              if (v.composing) return false
              const files = supportedImageFiles(event.clipboardData?.files ?? [])
              if (files.length) { event.preventDefault(); callbacks.current.onImages(files); return true }
              // WebView2 may omit CF_HDROP from DOM files. Preserve ordinary text paste.
              if (!event.clipboardData?.getData('text/plain') && nativeClipboardFiles()) {
                event.preventDefault(); callbacks.current.onClipboardFiles(); return true
              }
              return false
            },
            dragover: (event) => { if (!event.dataTransfer?.types.includes(WORKSPACE_IMAGE_TYPE)) return false; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; return true },
            drop: (event, v) => {
              if (v.composing) return false
              const image = workspaceImageData(event.dataTransfer?.getData(WORKSPACE_IMAGE_TYPE) ?? '')
              const files = supportedImageFiles(event.dataTransfer?.files ?? [])
              if (!image && !files.length) return false
              event.preventDefault()
              const position = v.posAtCoords({ x: event.clientX, y: event.clientY })
              if (position !== null) v.dispatch({ selection: { anchor: position } })
              if (image) callbacks.current.onWorkspaceImage(image)
              else callbacks.current.onImages(files)
              return true
            },
          }),
          EditorView.contentAttributes.of({ 'aria-label': 'Markdown 源码编辑器', spellcheck: 'false' }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString())
            if (update.selectionSet || update.docChanged) callbacks.current.onCodeLanguage?.(fencedCode(update.view)?.language ?? null)
          }),
        ],
      }),
    })
    view.current = editor
    callbacks.current.onCodeLanguage?.(fencedCode(editor)?.language ?? null)
    return () => { editor.destroy(); view.current = null }
  }, [])
  return <div ref={host} className="codemirror-host" />
})
