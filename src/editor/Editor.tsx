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
import type { TextPatch, Selection, EditCommandResult } from '../core/document'
import { applyPatches } from '../core/document'
import { commandDefinitions, validateCommandEdit, type CommandContext, type CommandStatus } from '../core/commands'
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
  format(kind: Format, language: string, context: CommandContext): boolean
  applyCommand(result: EditCommandResult, context: CommandContext): boolean
  historyState(): { undo: boolean; redo: boolean }
  focus(): void
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

interface Props { commandStatus?(id: string): CommandStatus; commandContext?(): CommandContext; blocked?: boolean; initialText: string; live?: boolean; parsed?: ParsedDocument; previewText?: string; imageContext?: unknown; onRenderImage?(resource: string): Promise<string | null>; onEditImage?(offset: number): void; onChange(text: string): void; onSave(): void; onCommand?(kind: string, argument?: unknown, expected?: CommandContext): void; onImages?(files: File[]): void; onClipboardFiles?(): void; onWorkspaceImage?(image: WorkspaceImage): void; onScroll?(position: SourceScroll): void; onCodeLanguage?(language: string | null): void; onHighlightLimited?(limited: boolean): void; onFormats?(formats: FormatState): void; onSearchMatch?(offset: number): void }

export const Editor = forwardRef<EditorHandle, Props>(function Editor({ commandStatus, commandContext, blocked = false, initialText, live = false, parsed, previewText, imageContext, onRenderImage = async () => null, onEditImage = () => undefined, onChange, onSave, onCommand = () => undefined, onImages = () => undefined, onClipboardFiles = () => undefined, onWorkspaceImage = () => undefined, onScroll, onCodeLanguage, onHighlightLimited, onFormats, onSearchMatch }, ref) {
  const contextMenu = useContextMenu()
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const composition = useRef(false)
  const isComposing = (editor: EditorView) => composition.current || editor.compositionStarted
  const callbacks = useRef({ commandStatus, commandContext, onChange, onSave, onCommand, onImages, onClipboardFiles, onWorkspaceImage, onScroll, onCodeLanguage, onHighlightLimited, onFormats, onSearchMatch, onRenderImage, onEditImage })
  callbacks.current = { commandStatus, commandContext, onChange, onSave, onCommand, onImages, onClipboardFiles, onWorkspaceImage, onScroll, onCodeLanguage, onHighlightLimited, onFormats, onSearchMatch, onRenderImage, onEditImage }
  const readOnly = useRef(new Compartment())
  const applyCommand = (result: EditCommandResult, context: CommandContext) => {
    const editor = view.current
    if (!editor || isComposing(editor)) return false
    const current = callbacks.current.commandContext?.()
    if (!current) return false
    try {
      if (!validateCommandEdit(editor.state.doc.toString(), result, context, current)) return true
      editor.dispatch({ changes: [...result.patches].sort((a, b) => a.from - b.from), selection: result.selection, userEvent: 'input.toolbar', annotations: isolateHistory.of('full') })
      editor.focus()
      return true
    } catch { return false }
  }
  useImperativeHandle(ref, () => ({
    selection: () => view.current?.state.selection.main ?? { anchor: 0, head: 0 },
    composing: () => view.current ? isComposing(view.current) : false,
    openSearch: () => { if (view.current && !isComposing(view.current)) openSearchPanel(view.current) },
    fencedCode: () => view.current ? fencedCode(view.current) : null,
    focus: () => view.current?.focus(),
    historyState: () => view.current ? { undo: undoDepth(view.current.state) > 0, redo: redoDepth(view.current.state) > 0 } : { undo: false, redo: false },
    applyCommand,
    format: (kind, language, context) => {
      const editor = view.current
      if (!editor || isComposing(editor)) return false
      return applyCommand(toggleFormat(context.textRevision, editor.state.doc, editor.state.selection.main, syntaxTree(editor.state), kind, language), context)
    },
    patch: (patches, selection) => {
      const editor = view.current
      if (!editor || isComposing(editor)) return false
      const next = applyPatches(editor.state.doc.toString(), patches)
      if (next === editor.state.doc.toString()) return true
      if (selection && [selection.anchor, selection.head].some(value => !Number.isInteger(value) || value < 0 || value > next.length)) return false
      editor.dispatch({ changes: [...patches].sort((a, b) => a.from - b.from), selection, userEvent: 'input.toolbar', annotations: isolateHistory.of('full') })
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
          readOnly.current.of(EditorState.readOnly.of(blocked)), lineNumbers(), history(), drawSelection(), highlightActiveLine(), EditorView.lineWrapping,
          search({ top: true, literal: true, createPanel: createSearchPanel, scrollToMatch: range => EditorView.scrollIntoView(range, { y: 'start', yMargin: 8 }) }),
          largeLines, language.of(limited ? [] : support), syntaxHighlighting(tokenStyle),
          liveRendering({ image: resource => callbacks.current.onRenderImage(resource), editImage: offset => callbacks.current.onEditImage(offset) }),
          EditorState.transactionExtender.of((transaction) => {
            const before = transaction.startState.field(largeLines) > 0
            const after = transaction.state.field(largeLines) > 0
            return before === after ? null : { effects: language.reconfigure(after ? [] : support) }
          }),
          keymap.of([
            { key: 'Mod-f', run: (v) => { if (!isComposing(v)) callbacks.current.onCommand('edit.search'); return true } },
            { key: 'F3', run: (v) => isComposing(v) ? true : findNext(v), shift: (v) => isComposing(v) ? true : findPrevious(v) },
            { key: 'Mod-g', run: (v) => isComposing(v) ? true : findNext(v), shift: (v) => isComposing(v) ? true : findPrevious(v) },
            { key: 'Escape', run: (v) => isComposing(v) ? false : closeSearchPanel(v) },
            { key: 'Mod-z', run: (v) => { if (!isComposing(v)) callbacks.current.onCommand('edit.undo'); return true }, shift: (v) => { if (!isComposing(v)) callbacks.current.onCommand('edit.redo'); return true } },
            { key: 'Mod-y', run: (v) => { if (!isComposing(v)) callbacks.current.onCommand('edit.redo'); return true } },
            { key: 'Mod-s', run: (v) => { if (!isComposing(v)) callbacks.current.onCommand('file.save'); return true } }, ...defaultKeymap, ...historyKeymap,
          ]),
          keymap.of(commandDefinitions.filter(command => command.shortcut && (command.id.startsWith('format.') || command.id === 'insert.image')).map(command => ({ key: command.shortcut!.replaceAll('+', '-').replace(/([A-Z])$/, letter => letter.toLowerCase()), run: (v: EditorView) => { if (!isComposing(v)) callbacks.current.onCommand(command.id); return true } }))),
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
  useEffect(() => { view.current?.dispatch({ effects: readOnly.current.reconfigure(EditorState.readOnly.of(blocked)) }) }, [blocked])
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
      if (!view.current || view.current !== editor || editor.state.doc !== state.doc || !editor.state.selection.eq(state.selection) || editor.state.readOnly || callbacks.current.commandContext?.().lockReason || !callbacks.current.commandContext?.().active || host.current?.closest('[inert]') || isComposing(editor)) throw new Error('正文或选区已变化，请重新选择后操作。')
      editor.dispatch({ ...editor.state.replaceSelection(text), userEvent: 'input.paste', annotations: isolateHistory.of('full') })
      editor.focus()
    }
    const context = callbacks.current.commandContext?.()
    const invoke = (id: string) => callbacks.current.onCommand(id, undefined, context)
    const formats = formatState(state.doc, selection, syntaxTree(state))
    const status = (id: string) => callbacks.current.commandStatus?.(id) ?? { enabled: !state.readOnly }
    contextMenu(event, [
      { label: '撤销', disabled: !status('edit.undo').enabled, run: () => invoke('edit.undo') },
      { label: '重做', disabled: !status('edit.redo').enabled, run: () => invoke('edit.redo') },
      { label: '剪切', disabled: !selected || !status('format.bold').enabled, run: async () => { await navigator.clipboard.writeText(selected); replace('') } },
      { label: '复制', disabled: !selected, run: () => navigator.clipboard.writeText(selected) },
      { label: '粘贴文本', disabled: !status('format.bold').enabled, run: async () => replace(await navigator.clipboard.readText()) },
      { label: '全选', disabled: state.doc.length === 0, run: () => { selectAll(editor); editor.focus() } },
      { label: '加粗', disabled: !status('format.bold').enabled, checked: status('format.bold').checked ?? formats.bold, run: () => invoke('format.bold') },
      { label: '斜体', disabled: !status('format.italic').enabled, checked: status('format.italic').checked ?? formats.italic, run: () => invoke('format.italic') },
      { label: '插入图片', disabled: !status('insert.image').enabled, run: () => invoke('insert.image') },
      { label: '查找 / 替换', disabled: !status('edit.search').enabled, run: () => invoke('edit.search') },
    ])
  }} />
})
