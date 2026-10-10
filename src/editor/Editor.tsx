import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view'
import { history, historyKeymap, defaultKeymap, undo, redo, undoDepth, redoDepth, selectAll } from '@codemirror/commands'
import { isolateHistory } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { tags } from '@lezer/highlight'
import type { FencedBlock } from '../core/code-block'
import type { TextPatch, Selection } from '../core/document'
import { WORKSPACE_IMAGE_TYPE, workspaceImageData, type WorkspaceImage } from '../platform/workspace'
import { nativeClipboardFiles, supportedImageFiles } from '../platform/clipboard'
import { largeLines } from './large-lines'
import { formatState, toggleFormat, type Format, type FormatState } from '../core/formatting'
import { search, openSearchPanel, closeSearchPanel, findNext, findPrevious } from '@codemirror/search'
import { createSearchPanel } from './search-panel'
import { liveRendering, setLiveEnabled, setLiveBlocks } from './live-decoration'
import type { ParsedDocument } from '../core/markdown'
import { useContextMenu } from './ContextMenu'

export interface EditorHandle {
  selection(): Selection
  patch(patches: TextPatch[], selection?: Selection): boolean
  jump(offset: number): void
  undo(): void
  redo(): void
  composing(): boolean
  fencedCode(): FencedBlock | null
  format(kind: Format, language: string): void
  openSearch(): void
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

interface Props { initialText: string; live?: boolean; parsed?: ParsedDocument; previewText?: string; imageContext?: unknown; onRenderImage?(resource: string): Promise<string | null>; onEditImage?(offset: number): void; onChange(text: string): void; onSave(): void; onCommand?(kind: string): void; onImages?(files: File[]): void; onClipboardFiles?(): void; onWorkspaceImage?(image: WorkspaceImage): void; onScroll?(position: SourceScroll): void; onCodeLanguage?(language: string | null): void; onHighlightLimited?(limited: boolean): void; onFormats?(formats: FormatState): void; onSearchMatch?(offset: number): void }

export const Editor = forwardRef<EditorHandle, Props>(function Editor({ initialText, live = false, parsed, previewText, imageContext, onRenderImage = async () => null, onEditImage = () => undefined, onChange, onSave, onCommand = () => undefined, onImages = () => undefined, onClipboardFiles = () => undefined, onWorkspaceImage = () => undefined, onScroll, onCodeLanguage, onHighlightLimited, onFormats, onSearchMatch }, ref) {
  const contextMenu = useContextMenu()
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const composition = useRef(false)
  const isComposing = (editor: EditorView) => composition.current || editor.compositionStarted
  const callbacks = useRef({ onChange, onSave, onCommand, onImages, onClipboardFiles, onWorkspaceImage, onScroll, onCodeLanguage, onHighlightLimited, onFormats, onSearchMatch, onRenderImage, onEditImage })
  callbacks.current = { onChange, onSave, onCommand, onImages, onClipboardFiles, onWorkspaceImage, onScroll, onCodeLanguage, onHighlightLimited, onFormats, onSearchMatch, onRenderImage, onEditImage }
  useImperativeHandle(ref, () => ({
    selection: () => view.current?.state.selection.main ?? { anchor: 0, head: 0 },
    composing: () => view.current ? isComposing(view.current) : false,
    openSearch: () => { if (view.current && !isComposing(view.current)) openSearchPanel(view.current) },
    fencedCode: () => view.current ? fencedCode(view.current) : null,
    format: (kind, language) => {
      const editor = view.current
      if (!editor || isComposing(editor)) return
      const result = toggleFormat(0, editor.state.doc, editor.state.selection.main, syntaxTree(editor.state), kind, language)
      editor.dispatch({ changes: result.patches, selection: result.selection, userEvent: 'input.toolbar', annotations: isolateHistory.of('full') })
      editor.focus()
    },
    patch: (patches, selection) => {
      const editor = view.current
      if (!editor || isComposing(editor)) return false
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
    undo: () => { if (view.current && !isComposing(view.current)) undo(view.current) },
    redo: () => { if (view.current && !isComposing(view.current)) redo(view.current) },
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
    let previousFormats: FormatState | undefined
    const updateFormats = (state: EditorState) => {
      const formats = formatState(state.doc, state.selection.main, syntaxTree(state))
      if (!previousFormats || Object.keys(formats).some(key => formats[key as Format] !== previousFormats![key as Format])) {
        previousFormats = formats
        callbacks.current.onFormats?.(formats)
      }
    }
    const language = new Compartment()
    const support = markdown({ base: markdownLanguage, codeLanguages: languages })
    const limited = EditorState.create({ doc: initialText, extensions: [largeLines] }).field(largeLines) > 0
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initialText,
        extensions: [
          lineNumbers(), history(), drawSelection(), highlightActiveLine(), EditorView.lineWrapping,
          search({ top: true, literal: true, createPanel: createSearchPanel, scrollToMatch: range => EditorView.scrollIntoView(range, { y: 'start', yMargin: 8 }) }),
          largeLines, language.of(limited ? [] : support), syntaxHighlighting(tokenStyle),
          liveRendering({ image: resource => callbacks.current.onRenderImage(resource), editImage: offset => callbacks.current.onEditImage(offset) }),
          EditorState.transactionExtender.of((transaction) => {
            const before = transaction.startState.field(largeLines) > 0
            const after = transaction.state.field(largeLines) > 0
            return before === after ? null : { effects: language.reconfigure(after ? [] : support) }
          }),
          keymap.of([
            { key: 'Mod-f', run: (v) => isComposing(v) ? true : openSearchPanel(v) },
            { key: 'F3', run: (v) => isComposing(v) ? true : findNext(v), shift: (v) => isComposing(v) ? true : findPrevious(v) },
            { key: 'Mod-g', run: (v) => isComposing(v) ? true : findNext(v), shift: (v) => isComposing(v) ? true : findPrevious(v) },
            { key: 'Escape', run: closeSearchPanel },
            { key: 'Mod-s', run: (v) => { if (!isComposing(v)) callbacks.current.onSave(); return true } }, ...defaultKeymap, ...historyKeymap,
          ]),
          keymap.of([['Mod-b', 'bold'], ['Mod-i', 'italic'], ['Mod-k', 'link'], ['Mod-Shift-h', 'heading'], ['Mod-Shift-u', 'bullet'], ['Mod-Shift-o', 'ordered'], ['Mod-Shift-t', 'task'], ['Mod-Shift-q', 'quote'], ['Mod-Shift-c', 'code'], ['Mod-Shift-p', 'image']].map(([key, kind]) => ({ key, run: (v: EditorView) => { if (!isComposing(v)) callbacks.current.onCommand(kind); return true } }))),
          EditorView.domEventHandlers({
            compositionstart: () => { composition.current = true; return false },
            compositionend: () => { queueMicrotask(() => { composition.current = false }); return false },
            scroll: (_event, v) => {
              const scroll = v.scrollDOM
              const height = Math.max(0, scroll.getBoundingClientRect().top - v.documentTop)
              const line = v.lineBlockAtHeight(height)
              const range = scroll.scrollHeight - scroll.clientHeight
              callbacks.current.onScroll?.({ offset: line.from, fraction: Math.min(1, Math.max(0, (height - line.top) / line.height)), ratio: range > 0 ? scroll.scrollTop / range : 0 })
              return false
            },
            paste: (event, v) => {
              if (isComposing(v)) return false
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
              if (isComposing(v)) return false
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
            if (update.docChanged) callbacks.current.onHighlightLimited?.(update.state.field(largeLines) > 0)
            if (update.selectionSet || update.docChanged) callbacks.current.onCodeLanguage?.(fencedCode(update.view)?.language ?? null)
            if (update.selectionSet || update.docChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) updateFormats(update.state)
            if (update.transactions.some(transaction => transaction.isUserEvent('select.search') || transaction.isUserEvent('input.replace'))) callbacks.current.onSearchMatch?.(update.state.selection.main.from)
          }),
        ],
      }),
    })
    view.current = editor
    callbacks.current.onHighlightLimited?.(limited)
    callbacks.current.onCodeLanguage?.(fencedCode(editor)?.language ?? null)
    updateFormats(editor.state)
    return () => { editor.destroy(); view.current = null }
  }, [])
  useEffect(() => {
    view.current?.dispatch({ effects: setLiveEnabled.of(live) })
  }, [live])
  useEffect(() => {
    const editor = view.current
    // Never install ranges from a Worker response for an earlier text revision.
    if (!editor || !parsed?.blocks || previewText === undefined || editor.state.doc.length > 1024 * 1024 || editor.state.doc.toString() !== previewText) return
    editor.dispatch({ effects: setLiveBlocks.of({ doc: editor.state.doc, blocks: parsed.blocks, context: imageContext }) })
  }, [parsed, previewText, imageContext])
  return <div ref={host} className="codemirror-host" onContextMenu={event => {
    const editor = view.current
    if (!editor || !(event.target as HTMLElement).closest('.cm-content, .cm-scroller, .cm-gutters')) return
    if (isComposing(editor)) { event.preventDefault(); event.stopPropagation(); return }
    const position = editor.posAtCoords({ x: event.clientX, y: event.clientY })
    if (position !== null && !editor.state.selection.ranges.some(range => position >= range.from && position <= range.to)) editor.dispatch({ selection: { anchor: position } })
    const state = editor.state
    const selection = state.selection.main
    const selected = state.selection.ranges.map(range => state.doc.sliceString(range.from, range.to)).join('\n')
    const replace = (text: string) => {
      if (!view.current || view.current !== editor || editor.state.doc !== state.doc || !editor.state.selection.eq(state.selection) || editor.state.readOnly || host.current?.closest('[inert]') || isComposing(editor)) throw new Error('正文或选区已变化，请重新选择后操作。')
      editor.dispatch({ ...editor.state.replaceSelection(text), userEvent: 'input.paste', annotations: isolateHistory.of('full') })
      editor.focus()
    }
    const formats = formatState(state.doc, selection, syntaxTree(state))
    contextMenu(event, [
      { label: '撤销', disabled: undoDepth(state) === 0, run: () => { undo(editor); editor.focus() } },
      { label: '重做', disabled: redoDepth(state) === 0, run: () => { redo(editor); editor.focus() } },
      { label: '剪切', disabled: !selected, run: async () => { await navigator.clipboard.writeText(selected); replace('') } },
      { label: '复制', disabled: !selected, run: () => navigator.clipboard.writeText(selected) },
      { label: '粘贴文本', run: async () => replace(await navigator.clipboard.readText()) },
      { label: '全选', disabled: state.doc.length === 0, run: () => { selectAll(editor); editor.focus() } },
      { label: '加粗', checked: formats.bold === true, run: () => callbacks.current.onCommand('bold') },
      { label: '斜体', checked: formats.italic === true, run: () => callbacks.current.onCommand('italic') },
      { label: '插入图片', run: () => callbacks.current.onCommand('image') },
      { label: '查找 / 替换', run: () => { openSearchPanel(editor) } },
    ])
  }} />
})
