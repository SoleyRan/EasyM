import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view'
import { history, historyKeymap, defaultKeymap, undo, redo } from '@codemirror/commands'
import { isolateHistory } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
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
}

interface Props { initialText: string; onChange(text: string): void; onSave(): void; onCommand?(kind: string): void; onImages?(files: File[]): void; onClipboardFiles?(): void; onWorkspaceImage?(image: WorkspaceImage): void }

export const Editor = forwardRef<EditorHandle, Props>(function Editor({ initialText, onChange, onSave, onCommand = () => undefined, onImages = () => undefined, onClipboardFiles = () => undefined, onWorkspaceImage = () => undefined }, ref) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const callbacks = useRef({ onChange, onSave, onCommand, onImages, onClipboardFiles, onWorkspaceImage })
  callbacks.current = { onChange, onSave, onCommand, onImages, onClipboardFiles, onWorkspaceImage }
  useImperativeHandle(ref, () => ({
    selection: () => view.current?.state.selection.main ?? { anchor: 0, head: 0 },
    composing: () => view.current?.composing ?? false,
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
      editor.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
      editor.focus()
    },
    undo: () => { if (view.current && !view.current.composing) undo(view.current) },
    redo: () => { if (view.current && !view.current.composing) redo(view.current) },
  }), [])

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initialText,
        extensions: [
          lineNumbers(), history(), drawSelection(), highlightActiveLine(), EditorView.lineWrapping,
          markdown(), syntaxHighlighting(defaultHighlightStyle),
          keymap.of([{ key: 'Mod-s', run: (v) => { if (!v.composing) callbacks.current.onSave(); return true } }, ...defaultKeymap, ...historyKeymap]),
          keymap.of([['Mod-b', 'bold'], ['Mod-i', 'italic'], ['Mod-k', 'link'], ['Mod-Shift-h', 'heading'], ['Mod-Shift-u', 'bullet'], ['Mod-Shift-o', 'ordered'], ['Mod-Shift-t', 'task'], ['Mod-Shift-q', 'quote'], ['Mod-Shift-c', 'code'], ['Mod-Shift-p', 'image']].map(([key, kind]) => ({ key, run: (v: EditorView) => { if (!v.composing) callbacks.current.onCommand(kind); return true } }))),
          EditorView.domEventHandlers({
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
          }),
        ],
      }),
    })
    view.current = editor
    return () => { editor.destroy(); view.current = null }
  }, [])
  return <div ref={host} className="codemirror-host" />
})
