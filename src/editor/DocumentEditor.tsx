import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { emptyFormats, type Format } from '../core/formatting'
import { blankSnapshot, decodeFile, encodeFile, type FileSnapshot } from '../core/codec'
import type { NewDocument } from '../core/templates'
import { parseDocument } from '../core/markdown'
import { Editor, type EditorHandle, type SourceScroll } from './Editor'
import { codeBlockCommand } from '../core/code-block'
import { desktop, openDocument, saveDocument, readImage, readImageBlob, reloadDocument, materializeResources } from '../platform/storage'
import { createExport } from '../core/export'
import { parseForExport, saveHtml } from '../platform/export'
import { PrintDialog } from './PrintDialog'
import { DocxDialog, type DocxPhase } from './DocxDialog'
import { HistoryDialog } from './HistoryDialog'
import { BatchImageDialog } from './BatchImageDialog'
import { prepareBatch, type BatchOutput } from '../platform/batch-images'
import type { BatchOptions } from '../core/batch-images'
import { historyInput, historyOperation, relocateHistoryImages } from '../platform/history'
import type { ImageMetadata } from '../core/images'
import type { PreparedDocx } from '../core/docx-model'
import type { DocxOptions } from '../core/docx-options'
import type { ExportDocument } from '../core/export'
import { drafts, type Draft } from '../platform/drafts'
import { ImagePanel } from './ImagePanel'
import { useImages } from './useImages'
import { emptyResources } from '../platform/images'
import { usePreview } from './usePreview'
import { WorkspaceTree } from './WorkspaceTree'
import { openWorkspace, listWorkspace, openWorkspaceDocument, readWorkspaceImage, searchWorkspace, cancelWorkspaceSearch, type Workspace, type WorkspaceImage, type WorkspaceSearchReport, type WorkspaceLocation } from '../platform/workspace'
import type { OpenedFile } from '../platform/storage'
import { readClipboardImageFiles } from '../platform/clipboard'
import { ResizableSidebar } from './ResizableSidebar'
import { MAX_LIVE_DOCUMENT } from '../core/live-preview'
import { navigateButtons } from './navigation'
import { useContextMenu, type ContextAction } from './ContextMenu'
import { CommandRegistry, commandDefinitions, sameCommandTarget, type CommandContext, type CommandStatus } from '../core/commands'
import { applyPatches } from '../core/document'
import { sourceTable, tableCellAt, insertTable, changeTable, type Alignment, type TableOperation } from '../core/tables'
import { TablePanel, TableInsert, DraftDecision, type TableSession } from './TablePanel'
import { LinkDialog, LanguageDialog, ParagraphDialog } from './ContentTools'
import { linkAt, linkCommand, unlinkCommand, safeLink, headingAnchorOffset, type LinkTarget } from '../core/links'
import { codeAt, paragraphTarget, paragraphCommand, type ParagraphTarget } from '../core/content-tools'
import type { FencedBlock } from '../core/code-block'
import type { EditCommandResult } from '../core/document'
import { openExternalLink, relativeDocumentTarget } from '../platform/links'
import { insertStructure, validSlash, insertKinds, type InsertKind, type SlashTrigger } from '../core/quick-entry'
import { useExternalChanges } from './useExternalChanges'
import { ExternalChangeDialog } from './ExternalChangeDialog'

type ViewMode = 'source' | 'split' | 'live'
type Command = Format
const initialText = '# 欢迎使用 EasyM\n\n本地优先的 Markdown 编辑器。\n\n## 开始写作\n\n点击左上角 EM 菜单打开文件或创建新文档。使用「分屏」查看预览，点击「大纲」跳转到标题。\n\n- 使用工具栏或快捷键修改当前选区，可点击「格式工具栏」隐藏或显示按钮\n- 粘贴、拖入或选择 PNG/JPEG 图片\n- 双击预览图片，编辑当前图片的副本\n\n> 本地文件在停止输入后自动保存；新建文档自动保留草稿，首次请通过 EM 菜单另存为。'

function documentStatistics(text: string) {
    let lines = 1, characters = 0
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      if (code === 10) lines++
      if (code === 32 || (code >= 9 && code <= 13) || (code > 127 && /\s/.test(text[i]))) continue
      characters++
      if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) i++
    }
    return { lines, characters }
}

function errorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error)
  const labels: Record<string, string> = {
    revision_conflict: '文件已被外部修改。请重新打开外部版本，或将本地内容另存为冲突副本。',
    document_already_open: '目标文件已在另一个标签中打开，请切换到该标签，或选择其他另存位置。',
    permission_denied: '没有文件访问权限，请重新选择文件。',
    quota_exceeded: '文件超过当前资源限制，请缩小文件后重试。',
    resource_missing: '文件或资源已被移动，请重新选择。',
    invalid_data: '文件类型已变化或格式无效，本地编辑已保留。',
    io_failed: '写入失败，本地编辑和草稿仍保留，请重试或另存。',
    clipboard_busy: '剪贴板正在被其他程序使用，请稍后重新粘贴。',
    multiple_clipboard_images: '请每次复制并粘贴一张 PNG/JPEG 图片。',
  }
  return labels[value] ?? value
}

export interface DocumentSummary { name: string; dirty: boolean; busy: boolean; pendingImage: boolean; fileId: string | null; recentId?: string | null; tableDecision?: boolean }
export type FileAction = 'new' | 'open' | 'workspace' | 'saveAs' | 'reload' | 'exportHtml' | 'exportDocx' | 'print' | 'history' | 'batchImages'
export interface DocumentHandle { summary: DocumentSummary; prepareLeave?(): Promise<boolean>; canLeave(): boolean; canSwitch(): boolean; canEdit(): boolean; run(action: FileAction): void; commandContext(): CommandContext; commandStatus(id: string, expected?: CommandContext): CommandStatus; execute(id: string, argument?: unknown, expected?: CommandContext): void; retain(): Promise<void>; discard(): Promise<void>; resume(): void; save(): Promise<boolean> }
interface Props {
  quickEntryOpen?: boolean; reading: boolean; readingBusy: boolean; onReading(next: boolean): void
  id: string; active: boolean; suspended: boolean; draftKey: string; file?: OpenedFile; blank?: boolean; seed?: NewDocument; path?: string | null; location?: WorkspaceLocation
  workspace: Workspace | null; onWorkspaceChange(workspace: Workspace): void
  showFiles: boolean; onShowFiles(show: boolean): void; showToolbar: boolean; onShowToolbar(show: boolean): void; showSelectionTools?: boolean
  onNew(): void; onOpen(file: OpenedFile, path: string | null, workspace: Workspace | null, location?: WorkspaceLocation): void
  onReleaseUnused(file: OpenedFile): Promise<void>
  onReport(id: string, summary: DocumentSummary, handle: DocumentHandle): void
  onReadOther?: () => void
}
export default function DocumentEditor({ quickEntryOpen = false, reading, readingBusy, onReading, id, active, suspended, draftKey, file, blank, seed, path, location, workspace, onWorkspaceChange, showFiles, onShowFiles, showToolbar, onShowToolbar, showSelectionTools = true, onNew, onOpen, onReleaseUnused, onReport, onReadOther }: Props) {
  const contextMenu = useContextMenu()
  const [initial] = useState(() => file ? decodeFile(file.bytes) : blankSnapshot())
  const [text, setText] = useState(file ? initial.text : seed?.text ?? (blank ? '' : initialText))
  const [view, setView] = useState<ViewMode>('source')
  const [name, setName] = useState(file?.name ?? seed?.name ?? '未命名.md')
  const [fileId, setFileId] = useState<string | null>(file?.id ?? null)
  const [recentId, setRecentId] = useState<string | null>(file?.recentId ?? null)
  const [revision, setRevision] = useState<string | null>(file?.revision ?? null)
  const [snapshot, setSnapshot] = useState<FileSnapshot>(initial)
  const [epoch, setEpoch] = useState(0)
  const [dirty, setDirty] = useState(!file && !!seed?.text)
  const [busy, setBusy] = useState(false)
  const [externalOpen, setExternalOpen] = useState(false)
  const [printable, setPrintable] = useState<ExportDocument | null>(null)
  const exporting = useRef(false)
  const docxTask = useRef<AbortController | null>(null)
  const docxPhase = useRef<DocxPhase>('preflight')
  const activeRef = useRef(active)
  activeRef.current = active
  const [docx, setDocx] = useState<{ prepared: PreparedDocx | null; source: string; phase: DocxPhase } | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [batchOpen, setBatchOpen] = useState(false)
  const [autoSaving, setAutoSaving] = useState(false)
  const [autoSavePaused, setAutoSavePaused] = useState(false)
  const [status, setStatus] = useState(file ? '文件已打开' : seed?.text ? '已从模板创建，请另存为' : '准备就绪')
  const [draftStatus, setDraftStatus] = useState('')
  const [error, setError] = useState('')
  const [pendingDraft, setPendingDraft] = useState<Draft | null>(null)
  const [draftReady, setDraftReady] = useState(false)
  const [draftUnavailable, setDraftUnavailable] = useState(false)
  const [showOutline, setShowOutline] = useState(false)
  const [codeLanguage, setCodeLanguage] = useState('')
  const [formats, setFormats] = useState(emptyFormats)
  const [highlightLimited, setHighlightLimited] = useState(false)
  const [workspacePath, setWorkspacePath] = useState<string | null>(path ?? null)
  const [treeRevision, setTreeRevision] = useState(0)
  const [workspaceQuery, setWorkspaceQuery] = useState('')
  const [workspaceReport, setWorkspaceReport] = useState<WorkspaceSearchReport | null>(null)
  const [workspaceSearching, setWorkspaceSearching] = useState(false)
  const workspaceSearchRequest = useRef<string | null>(null)
  const navigatedLocation = useRef<string | null>(null)
  const editor = useRef<EditorHandle>(null)
  const [tableSession, setTableSession] = useState<(TableSession & { context: CommandContext }) | null>(null)
  const tableRef = useRef(tableSession); tableRef.current = tableSession
  const textRef = useRef(text); textRef.current = text
  const [tableError, setTableError] = useState('')
  const [tableInsert, setTableInsert] = useState<(CommandContext & { slash?: SlashTrigger }) | null>(null)
  const tableCommandOffset = useRef<number | null>(null)
  const imageInsert = useRef<{ context: CommandContext; slash: SlashTrigger } | null>(null)
  const [contentTool, setContentTool] = useState<{ kind: 'link' | 'language' | 'paragraph'; context: CommandContext; link?: LinkTarget | null; code?: FencedBlock; paragraph?: ParagraphTarget } | null>(null)
  const contentToolRef = useRef(contentTool); contentToolRef.current = contentTool
  const [contentError, setContentError] = useState('')
  const contentComposing = useRef(false)
  const [tableDecision, setTableDecision] = useState(false)
  const decisionResolve = useRef<((proceed: boolean) => void) | null>(null)
  const cellComposing = useRef(false)
  function updateTable(next: typeof tableSession) { tableRef.current = next; setTableSession(next) }
  function tableDraft(value: string) { const current = tableRef.current; if (current) updateTable({ ...current, draft: value }) }
  function openTable(offset: number, context: CommandContext) {
    try {
      const table = sourceTable(textRef.current, offset), cell = tableCellAt(table, offset)
      setTableError(''); updateTable({ table, ...cell, draft: table.rows[cell.row][cell.column].value, context, version: context.textRevision })
    } catch (err) { setError(errorMessage(err)) }
  }
  function commitTable(mode: 'end' | 'next' | 'previous' | 'stay', operation?: TableOperation, alignment?: Alignment, destination?: { row: number; column: number }): boolean {
    const session = tableRef.current
    if (!session || cellComposing.current) return false
    try {
      const status = registry.status('table.edit', session.context)
      if (!status.enabled) throw new Error(status.reason)
      const { table, row, column } = session
      const index = row * table.align.length + column
      const addLastRow = mode === 'next' && index === table.rows.length * table.align.length - 1
      const patches = changeTable(table, row, column, session.draft, operation, alignment, addLastRow)
      const nextText = applyPatches(textRef.current, patches)
      const nextTable = sourceTable(nextText, table.from)
      let nextRow = Math.min(row, nextTable.rows.length - 1), nextColumn = Math.min(column, nextTable.align.length - 1)
      if (mode === 'next' || mode === 'previous') {
        const nextIndex = index + (mode === 'next' ? 1 : -1)
        nextRow = Math.max(0, Math.floor(nextIndex / nextTable.align.length)); nextColumn = Math.max(0, nextIndex % nextTable.align.length)
      }
      if (destination) { nextRow = destination.row; nextColumn = destination.column }
      const position = mode === 'previous' && index === 0 ? Math.max(0, table.from - 1) : nextTable.rows[nextRow][nextColumn].from
      if (!editor.current?.applyCommand({ baseTextRevision: session.context.textRevision, patches, selection: { anchor: position, head: position } }, session.context)) throw new Error('正文或选区已变化，未应用输入。请复制草稿后重新打开表格。')
      // A no-op command deliberately leaves the undo stack untouched; update
      // the caret separately so Tab still moves between empty cells.
      editor.current.jump(position)
      setTableError('')
      if (mode === 'end' || (mode === 'previous' && index === 0)) { updateTable(null); requestAnimationFrame(() => { if (activeRef.current && !tableRef.current) editor.current?.focus() }) }
      else updateTable({ table: nextTable, row: nextRow, column: nextColumn, draft: nextTable.rows[nextRow][nextColumn].value, context: registry.capture(), version: changeRevision.current })
      return true
    } catch (err) { setTableError(errorMessage(err)); return false }
  }
  async function prepareLeave(): Promise<boolean> {
    const session = tableRef.current
    if (!session) return !contentToolRef.current && !tableInsert && !cellComposing.current
    if (cellComposing.current) return false
    if (session.draft === session.table.rows[session.row][session.column].value) { updateTable(null); requestAnimationFrame(() => { if (activeRef.current && !tableRef.current) editor.current?.focus() }); return true }
    if (decisionResolve.current) return false
    setTableDecision(true)
    return new Promise(resolve => { decisionResolve.current = resolve })
  }
  function decideTable(choice: 'apply' | 'discard' | 'cancel') {
    if (choice === 'apply' && !commitTable('end')) return
    if (choice === 'discard') updateTable(null)
    setTableDecision(false)
    const resolve = decisionResolve.current; decisionResolve.current = null
    requestAnimationFrame(() => resolve?.(choice !== 'cancel'))
  }
  useEffect(() => () => { decisionResolve.current?.(false) }, [])
  const preview = useRef<HTMLElement>(null)
  const sourceScroll = useRef<SourceScroll>({ offset: 0, fraction: 0, ratio: 0 })
  const scrollAnchors = useRef<{ from: number; top: number }[] | null>(null)
  const scrollFrame = useRef<number | null>(null)
  const applyScroll = useRef<() => void>(() => undefined)
  const scrollOwner = useRef<'source' | 'preview'>('source')
  const expectedPreview = useRef<number | null>(null)
  const changeRevision = useRef(0)
  const persistedTextRevision = useRef<number | null>(null)
  const saving = useRef(false)
  const panelApplying = useRef(false)
  const draftQueue = useRef(Promise.resolve<unknown>(undefined))
  const draftTimer = useRef<number | undefined>(undefined)
  const draftGeneration = useRef(0)
  const discarded = useRef(false)
  const flushDraft = useRef<() => void>(() => undefined)
  const { parsed, parsedText } = usePreview(text, setError)
  const [statistics, setStatistics] = useState(() => documentStatistics(text))
  useEffect(() => {
    // Keep whole-document statistics out of the typing frame for large files.
    const timer = window.setTimeout(() => setStatistics(documentStatistics(text)), 250)
    return () => window.clearTimeout(timer)
  }, [text])
  const imagePicker = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const picker = imagePicker.current
    const cancel = () => { imageInsert.current = null; editor.current?.focus() }
    picker?.addEventListener('cancel', cancel)
    return () => picker?.removeEventListener('cancel', cancel)
  }, [])
  function syncPreview(position = sourceScroll.current, remeasure = false) {
    if (reading) return
    sourceScroll.current = position
    if (remeasure) scrollAnchors.current = null
    if (!active || reading || scrollOwner.current === 'preview') return
    if (scrollFrame.current === null) scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null
      applyScroll.current()
    })
  }
  applyScroll.current = () => {
    const position = sourceScroll.current
    const pane = preview.current
    if (!active || reading || scrollOwner.current !== 'source' || !pane || view !== 'split' || parsedText.current !== text) return
    const max = Math.max(0, pane.scrollHeight - pane.clientHeight)
    if (position.ratio >= .999) { expectedPreview.current = max; pane.scrollTop = max; return }
    if (position.ratio <= .001) { expectedPreview.current = 0; pane.scrollTop = 0; return }
    const top = pane.getBoundingClientRect().top
    const anchors = scrollAnchors.current ?? Array.from(pane.children, (element) => {
      // Endnotes move definitions out of source order. Their exact forward /
      // back navigation is handled separately from linear scroll interpolation.
      if (element.matches('.footnotes')) return null
      const node = element.hasAttribute('data-source-from') ? element as HTMLElement : element.querySelector<HTMLElement>('[data-source-from]')
      return node ? { from: Number(node.dataset.sourceFrom), top: element.getBoundingClientRect().top - top + pane.scrollTop } : null
    }).filter((item): item is { from: number; top: number } => item !== null)
    scrollAnchors.current = anchors
    const lineEnd = text.indexOf('\n', position.offset)
    const offset = position.offset + position.fraction * ((lineEnd < 0 ? text.length : lineEnd) - position.offset + 1)
    let previous = { from: 0, top: 0 }
    let next = { from: text.length, top: pane.scrollHeight }
    let low = 0, high = anchors.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (anchors[middle].from <= offset) low = middle + 1
      else high = middle
    }
    if (low > 0) previous = anchors[low - 1]
    if (low < anchors.length) next = anchors[low]
    const fraction = next.from > previous.from ? (offset - previous.from) / (next.from - previous.from) : 0
    expectedPreview.current = Math.max(0, Math.min(max, previous.top + fraction * (next.top - previous.top)))
    pane.scrollTop = expectedPreview.current
  }
  function syncSource() {
    const pane = preview.current
    if (!active || reading || !pane || parsedText.current !== text) return
    if (expectedPreview.current !== null && Math.abs(pane.scrollTop - expectedPreview.current) < 2) return
    scrollOwner.current = 'preview'
    const max = pane.scrollHeight - pane.clientHeight
    const ratio = max > 0 ? pane.scrollTop / max : 0
    const top = pane.getBoundingClientRect().top
    const anchors = scrollAnchors.current ?? Array.from(pane.children, (element) => {
      if (element.matches('.footnotes')) return null
      const node = element.hasAttribute('data-source-from') ? element as HTMLElement : element.querySelector<HTMLElement>('[data-source-from]')
      return node ? { from: Number(node.dataset.sourceFrom), top: element.getBoundingClientRect().top - top + pane.scrollTop } : null
    }).filter((item): item is { from: number; top: number } => item !== null)
    scrollAnchors.current = anchors
    let previous = { from: 0, top: 0 }, next = { from: text.length, top: pane.scrollHeight }
    for (const anchor of anchors) { if (anchor.top <= pane.scrollTop) previous = anchor; else { next = anchor; break } }
    const fraction = next.top > previous.top ? (pane.scrollTop - previous.top) / (next.top - previous.top) : 0
    editor.current?.scrollToSource(previous.from + fraction * (next.from - previous.from), ratio)
  }
  function jumpTo(offset: number) {
    if (tableRef.current) { void prepareLeave().then(proceed => { if (proceed) jumpTo(offset) }); return }
    if (reading) {
      const nodes = Array.from(preview.current?.querySelectorAll<HTMLElement>('[data-source-from]') ?? [])
      const node = nodes.find(element => Number(element.dataset.sourceFrom) === offset)
        ?? nodes.filter(element => Number(element.dataset.sourceFrom) <= offset).sort((a, b) => Number(b.dataset.sourceFrom) - Number(a.dataset.sourceFrom))[0] ?? nodes[0]
      node?.scrollIntoView({ block: 'start' })
      return
    }
    scrollOwner.current = 'source'
    expectedPreview.current = null
    editor.current?.jump(offset)
    // Also sync when the heading is already visible and CodeMirror does not scroll.
    syncPreview({ offset, fraction: 0, ratio: text.length ? offset / text.length : 0 }, true)
  }
  function searchMatch(offset: number) {
    scrollOwner.current = 'source'
    expectedPreview.current = null
    syncPreview({ offset, fraction: 0, ratio: text.length ? offset / text.length : 0 }, true)
  }
  useEffect(() => {
    syncPreview(sourceScroll.current, true)
    const resize = () => syncPreview(sourceScroll.current, true)
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null
    if (preview.current) observer?.observe(preview.current)
    window.addEventListener('resize', resize)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', resize)
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current)
      scrollFrame.current = null
    }
  }, [active, view, parsed.html, showFiles, showOutline, showToolbar, reading])
  useEffect(() => {
    if (reading || view !== 'split' || !preview.current) return
    const inserted: HTMLElement[] = []
    for (const table of preview.current.querySelectorAll<HTMLTableElement>('table[data-source-from]')) {
      const actions = document.createElement('div'); actions.className = 'preview-table-actions'
      for (const [label, action] of [['编辑表格', 'edit'], ['源码', 'source']] as const) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.dataset.tableAction = action; button.dataset.tableOffset = table.dataset.sourceFrom ?? '0'; actions.append(button)
      }
      table.parentElement?.insertBefore(actions, table); inserted.push(actions)
    }
    for (const code of preview.current.querySelectorAll<HTMLElement>('pre > code[data-source-from]')) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'preview-language-button'
      const current = code.className.match(/language-([^ ]+)/)?.[1] ?? ''
      button.textContent = `语言：${current || '无语言'}`; button.dataset.languageOffset = code.dataset.sourceFrom; code.parentElement?.before(button); inserted.push(button)
    }
    return () => inserted.forEach(node => node.remove())
  }, [parsed.html, view, reading, active])
  function openedResources(body: string, instances = images.resources.instances) {
    const paths = new Set(parseDocument(body).images.map((item) => item.url))
    return { assets: {}, instances: instances.filter((item) => paths.has(item.displayPath)) }
  }
  const external = useExternalChanges(fileId, revision, active && draftReady && !pendingDraft && !suspended && !busy && !autoSaving && !externalOpen)
  const images = useImages({
    text, fileId, blocked: externalOpen || external.checking || !!external.change || reading || busy || !!printable || autoSaving || !!pendingDraft || !draftReady || !!editor.current?.composing(),
    selection: () => editor.current?.selection() ?? { anchor: text.length, head: text.length },
    patch: (from, to, insert) => editor.current?.patch([{ from, to, insert }]) ?? false,
    error: setError,
    persist: async (nextText, resources, operationId) => {
      if (!desktop || !fileId) return
      if (external.blocked.current) throw new Error('磁盘版本待检查或已变化；图片草稿已保留，请先处理外部版本。')
      const mixed = snapshot.lineEnding === 'mixed' && nextText !== snapshot.originalText
      if (mixed && !window.confirm('图片应用将保存正文，并将混合换行统一为 LF。是否继续？')) throw new Error('应用已取消，原版本仍保留。')
      const bytes = encodeFile(snapshot, nextText, mixed ? 'lf' : undefined)
      const result = await saveDocument({ id: fileId, name, revision, originalText: snapshot.originalText }, bytes, false, resources, operationId)
      if (!result) throw new Error('保存已取消，原版本仍保留。')
      await clearDraft().catch((err) => setError(errorMessage(err)))
      setRevision(result.revision); setSnapshot(decodeFile(bytes)); if (result.warning) setError(errorMessage(result.warning))
    },
    applied: () => { setView(current => current === 'live' ? 'live' : 'split'); if (desktop && fileId) setDirty(false); setStatus(desktop && fileId ? '图片副本与正文已保存' : '图片已应用，请下载工作区副本') },
  })
  const liveImageContext = useMemo(() => ({ resources: images.resources, fileId }), [images.resources, fileId])
  const disabled = externalOpen || !!tableInsert || busy || !!printable || draftUnavailable || !!pendingDraft || !draftReady || images.busy || !!images.session
  const commandRuntime = useRef<{ context(): CommandContext; status(id: string): CommandStatus; run(id: string, context: CommandContext, argument?: unknown): void | boolean | Promise<void | boolean> }>(null!)
  const registry = useMemo(() => {
    const commands = new CommandRegistry(() => commandRuntime.current.context())
    for (const definition of commandDefinitions.filter(item => !item.id.startsWith('app.'))) commands.register({ ...definition,
      status: () => commandRuntime.current.status(definition.id), run: (context, argument) => commandRuntime.current.run(definition.id, context, argument) })
    return commands
  }, [])
  commandRuntime.current = {
    context: () => ({ documentId: id, fileId, textRevision: changeRevision.current, selection: editor.current?.selection() ?? { anchor: 0, head: 0 }, active: activeRef.current,
      reading, editorMode: view, composing: contentComposing.current || cellComposing.current || !!editor.current?.composing(), lockReason: contentToolRef.current ? '请先确认或取消就地内容工具。' : suspended ? '请先关闭当前对话框。' : disabled || autoSaving || saving.current || exporting.current || images.applying || panelApplying.current ? '正在处理或恢复文档，请完成后操作。' : undefined }),
    status: commandId => {
      if (commandId === 'table.edit') return editor.current?.contentStatus('table', tableCommandOffset.current ?? tableRef.current?.table.from) ?? { enabled: false }

      if (commandId.startsWith('format.')) return editor.current?.formatStatus?.(commandId.slice(7) as Format) ?? { enabled: true, checked: formats[commandId.slice(7) as Format] }
      if (commandId === 'paragraph.convert') return editor.current?.contentStatus('paragraph') ?? { enabled: false }
      if (commandId === 'content.language') return { enabled: !!editor.current?.fencedCode(), reason: '请将光标放在围栏代码块中。' }
      if (commandId === 'edit.undo' || commandId === 'edit.redo') return { enabled: editor.current?.historyState?.()[commandId.slice(5) as 'undo' | 'redo'] ?? true, reason: '没有可撤销或重做的修改。' }
      if (commandId === 'file.reload' && (!desktop || !fileId)) return { enabled: false, reason: '请先打开桌面本地文件。' }
      if (commandId === 'file.save' && (external.checking || external.change)) return { enabled: false, reason: '磁盘版本待检查或已变化，请比较或另存本地副本。' }
      if (commandId === 'view.reading' && readingBusy) return { enabled: false, reason: '正在切换窗口模式。' }
      if (commandId.startsWith('view.')) return { enabled: true, checked: commandId === 'view.reading' ? reading : commandId === 'view.files' ? showFiles : commandId === 'view.outline' ? showOutline : commandId === 'view.toolbar' ? showToolbar : commandId === `view.${view}` }
      return { enabled: true }
    },
    run: (commandId, context, argument) => {
      const trigger = argument && typeof argument === 'object' && 'slash' in argument ? (argument as { slash: SlashTrigger }).slash : undefined
      if (trigger && !validSlash(textRef.current, context.selection, trigger)) throw new Error('快捷插入位置已变化，请重新输入 /。')
      const kind = commandId.slice(7) as InsertKind
      if (commandId.startsWith('insert.') && insertKinds.some(([value]) => value === kind)) return editor.current?.applyCommand(insertStructure(context.textRevision, textRef.current, context.selection, kind, trigger), context) ?? false
      if (commandId === 'format.link') { openContentTool('link', context); return }
      if (commandId === 'paragraph.convert') { openContentTool('paragraph', context); return }
      if (commandId === 'content.language') { openContentTool('language', context); return }
      if (commandId.startsWith('format.')) return editor.current?.format(commandId.slice(7) as Format, codeLanguage, context) ?? false
      if (commandId === 'code.language') return applyCodeLanguage(String(argument), context)
      if (commandId === 'insert.table') { setError(''); setTableInsert({ ...context, slash: trigger }); return }
      if (commandId === 'table.edit') { openTable(typeof argument === 'number' ? argument : context.selection.head, context); return }
      if (commandId === 'insert.image') { imageInsert.current = trigger ? { context, slash: trigger } : null; imagePicker.current?.click(); return }
      if (commandId === 'edit.undo') { editor.current?.undo(); return }
      if (commandId === 'edit.redo') { editor.current?.redo(); return }
      if (commandId === 'edit.search') { editor.current?.openSearch(); return }
      if (commandId === 'view.reading') { onReading(!reading); return }
      if (commandId === 'view.files') { onShowFiles(!showFiles); return }
      if (commandId === 'view.outline') { setShowOutline(!showOutline); return }
      if (commandId === 'view.toolbar') { onShowToolbar(!showToolbar); return }
      if (commandId.startsWith('view.')) { setView(commandId.slice(5) as ViewMode); return }
      const action = commandId.slice(5)
      if (action === 'new') onNew()
      else if (action === 'open') return open()
      else if (action === 'workspace') return chooseWorkspace()
      else if (action === 'reload') return reloadExternal()
      else if (action === 'exportDocx') return exportDocxDocument()
      else if (action === 'history') { setHistoryOpen(true); setBusy(true) }
      else if (action === 'batchImages') { setBatchOpen(true); setBusy(true) }
      else if (action === 'exportHtml' || action === 'print') return exportDocument(action)
      else if (action === 'save' || action === 'saveAs') return save(action === 'saveAs')
    },
  }
  function execute(commandId: string, argument?: unknown, expected?: CommandContext) {
    if (tableRef.current) { void prepareLeave().then(proceed => { if (proceed) execute(commandId, argument) }); return }
    tableCommandOffset.current = commandId === 'table.edit' && typeof argument === 'number' ? argument : null
    const result = registry.execute(commandId, argument, expected)
    tableCommandOffset.current = null
    void result.then(status => { if (!status.enabled && activeRef.current) setError(status.reason ?? '操作暂不可用。') }).catch(err => setError(errorMessage(err)))
  }
  const summary = { name: pendingDraft?.name ?? name, dirty: dirty || !!pendingDraft || draftUnavailable, fileId, recentId, busy: externalOpen || busy || !!printable || autoSaving || images.busy || images.applying || !draftReady, pendingImage: !!images.session, tableDecision }
  useEffect(() => {
    onReport(id, summary, { summary, prepareLeave, canLeave: () => !externalOpen && !contentToolRef.current && !saving.current && !busy && !printable && !exporting.current && !images.busy && !images.applying && !panelApplying.current && draftReady && !editor.current?.composing(),
      canSwitch: () => (!!docxTask.current && ['preflight', 'generating'].includes(docxPhase.current)) || (!externalOpen && !contentToolRef.current && !saving.current && !busy && !autoSaving && !printable && !exporting.current && !images.busy && !images.session && !images.applying && !panelApplying.current && draftReady && !editor.current?.composing()),
      canEdit: () => registry.status('file.open').enabled,
      commandContext: () => registry.capture(), commandStatus: (commandId, expected) => registry.status(commandId, expected), execute,
      run: action => execute('file.' + action),
      retain: async () => { if (!pendingDraft && !draftUnavailable && (dirty || images.session)) { window.clearTimeout(draftTimer.current); await enqueueDraft() } },
      discard: async () => { discarded.current = true; await clearDraft() },
      resume: () => { discarded.current = false; flushDraft.current() }, save: () => save(),
    })
  })
  useEffect(() => () => { docxTask.current?.abort(); docxTask.current = null }, [])
  function closeHistory() {
    setHistoryOpen(false); setBusy(false)
    window.setTimeout(() => document.querySelector<HTMLButtonElement>('.app-menu-trigger')?.focus(), 0)
  }
  function closeBatch() {
    setBatchOpen(false); setBusy(false)
    window.setTimeout(() => document.querySelector<HTMLButtonElement>('.app-menu-trigger')?.focus(), 0)
  }
  async function applyBatch(outputs: BatchOutput[], options: BatchOptions, operationId: string) {
    if (!fileId || !revision || saving.current || editor.current?.composing()) throw new Error('当前文档暂不可提交。')
    if (snapshot.lineEnding === 'mixed') throw new Error('请先确认并保存混合换行，再进行批量处理。')
    saving.current = true
    try {
      const prepared = await prepareBatch(text, images.resources, outputs)
      const bytes = encodeFile(snapshot, prepared.text)
      const result = await historyOperation<{ revision: string; warning?: string }>(fileId, { action: 'batchCommit', operationId, expectedRevision: revision,
        current: await historyInput(encodeFile(snapshot, text), images.resources, revision), next: await historyInput(bytes, prepared.resources, revision), options,
        items: outputs.map(output => ({ from: output.reference.from, to: output.reference.to, insert: prepared.patches.find(p => p.from === output.reference.from)!.insert, beforePath: output.reference.path,
          sourcePath: output.instance.sourcePath, displayPath: output.instance.displayPath, beforeHash: output.beforeHash, afterHash: output.afterHash, instanceId: output.instance.instanceId, previous: output.previous ?? null })) })
      images.setResources(prepared.resources)
      if (!editor.current?.patch([...prepared.patches].sort((a, b) => a.from - b.from))) {
        setRevision(result.revision); setAutoSavePaused(true)
        throw new Error('磁盘批次已保存，编辑器未完成应用；已保留当前编辑，请重新加载外部版本或另存副本。')
      }
      setRevision(result.revision); setSnapshot(decodeFile(bytes)); setDirty(false); setAutoSavePaused(false)
      persistedTextRevision.current = changeRevision.current
      try { await clearDraft(changeRevision.current) } catch (e) { setError(errorMessage(e)) }
      if (result.warning) setError(result.warning)
      setStatus('批量图片与正文已保存，可整批撤销'); setView(current => current === 'live' ? 'live' : 'split')
    } finally { saving.current = false }
  }
  function historyBytes(): Uint8Array | null {
    try { return encodeFile(snapshot, text) } catch { return null }
  }
  async function restoreHistory(snapshotId: string) {
    if (!fileId || !revision || saving.current || editor.current?.composing()) throw new Error('当前文档不可恢复，请稍后重试。')
    if (snapshot.lineEnding === 'mixed') throw new Error('history_mixed')
    saving.current = true
    try {
      const currentBytes = encodeFile(snapshot, text)
      const detail = await historyOperation<{ bytes: number[] }>(fileId, { action: 'detail', snapshotId })
      const plan = await historyOperation<{ relocations: Record<string, string>; metadata: ImageMetadata }>(fileId, { action: 'prepare', snapshotId })
      const nextText = relocateHistoryImages(decodeFile(new Uint8Array(detail.bytes)).text, plan.relocations)
      const bytes = encodeFile(snapshot, nextText)
      const result = await historyOperation<{ revision: string; metadata: ImageMetadata; warning?: string }>(fileId, { action: 'restore', snapshotId, bytes: Array.from(bytes), relocations: plan.relocations,
        current: await historyInput(currentBytes, images.resources, revision), expectedRevision: revision, operationId: crypto.randomUUID(), encoding: snapshot.encoding, lineEnding: snapshot.lineEnding })
      // One editor transaction keeps undo/redo. Earlier resources remain available for both directions.
      if (!editor.current?.patch([{ from: 0, to: text.length, insert: nextText }], { anchor: 0, head: 0 })) {
        setRevision(result.revision); setAutoSavePaused(true)
        throw new Error('磁盘正文已恢复，编辑器应用未完成；已保留当前编辑与草稿，请重新加载外部版本或另存当前编辑。')
      }
      const instances = [...images.resources.instances.filter(i => !result.metadata.instances.some(next => next.displayPath === i.displayPath)), ...result.metadata.instances]
      images.setResources({ assets: images.resources.assets, instances })
      setRevision(result.revision); setSnapshot(decodeFile(bytes)); setAutoSavePaused(false); setDirty(false)
      persistedTextRevision.current = changeRevision.current
      try { await clearDraft(changeRevision.current) } catch (e) { setError(errorMessage(e)) }
      if (result.warning) setError(result.warning)
      setStatus('版本已恢复并保存，可一次撤销'); closeHistory()
    } finally { saving.current = false }
  }
  function finishDocx(controller: AbortController, message: string, offset?: number) {
    if (docxTask.current !== controller) return
    controller.abort(); docxTask.current = null; exporting.current = false
    setDocx(null); setBusy(false); setStatus(message)
    requestAnimationFrame(() => {
      if (!activeRef.current) return
      if (offset !== undefined) jumpTo(offset)
      else document.querySelector<HTMLButtonElement>('.app-menu-trigger')?.focus()
    })
  }
  function cancelDocx(offset?: number) {
    const controller = docxTask.current
    if (controller && docxPhase.current !== 'saving') finishDocx(controller, 'DOCX 导出已取消', offset)
  }
  async function exportDocxDocument() {
    if (!active || suspended || disabled || exporting.current || saving.current || autoSaving || images.applying || panelApplying.current || editor.current?.composing()) return
    const controller = new AbortController()
    docxTask.current = controller; exporting.current = true
    docxPhase.current = 'preflight'
    setBusy(true); setError(''); setStatus('正在预检 DOCX…')
    setDocx({ prepared: null, source: text, phase: 'preflight' })
    try {
      // Load the large inline export Worker only when this command is used.
      const { preflightDocx } = await import('../platform/docx')
      if (docxTask.current !== controller) return
      const prepared = await preflightDocx({ text, name, id: fileId, resources: images.resources }, controller.signal)
      if (docxTask.current === controller) { docxPhase.current = 'ready'; setDocx({ prepared, source: text, phase: 'ready' }); setStatus('DOCX 预检完成') }
    } catch (err) {
      if (docxTask.current === controller) { setError(errorMessage(err)); finishDocx(controller, 'DOCX 导出未完成，请重试') }
    }
  }
  async function generateDocx(options: DocxOptions) {
    const controller = docxTask.current
    if (!controller || !docx?.prepared || docxPhase.current !== 'ready') return
    // Set the phase synchronously in the task guard to prevent double submit.
    const prepared = docx.prepared
    docxPhase.current = 'generating'
    setDocx({ ...docx, phase: 'generating' })
    try {
      const { renderDocx, saveDocx } = await import('../platform/docx')
      if (docxTask.current !== controller) return
      const bytes = await renderDocx(prepared, options, controller.signal)
      if (docxTask.current !== controller) return
      docxPhase.current = 'saving'; setDocx({ ...docx, phase: 'saving' })
      const saved = await saveDocx(prepared.model.name, bytes, controller.signal)
      const warnings = Math.max(0, prepared.model.warnings.total - 1)
      finishDocx(controller, saved ? `DOCX 已导出${warnings ? `，有 ${warnings} 项降级提示` : ''}` : 'DOCX 导出已取消')
    } catch (err) {
      if (docxTask.current === controller) { setError(errorMessage(err)); finishDocx(controller, 'DOCX 导出未完成，请重试') }
    }
  }
  async function exportDocument(action: 'exportHtml' | 'print') {
    if (disabled || exporting.current || saving.current || editor.current?.composing()) return
    exporting.current = true; setBusy(true); setError(''); setStatus('正在准备文档…')
    try {
      // Parse the exact current source; the debounced preview may still be stale.
      const parsed = await parseForExport(text)
      const output = await createExport(parsed, name, async path => {
        const asset = images.resources.assets[path]
        if (asset) return asset
        if (!desktop || !fileId) throw new Error('resource_missing')
        return readImageBlob(fileId, path)
      })
      if (action === 'print') { setPrintable(output); setStatus('打印预览已准备好') }
      else {
        const saved = await saveHtml(output.name, output.html)
        setStatus(saved ? 'HTML 已导出' : 'HTML 导出已取消')
        if (saved && output.warnings.length) setError(`HTML 已导出，但有 ${output.warnings.length} 项图片未加载。${output.warnings.slice(0, 3).join('；')}`)
      }
    } catch (error) { setError(errorMessage(error)); setStatus('文档输出未完成') }
    finally { exporting.current = false; setBusy(false) }
  }
  const closePrint = useCallback(() => {
    setPrintable(null); setStatus('准备就绪')
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.app-menu-trigger')?.focus())
  }, [])
  useEffect(() => {
    if (!active) return
    const print = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'p' && !event.isComposing) {
        event.preventDefault()
        if (!(event.target as HTMLElement)?.closest('input, textarea, [role=dialog]')) execute('file.print')
      }
    }
    window.addEventListener('keydown', print, true)
    return () => window.removeEventListener('keydown', print, true)
  })
  useEffect(() => {
    if (!file) return
    images.setResources(openedResources(initial.text, file.metadata?.instances ?? []))
    if (file.warning) setError(errorMessage(file.warning))
  }, [])

  async function clearDraft(expectedRevision?: number) {
    draftGeneration.current++
    window.clearTimeout(draftTimer.current)
    draftQueue.current = draftQueue.current.catch(() => undefined).then(async () => {
      if (expectedRevision === undefined || expectedRevision === changeRevision.current) await drafts.clear(draftKey)
    })
    await draftQueue.current
    if (expectedRevision === undefined || expectedRevision === changeRevision.current) setDraftStatus('')
    else flushDraft.current()
  }

  function enqueueDraft(): Promise<unknown> {
    const generation = draftGeneration.current
    const current: Draft = { version: 1, name, text, snapshot, resources: images.resources, imageSession: images.session, fileId, baseRevision: revision, updatedAt: Date.now() }
    const hasLocalChanges = (dirty && persistedTextRevision.current !== changeRevision.current) || !!images.session
    draftQueue.current = draftQueue.current.catch(() => undefined).then(async () => {
      if (discarded.current || generation !== draftGeneration.current || !hasLocalChanges) return
      let resourceError: unknown
      try { current.resources = await materializeResources(fileId, current.resources ?? emptyResources()) } catch (err) { resourceError = err }
      if (generation !== draftGeneration.current) return
      await drafts.save(current, draftKey)
      if (resourceError) throw new Error(`正文草稿已保存，但图片副本不完整：${errorMessage(resourceError)}`)
    })
    return draftQueue.current
  }

  flushDraft.current = () => {
    if (discarded.current || !draftReady || draftUnavailable || pendingDraft || ((!dirty || persistedTextRevision.current === changeRevision.current) && !images.session) || images.busy || images.applying || panelApplying.current || busy) return
    window.clearTimeout(draftTimer.current)
    const version = changeRevision.current
    void enqueueDraft().then(() => { if (version === changeRevision.current) setDraftStatus('草稿已保存') })
      .catch((err) => { setDraftStatus('草稿保存失败'); setError(errorMessage(err)) })
  }

  useEffect(() => {
    const flush = () => flushDraft.current()
    const visibility = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('blur', flush)
    document.addEventListener('visibilitychange', visibility)
    return () => { window.removeEventListener('blur', flush); document.removeEventListener('visibilitychange', visibility) }
  }, [])

  useEffect(() => {
    let alive = true
    drafts.load(draftKey).then((draft) => { if (alive && draft) setPendingDraft(draft) })
      .catch((err) => { if (alive) { setDraftUnavailable(true); setError(errorMessage(err)) } })
      .finally(() => { if (alive) setDraftReady(true) })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (discarded.current || !draftReady || draftUnavailable || pendingDraft || ((!dirty || persistedTextRevision.current === changeRevision.current) && !images.session) || images.applying) return
    setDraftStatus('草稿待保存')
    draftTimer.current = window.setTimeout(() => {
      const version = changeRevision.current
      enqueueDraft().then(() => { if (version === changeRevision.current) setDraftStatus('草稿已保存') })
        .catch((err) => { setDraftStatus('草稿保存失败'); setError(errorMessage(err)) })
    }, 700)
    return () => window.clearTimeout(draftTimer.current)
  }, [text, name, snapshot, dirty, draftReady, draftUnavailable, pendingDraft, images.resources, images.session, images.applying, fileId, revision])

  useEffect(() => {
    if (external.checking || external.change || external.blocked.current || quickEntryOpen || contentTool || tableSession || tableInsert || !desktop || !fileId || !dirty || disabled || images.applying || autoSaving || autoSavePaused || suspended || discarded.current) return
    let timer: number
    const attempt = () => {
      // Wait for IME composition to finish instead of persisting an intermediate syllable.
      if (editor.current?.composing()) { timer = window.setTimeout(attempt, 250); return }
      void save(false, true)
    }
    timer = window.setTimeout(attempt, 1200)
    return () => window.clearTimeout(timer)
  }, [external.checking, external.change, quickEntryOpen, contentTool, tableSession, tableInsert, text, dirty, fileId, revision, snapshot, disabled, images.applying, autoSaving, autoSavePaused, suspended, images.resources])

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => { if (!desktop && (dirty || images.session || tableSession)) event.preventDefault() }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty, images.session, tableSession])

  useEffect(() => {
    if (!preview.current || (view !== 'split' && !reading)) return
    let alive = true
    const urls: string[] = []
    for (const image of preview.current.querySelectorAll<HTMLImageElement>('img[data-resource]')) {
      const resource = image.dataset.resource ?? ''
      image.removeAttribute('src')
      if (images.resources.assets[resource]) {
        const url = URL.createObjectURL(images.resources.assets[resource]); urls.push(url); image.src = url; continue
      }
      if (!desktop || !fileId || /^([a-z][a-z\d+.-]*:|[\\/])/i.test(resource)) {
        image.alt = `${image.alt}（图片未加载；需要已授权的本地文件）`
        continue
      }
      readImage(fileId, resource).then((url) => {
        if (!alive) { URL.revokeObjectURL(url); return }
        urls.push(url)
        image.src = url
      }).catch(() => { if (alive) image.alt += '（图片缺失或访问未授权）' })
    }
    return () => { alive = false; urls.forEach(URL.revokeObjectURL) }
  }, [parsed.html, fileId, view, reading, images.resources])

  function changed(next: string) {
    textRef.current = next
    discarded.current = false
    changeRevision.current++
    setText(next)
    setDirty(true)
    setStatus('正文未保存')
  }

  function load(nextText: string, nextName: string, nextSnapshot: FileSnapshot, id: string | null, baseRevision: string | null, modified = false) {
    sourceScroll.current = { offset: 0, fraction: 0, ratio: 0 }
    scrollAnchors.current = null
    draftGeneration.current++
    changeRevision.current++
    setText(nextText); setName(nextName); setSnapshot(nextSnapshot); setFileId(id); setRevision(baseRevision)
    setEpoch((value) => value + 1); setDirty(modified); setError(''); setDraftStatus('')
    setAutoSavePaused(false)
    setWorkspacePath(null)
    setStatus(modified ? '恢复到草稿，请另存以保留原文件' : '文件已打开')
    images.setResources(emptyResources()); images.setSession(null); parsedText.current = ''
  }

  function mayReplace(): boolean {
    if (pendingDraft || !draftReady) return false
    return !dirty || window.confirm('当前正文未写入文件。继续将替换当前编辑内容；请先保存或下载副本。')
  }

  async function open(read: () => Promise<OpenedFile | null> = openDocument, path: string | null = null, location?: WorkspaceLocation) {
    if (disabled || saving.current || editor.current?.composing()) return
    if (!await prepareLeave()) return
    setBusy(true)
    try {
      const file = await read()
      if (!file) return
      if (location && file.revision !== location.revision) { setError('文件已变化，请重新搜索后再定位。'); return }
      decodeFile(file.bytes)
      onOpen(file, path, workspace, location)
    } catch (err) { setError(errorMessage(err)) }
    finally { setBusy(false) }
  }

  async function chooseWorkspace(refresh = false) {
    if (disabled || saving.current) return
    setBusy(true)
    try {
      const next = refresh && workspace ? { ...workspace, entries: await listWorkspace(workspace.id) } : await openWorkspace()
      if (next) { onWorkspaceChange(next); onShowFiles(true); setTreeRevision((value) => value + 1); if (next.warning) setError(next.warning) }
    } catch (err) { setError(errorMessage(err)) }
    finally { setBusy(false) }
  }

  async function importWorkspaceImage(image: WorkspaceImage) {
    if (disabled) return
    await images.importFiles(async () => [await readWorkspaceImage(image)])
  }

  async function importClipboardImages() {
    if (disabled) return
    await images.importFiles(async () => {
      try { return await readClipboardImageFiles() }
      catch (err) { throw new Error(errorMessage(err)) }
    })
  }

  async function reloadExternal(expectedRevision?: string, confirmed = false) {
    if (!desktop || !fileId || busy || saving.current || images.session || images.busy || images.applying || panelApplying.current || contentToolRef.current || tableRef.current || editor.current?.composing() || (!confirmed && !mayReplace())) return
    setBusy(true); setError(''); setStatus('正在重新加载外部版本…')
    try {
      const file = await reloadDocument(fileId, expectedRevision)
      const decoded = decodeFile(file.bytes)
      await clearDraft()
      load(decoded.text, file.name, decoded, file.id, file.revision)
      images.setResources(openedResources(decoded.text, file.metadata?.instances ?? []))
      setExternalOpen(false)
      if (file.warning && parseDocument(decoded.text).images.length) setError(errorMessage(file.warning))
    } catch (err) { setError(errorMessage(err)); setStatus('重新加载失败'); if (confirmed) throw new Error(errorMessage(err)) }
    finally { setBusy(false) }
  }

  async function save(saveAs = false, automatic = false): Promise<boolean> {
    if (!saveAs && external.blocked.current) { setError('磁盘版本待检查或已变化，请比较或另存本地副本。'); return false }
    if (contentToolRef.current || tableRef.current || tableInsert || saving.current || busy || printable || exporting.current || draftUnavailable || pendingDraft || !draftReady || images.busy || images.applying || panelApplying.current || images.session || editor.current?.composing()) return false
    saving.current = true
    if (automatic) setAutoSaving(true); else setBusy(true)
    setError(''); setStatus(automatic ? '正在自动保存…' : '正在保存…')
    const savingRevision = changeRevision.current
    const savingText = text
    try {
      const mixed = snapshot.lineEnding === 'mixed' && text !== snapshot.originalText
      if (automatic && mixed) { setAutoSavePaused(true); setStatus('自动保存已暂停'); setError('该文件混合使用 LF/CRLF。请按 Ctrl/Cmd+S 确认换行转换，或通过 EM 菜单另存副本。'); return false }
      if (mixed && !window.confirm('该文件混合使用 LF/CRLF。修改后需统一为 LF；是否继续保存？')) { setStatus('保存已取消'); return false }
      const bytes = encodeFile(snapshot, savingText, mixed ? 'lf' : undefined)
      const result = await saveDocument({ id: fileId, name, revision, originalText: snapshot.originalText }, bytes, saveAs, images.resources)
      if (!result) { if (automatic) setAutoSavePaused(true); setStatus('保存已取消'); return false }
      if (result.destination === 'disk') persistedTextRevision.current = savingRevision
      setAutoSavePaused(false)
      setFileId(result.id); setName(result.name); setRevision(result.revision); setSnapshot(decodeFile(bytes))
      setRecentId(result.recentId ?? null)
      if (result.warning) setError(errorMessage(result.warning))
      if (savingRevision === changeRevision.current) {
        if (result.destination === 'disk') {
          await clearDraft(savingRevision)
          if (savingRevision === changeRevision.current) setDirty(false)
        }
        if (savingRevision === changeRevision.current) setStatus(result.destination === 'disk' ? automatic ? '已自动保存' : '文件已保存' : '已生成下载副本；确认下载完成后保留它')
        else setStatus('已保存上一版本，当前编辑尚未保存')
      } else setStatus('已保存上一版本，当前编辑尚未保存')
      return result.destination === 'disk' && savingRevision === changeRevision.current
    } catch (err) { if (automatic) setAutoSavePaused(true); setStatus(automatic ? '自动保存失败，请按 Ctrl/Cmd+S 重试或另存' : '保存失败'); setError(errorMessage(err)); return false }
    finally { saving.current = false; if (automatic) setAutoSaving(false); else setBusy(false) }
  }

  function command(kind: Command) { execute('format.' + kind) }
  function chooseView(next: ViewMode) { execute('view.' + next) }
  async function searchCurrentWorkspace() {
    if (!workspace || disabled || !workspaceQuery.trim()) return
    cancelSearch()
    const requestId = crypto.randomUUID()
    workspaceSearchRequest.current = requestId
    setWorkspaceSearching(true); setWorkspaceReport(null)
    try {
      const report = await searchWorkspace(workspace.id, workspaceQuery.trim(), requestId)
      if (requestId === workspaceSearchRequest.current && !report.cancelled) setWorkspaceReport(report)
    } catch (err) { if (requestId === workspaceSearchRequest.current) setError(errorMessage(err)) }
    finally { if (requestId === workspaceSearchRequest.current) { workspaceSearchRequest.current = null; setWorkspaceSearching(false) } }
  }
  function cancelSearch() {
    const requestId = workspaceSearchRequest.current
    workspaceSearchRequest.current = null
    if (requestId) void cancelWorkspaceSearch(requestId).catch(() => undefined)
    setWorkspaceSearching(false)
  }
  useEffect(() => {
    setWorkspaceSearching(false)
    return () => {
      const requestId = workspaceSearchRequest.current
      workspaceSearchRequest.current = null
      if (requestId) void cancelWorkspaceSearch(requestId).catch(() => undefined)
    }
  }, [workspace?.id, active])
  useEffect(() => { setWorkspaceReport(null) }, [workspace?.id])
  useEffect(() => {
    if (!location || !active || !draftReady || pendingDraft || location.token === navigatedLocation.current || (reading && parsedText.current !== text)) return
    navigatedLocation.current = location.token
    if (location.fragment) {
      try { const offset = headingAnchorOffset(text, location.fragment); if (offset === null) setError('没有对应标题锚点。'); else jumpTo(offset) } catch (err) { setError(errorMessage(err)) }
      return
    }
    if (revision !== location.revision || text !== snapshot.originalText) { setError('当前文件或本地编辑已变化，请保存并重新搜索后再定位。'); return }
    let offset = 0
    for (let line = 1; line < location.line; line++) {
      const next = text.indexOf('\n', offset)
      if (next < 0) { setError('匹配行已不存在，请重新搜索。'); return }
      offset = next + 1
    }
    jumpTo(offset)
  }, [location, active, draftReady, pendingDraft, revision, text, snapshot, reading, parsed.html])
  async function renderImage(resource: string): Promise<string | null> {
    const blob = images.resources.assets[resource]
    if (blob) return URL.createObjectURL(blob)
    if (!desktop || !fileId || /^([a-z][a-z\d+.-]*:|[\\/])/i.test(resource)) return null
    return readImage(fileId, resource)
  }
  function editRenderedImage(offset: number) {
    const reference = parsed.images.find(item => item.from === offset)
    if (reference && parsedText.current === text && !disabled) void images.edit(reference)
  }

  function openContentTool(kind: 'link' | 'language' | 'paragraph', context: CommandContext, offset?: number) {
    if (!registry.status('file.open', context).enabled || contentToolRef.current || tableRef.current) return
    try {
      const code = kind === 'language' ? offset === undefined ? editor.current?.fencedCode() : codeAt(textRef.current, offset) : undefined
      if (kind === 'language' && !code) throw new Error('请将光标放在围栏代码块中。')
      const paragraph = kind === 'paragraph' ? paragraphTarget(textRef.current, context.selection) : undefined
      const link = kind === 'link' ? linkAt(textRef.current, context.selection) : undefined
      const tool = { kind, context, code: code ?? undefined, paragraph, link }
      contentToolRef.current = tool; setContentError(''); setContentTool(tool)
    } catch (err) { setError(errorMessage(err)) }
  }
  function cancelContentTool() {
    if (contentComposing.current) return
    contentToolRef.current = null; setContentTool(null); setContentError('')
    requestAnimationFrame(() => editor.current?.focus())
  }
  function applyContentTool(create: (context: CommandContext) => EditCommandResult) {
    const tool = contentToolRef.current
    if (!tool || contentComposing.current) return
    try {
      const result = create(tool.context)
      // Exclude only this tool's lock; identity, revision and other locks remain.
      contentToolRef.current = null
      if (!editor.current?.applyCommand(result, tool.context)) throw new Error('正文、选区或任务状态已变化，请取消并重新打开工具。')
      setContentTool(null); setContentError('')
    } catch (err) { contentToolRef.current = tool; setContentError(errorMessage(err)) }
  }
  const openingLink = useRef(false), releaseUnused = useRef(onReleaseUnused); releaseUnused.current = onReleaseUnused
  async function openLinkTarget(url: string) {
    const tool = contentToolRef.current
    if (openingLink.current || contentComposing.current || !tool || !sameCommandTarget(tool.context, registry.capture())) return
    openingLink.current = true
    try {
      if (!safeLink(url)) throw new Error('此地址不安全，无法打开。')
      if (url.startsWith('#')) {
        const offset = headingAnchorOffset(textRef.current, url)
        if (offset === null) throw new Error('没有对应标题锚点。')
        cancelContentTool(); jumpTo(offset); return
      }
      if (/^(https?:|mailto:)/i.test(url)) { await openExternalLink(url); return }
      if (!desktop || !workspace) throw new Error('相对文档打开需要已授权工作区。请通过 EM 菜单打开工作区。')
      const path = relativeDocumentTarget(workspacePath, url)
      if (!path) throw new Error('目标越出工作区或不是 Markdown 文档。')
      const opened = await openWorkspaceDocument(workspace.id, path)
      if (contentToolRef.current !== tool || !sameCommandTarget(tool.context, registry.capture()) || !activeRef.current) { await releaseUnused.current(opened); return }
      const fragment = url.includes('#') ? url.slice(url.indexOf('#')) : undefined
      cancelContentTool(); onOpen(opened, path, workspace, fragment ? { token: crypto.randomUUID(), line: 1, revision: opened.revision ?? '', fragment } : undefined)
    } catch (err) { if (contentToolRef.current === tool) setContentError(errorMessage(err)) } finally { openingLink.current = false }
  }
  const toolExistingLink = contentTool?.link ?? null
  const toolCode = contentTool?.code

  function chooseCodeLanguage(language: string) { execute('code.language', language) }
  function applyCodeLanguage(language: string, context: CommandContext) {
    const block = editor.current?.fencedCode()
    if (!block) { setCodeLanguage(language); return true }
    const result = codeBlockCommand(context.textRevision, text, context.selection, language, block)
    const applied = editor.current?.applyCommand(result, context) ?? false
    if (applied) setCodeLanguage(language)
    return applied
  }

  async function recover(keep: boolean) {
    const draft = pendingDraft
    if (!draft) return
    try {
      if (keep) {
        setRecentId(null)
        load(draft.text, draft.name, draft.snapshot, null, null, true); images.setResources(draft.resources ?? emptyResources())
        if (draft.imageSession && draft.imageSession.baseText === draft.text) images.setSession(draft.imageSession)
      }
      else await clearDraft()
      setPendingDraft(null)
    } catch (err) { setError(errorMessage(err)) }
  }

  const commands: Array<[Command, string, string]> = [['bold', 'B', '加粗'], ['italic', 'I', '斜体'], ['strike', 'S̶', '删除线'], ['inlineCode', '‹›', '行内代码'], ['heading', 'H', '标题'], ['bullet', '☷', '无序列表'], ['ordered', '1.', '有序列表'], ['task', '☑', '任务列表'], ['quote', '❞', '引用'], ['code', '{ }', '代码块'], ['link', '↗', '链接']]
  const languages = ['', 'javascript', 'typescript', 'python', 'rust', 'java', 'c', 'cpp', 'csharp', 'go', 'html', 'css', 'json', 'yaml', 'sql', 'bash', 'powershell', 'markdown', 'text']

  return <>{externalOpen && active && external.change && 'snapshot' in external.change && <ExternalChangeDialog disk={external.change.snapshot} local={text} onClose={() => { setExternalOpen(false); requestAnimationFrame(() => editor.current?.focus()) }} onReload={() => reloadExternal(external.change && 'revision' in external.change ? external.change.revision : undefined, true)} onSaveCopy={async () => { if (await save(true)) setExternalOpen(false) }} onLocate={offset => { setExternalOpen(false); requestAnimationFrame(() => { setView('source'); jumpTo(offset) }) }} />}<div className={`app-shell ${reading ? 'reading-document' : ''}`} inert={externalOpen || !!contentTool || tableDecision || busy || !!printable}>
    <input hidden ref={imagePicker} type="file" accept="image/png,image/jpeg" onChange={(event) => {
      const target = imageInsert.current; imageInsert.current = null
      if (target && (!registry.status('insert.image', target.context).enabled || !validSlash(textRef.current, target.context.selection, target.slash))) { setError('图片插入位置已变化，请重新选择。'); event.target.value = ''; return }
      void images.importFiles(Array.from(event.target.files ?? []), target ? { anchor: target.slash.from, head: target.slash.to } : undefined)
      event.target.value = ''
    }} />
    {images.session && <ImagePanel key={images.session.instance.instanceId} image={images.session} onBusy={(value) => { panelApplying.current = value }} onCancel={() => { images.cancel(); if (!dirty) void clearDraft().catch((err) => setError(errorMessage(err))) }} onChange={images.update} onApply={images.apply} />}
    <div className="workspace">
      {showFiles && <ResizableSidebar side="left">
        <div className="sidebar-heading"><h2>文档</h2><button className="icon-button" aria-label="收起文件栏" onClick={() => onShowFiles(false)}>‹</button></div>
        {workspace && <button className="quick-row" disabled={disabled} onClick={() => void chooseWorkspace(true)}>⟳ <span>刷新文件树</span></button>}
        {workspace && <form className="workspace-search" role="search" aria-label="工作区搜索" onSubmit={(event) => { event.preventDefault(); void searchCurrentWorkspace() }}>
          <input aria-label="搜索工作区" value={workspaceQuery} placeholder="搜索 Markdown" maxLength={4096} onChange={(event) => { cancelSearch(); setWorkspaceQuery(event.target.value); setWorkspaceReport(null) }} />
          <button type="submit" disabled={disabled || !workspaceQuery.trim()}>搜索</button>
          {workspaceSearching && <button type="button" onClick={cancelSearch}>取消</button>}
        </form>}
        {workspaceSearching && <div role="status" className="tree-empty">正在搜索…</div>}
        {workspace && workspaceReport && <div className="workspace-search-results" aria-label="工作区搜索结果" onKeyDown={event => navigateButtons(event, '.workspace-search-result')}>
          <div className="tree-empty" role="status">{workspaceReport.results.length} 条匹配 · 扫描 {workspaceReport.scanned} 个文件{workspaceReport.skipped > 0 && ` · 跳过 ${workspaceReport.skipped} 项`}{workspaceReport.limited && ' · 已达搜索上限，结果不完整'}</div>
          {workspaceReport.results.length ? workspaceReport.results.map((result, index) => <button key={`${result.path}:${result.line}:${index}`} className="workspace-search-result" title={`${result.path}:${result.line}`} onClick={() => void open(() => openWorkspaceDocument(workspace.id, result.path), result.path, { token: crypto.randomUUID(), line: result.line, revision: result.revision })}><strong>{result.path}</strong><span>第 {result.line} 行 · {result.preview || '空行'}</span></button>) : <div className="tree-empty">没有匹配结果</div>}
        </div>}
        <div className="sidebar-label">当前文件</div><div className="file-row active" title={name}><span aria-hidden="true">□</span><span className="current-file-name">{name}</span>{dirty && <span aria-label="未保存">·</span>}</div>
        {workspace && <WorkspaceTree key={`${workspace.id}:${treeRevision}`} workspace={workspace} disabled={disabled} selected={workspacePath} onOpen={(path) => void open(() => openWorkspaceDocument(workspace.id, path), path)} onImage={(image) => void importWorkspaceImage(image)} onError={(message) => setError(errorMessage(message))} />}
        {!workspace && <div className="outline-empty"><p>点击 EM 菜单打开工作区，浏览 Markdown 和图片文件。</p></div>}
        <div className="sidebar-footer"><span>本地优先</span><span className="version">v0.5.0-dev</span></div>
      </ResizableSidebar>}
      <main className="editor-area">
        <div className="view-switcher">{!reading && <div className="view-tabs"><button className={view === 'source' ? 'selected' : ''} onClick={() => chooseView('source')}>源码</button><button className={view === 'split' ? 'selected' : ''} onClick={() => chooseView('split')}>分屏</button><button className={view === 'live' ? 'selected' : ''} onClick={() => chooseView('live')} title="非活动块渲染；点击块或移动光标显示源码">即时渲染</button></div>}<div className="pane-actions"><button aria-label={showFiles ? '收起文件栏' : '展开文件栏'} aria-expanded={showFiles} onClick={() => execute('view.files')}>文件树</button><button aria-label={showOutline ? '收起大纲' : '展开大纲'} aria-expanded={showOutline} onClick={() => execute('view.outline')}>大纲</button>{!reading && <button disabled={disabled} onClick={() => execute('edit.search')}>查找 / 替换</button>}{!reading && <button aria-label={showToolbar ? '隐藏格式工具栏' : '显示格式工具栏'} aria-expanded={showToolbar} onClick={() => execute('view.toolbar')}>格式工具栏</button>}<button className="reading-button" disabled={readingBusy || (!reading && (disabled || !!editor.current?.composing()))} onClick={() => execute('view.reading')}>{reading ? '退出阅读模式' : '阅读模式'}</button></div></div>
        {showToolbar && !reading && <div className="toolbar" role="toolbar" aria-label="格式工具栏">{commands.map(([kind, label, title]) => <button key={kind} disabled={!registry.status('format.' + kind).enabled} aria-pressed={registry.status('format.' + kind).checked} onMouseDown={(event) => event.preventDefault()} onClick={() => command(kind)} title={title} aria-label={title}>{label}</button>)}<label className="code-language">语言 <select aria-label="代码块语言" value={codeLanguage} disabled={!registry.status('code.language').enabled} title="光标在代码块中时修改语言；否则选择新代码块的语言" onChange={(event) => chooseCodeLanguage(event.target.value)}>{!languages.includes(codeLanguage) && <option value={codeLanguage}>{codeLanguage}</option>}{languages.map((language) => <option key={language} value={language}>{language || '无语言'}</option>)}</select></label><button aria-label="转换为" disabled={!registry.status('paragraph.convert').enabled} onMouseDown={event => event.preventDefault()} onClick={() => execute('paragraph.convert')}>转换为</button><span className="toolbar-divider" /><button aria-label="插入表格" disabled={!registry.status('insert.table').enabled} onMouseDown={event => event.preventDefault()} onClick={() => execute('insert.table')}>表格＋</button><button aria-label="编辑表格" disabled={!registry.status('table.edit').enabled} onMouseDown={event => event.preventDefault()} onClick={() => execute('table.edit')}>编辑表格</button><button title="插入 PNG/JPEG 图片" aria-label="插入图片" disabled={!registry.status('insert.image').enabled} onClick={() => execute('insert.image')}>▣</button><button aria-label="撤销" disabled={!registry.status('edit.undo').enabled} onClick={() => execute('edit.undo')}>↶</button><button aria-label="重做" disabled={!registry.status('edit.redo').enabled} onClick={() => execute('edit.redo')}>↷</button>{view === 'split' && <span className="toolbar-hint">源码与预览双向同步</span>}</div>}
        {error && <div className="error-banner" role="alert">{error}<button aria-label="关闭错误提示" onClick={() => setError('')}>×</button></div>}
        {external.change && <div className="recovery-banner" role="status" aria-label="外部文件变化">
          <strong>{'error' in external.change ? '无法检查磁盘版本' : '文件已被外部修改'}</strong>
          <span>{'error' in external.change ? errorMessage(external.change.error) : dirty || images.session || tableSession ? '本地编辑已保留，自动保存已暂停。请先确认未提交的图片或表格输入。' : '当前正文保持不变，请确认是否加载磁盘版本。'}</span>
          <button disabled={disabled || !!contentTool || !!tableSession || !!editor.current?.composing() || 'error' in external.change} onClick={() => setExternalOpen(true)}>比较外部版本</button>
          <button disabled={disabled || !!contentTool || !!tableSession || !!editor.current?.composing() || 'error' in external.change} onClick={() => void reloadExternal(external.change && 'revision' in external.change ? external.change.revision : undefined)}>重新加载磁盘版本</button>
          <button disabled={disabled || !!contentTool || !!tableSession} onClick={() => void save(true)}>另存本地副本</button>
          <button disabled={external.checking || busy} onClick={external.recheck}>重新检查</button>
        </div>}
        {pendingDraft && <div className="recovery-banner" role="dialog" aria-label="恢复草稿"><strong>发现未完成草稿：{pendingDraft.name}</strong><span>恢复为应用副本，可另存；原文件不会被覆盖。</span><button onClick={() => void recover(true)}>恢复草稿</button><button onClick={() => void recover(false)}>放弃草稿</button></div>}
        {images.busy && <div className="recovery-banner" role="status">正在处理图片…<button onClick={images.cancel}>取消任务</button></div>}
        <div className={`content-grid view-${reading ? 'reading' : view}`} inert={disabled} onWheelCapture={(event) => { scrollOwner.current = (event.target as HTMLElement).closest('.preview') ? 'preview' : 'source'; expectedPreview.current = null }} onPointerDownCapture={(event) => { scrollOwner.current = (event.target as HTMLElement).closest('.preview') ? 'preview' : 'source'; expectedPreview.current = null }} onKeyDownCapture={(event) => { scrollOwner.current = (event.target as HTMLElement).closest('.preview') ? 'preview' : 'source'; expectedPreview.current = null }}>
          <div className="source-pane" hidden={reading} inert={reading || !!tableSession}><Editor key={epoch} ref={editor} initialText={text} commandStatus={(commandId, expected) => registry.status(commandId, expected)} selectionTools={showSelectionTools && active && !reading && !suspended && !contentTool} commandContext={() => commandRuntime.current.context()} blocked={quickEntryOpen || !!contentTool || !!tableSession || reading || suspended || disabled} live={view === 'live' && !reading} parsed={parsed} previewText={parsedText.current} imageContext={liveImageContext} onRenderImage={renderImage} onEditImage={editRenderedImage} onEditTable={offset => execute('table.edit', offset)} onEditLanguage={offset => { if (parsedText.current === textRef.current) openContentTool('language', registry.capture(), offset) }} onChange={changed} onHighlightLimited={setHighlightLimited} onFormats={setFormats} onScroll={syncPreview} onSearchMatch={searchMatch} onCodeLanguage={(language) => { if (language !== null) setCodeLanguage(language) }} onSave={() => execute('file.save')} onImages={(files) => void images.importFiles(files)} onClipboardFiles={() => void importClipboardImages()} onWorkspaceImage={(image) => void importWorkspaceImage(image)} onCommand={execute} /></div>
          {(view === 'split' || reading) && <article ref={preview} className="preview" aria-label="Markdown 预览" onContextMenu={event => {
            const selected = window.getSelection()
            const selectedText = selected?.rangeCount && event.currentTarget.contains(selected.getRangeAt(0).commonAncestorContainer) ? selected.toString() : ''
            const image = (event.target as HTMLElement).closest<HTMLImageElement>('img[data-source-from]')
            const reference = image && parsed.images.find(item => item.from === Number(image.dataset.sourceFrom))
            const actions: ContextAction[] = [
              { label: '复制', disabled: !selectedText, run: () => navigator.clipboard.writeText(selectedText) },
              { label: '全选预览', run: () => { window.getSelection()?.selectAllChildren(preview.current!) } },
            ]
            if (reference && !reading) actions.unshift({ label: '编辑图片副本', disabled: disabled || parsedText.current !== text, run: () => { if (!disabled && parsedText.current === text) void images.edit(reference) } })
            if (image?.alt) actions.push({ label: '复制图片说明', run: () => navigator.clipboard.writeText(image.alt) })
            const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]')
            if (link) actions.push({ label: '复制链接地址', run: () => navigator.clipboard.writeText(link.getAttribute('href')!) })
            contextMenu(event, actions)
          }} onScroll={syncSource} onLoadCapture={() => syncPreview(sourceScroll.current, true)} onDoubleClick={(event) => {
            if (reading) return
            const node = (event.target as HTMLElement).closest<HTMLImageElement>('img[data-source-from]')
            const reference = parsed.images.find((item) => item.from === Number(node?.dataset.sourceFrom))
            if (reference && parsedText.current === text) void images.edit(reference)
          }} onClick={(event) => {
            const target = event.target as HTMLElement
            const tableAction = target.closest<HTMLElement>('[data-table-action]')
            if (!reading && tableAction) { if (parsedText.current !== text) return; if (tableAction.dataset.tableAction === 'edit') execute('table.edit', Number(tableAction.dataset.tableOffset)); else jumpTo(Number(tableAction.dataset.tableOffset)); return }
            const languageAction = target.closest<HTMLElement>('[data-language-offset]')
            if (!reading && languageAction && parsedText.current === text) { openContentTool('language', registry.capture(), Number(languageAction.dataset.languageOffset)); return }
            const link = target.closest<HTMLAnchorElement>('a[href]')
            if (link && (link.hasAttribute('data-footnote-ref') || link.hasAttribute('data-footnote-backref'))) {
              event.preventDefault()
              if (!active || disabled || editor.current?.composing() || tableRef.current || parsedText.current !== text) return
              const id = link.getAttribute('href')?.slice(1)
              const destination = Array.from(preview.current?.querySelectorAll<HTMLElement>('[id]') ?? []).find(node => node.id === id)
              if (!destination) return
              // Hold preview ownership so source scroll events cannot undo this
              // exact note jump. The DOM search is confined to the active tab.
              scrollOwner.current = 'preview'
              if (!reading && destination.dataset.sourceFrom !== undefined) editor.current?.jump(Number(destination.dataset.sourceFrom))
              if (!destination.matches('a,button,input,[tabindex]')) destination.tabIndex = -1
              destination.focus({ preventScroll: true })
              destination.scrollIntoView({ block: 'start' })
              expectedPreview.current = preview.current?.scrollTop ?? null
              return
            }
            if (link) { event.preventDefault(); if (!reading && parsedText.current === text) { editor.current?.jump(Number(link.dataset.sourceFrom)); openContentTool('link', registry.capture()) }; return }
            const cell = target.closest<HTMLElement>('th,td')
            if (!reading && parsedText.current === text && cell) { execute('table.edit', Number(cell.dataset.sourceFrom)); return }
            const node = target.closest<HTMLElement>('[data-source-from]')
            if (!reading && parsedText.current === text && node?.dataset.sourceFrom) jumpTo(Number(node.dataset.sourceFrom))
          }} dangerouslySetInnerHTML={{ __html: parsed.html }} />}
        </div>
        <div className="statusbar" role="status"><span className={`status-dot ${dirty ? 'dirty' : 'saved'}`} />{status}<span className="status-separator" />{snapshot.encoding.toUpperCase()} · {snapshot.lineEnding.toUpperCase()} · {statistics.lines} 行 · <span title="Markdown 源文字符数，不含空白；emoji 按一个 Unicode 字符计数">{statistics.characters} 字</span>{view === 'live' && (text.length > MAX_LIVE_DOCUMENT || highlightLimited) && <span title="即时渲染暂限 1 Mi 字符且单行不超过 20,000 字符；源码和分屏仍可用"> · 即时渲染已降级为源码</span>}{highlightLimited && <span title="存在超过 20,000 字符的单行；缩短后自动恢复源码高亮，预览仍完整显示。"> · 超长行：源码高亮已暂停</span>}<span className="status-spacer" />{draftStatus}</div>
      </main>
      {showOutline && <ResizableSidebar side="right"><div className="sidebar-heading"><h2>文档大纲</h2><button className="icon-button" aria-label="收起大纲" onClick={() => setShowOutline(false)}>›</button></div><nav className="outline" aria-label="文档大纲" onKeyDown={event => navigateButtons(event, '.outline-item')}>{parsed.headings.map((heading) => <button key={heading.offset} className={`outline-item level-${heading.level}`} title={heading.title} onContextMenu={event => contextMenu(event, [
        { label: '跳转到标题', disabled: disabled && !reading, run: () => jumpTo(heading.offset) },
        { label: '复制标题', run: () => navigator.clipboard.writeText(heading.title) },
      ])} onClick={() => jumpTo(heading.offset)}>{heading.title}</button>)}</nav>{!parsed.headings.length && <div className="outline-empty"><div className="empty-icon">⌁</div><strong>尚无标题</strong><p>输入 # 标题创建大纲，点击标题可跳转到正文。</p></div>}</ResizableSidebar>}
    </div>
  </div>
  {contentTool && active && contentTool.kind === 'link' && <LinkDialog existing={toolExistingLink} label={toolExistingLink?.label ?? text.slice(Math.min(contentTool.context.selection.anchor, contentTool.context.selection.head), Math.max(contentTool.context.selection.anchor, contentTool.context.selection.head))} error={contentError} onComposing={value => { contentComposing.current = value }} onCancel={cancelContentTool} onSubmit={(label, url) => applyContentTool(context => linkCommand(context.textRevision, textRef.current, context.selection, label, url))} onUnlink={() => applyContentTool(context => unlinkCommand(context.textRevision, textRef.current, context.selection))} onOpen={() => { if (toolExistingLink) void openLinkTarget(toolExistingLink.url) }} />}
  {contentTool && active && contentTool.kind === 'language' && toolCode && <LanguageDialog language={toolCode.language} error={contentError} onComposing={value => { contentComposing.current = value }} onCancel={cancelContentTool} onSubmit={language => applyContentTool(context => codeBlockCommand(context.textRevision, textRef.current, context.selection, language, toolCode))} />}
  {contentTool && active && contentTool.paragraph && <ParagraphDialog target={contentTool.paragraph} error={contentError} onComposing={value => { contentComposing.current = value }} onCancel={cancelContentTool} onSubmit={kind => applyContentTool(context => paragraphCommand(context.textRevision, textRef.current, context.selection, kind))} />}
  {tableInsert && active && <TableInsert error={error} onClose={() => { setTableInsert(null); editor.current?.focus() }} onInsert={(rows, columns) => {
    try {
      const context = tableInsert
      if (context.slash && !validSlash(textRef.current, context.selection, context.slash)) throw new Error('快捷插入位置已变化，请重新输入 /。')
      const patch = insertTable(textRef.current, context.slash?.from ?? Math.min(context.selection.anchor, context.selection.head), context.slash?.to ?? Math.max(context.selection.anchor, context.selection.head), rows, columns)
      sourceTable(applyPatches(textRef.current, [patch]), patch.firstCell)
      // The dialog itself is the only additional lock. Recheck every original
      // identity/revision/selection and all task locks before committing.
      setTableInsert(null)
      requestAnimationFrame(() => {
        if (editor.current?.applyCommand({ baseTextRevision: context.textRevision, patches: [patch], selection: { anchor: patch.firstCell, head: patch.firstCell } }, context)) openTable(patch.firstCell, registry.capture())
        else setError('正文已变化或正在处理，表格未插入。请重试。')
      })
    } catch (err) { setError(errorMessage(err)) }
  }} />}{tableSession && active && <TablePanel session={tableSession} error={tableError} decision={tableDecision} onComposing={value => { cellComposing.current = value }} onDraft={tableDraft} onCommit={commitTable} onNavigate={(row, column) => { commitTable('stay', undefined, undefined, { row, column }) }} onDismiss={() => { void prepareLeave() }} />}{tableDecision && <DraftDecision error={tableError} onChoose={decideTable} />}{printable && <PrintDialog output={printable} onClose={closePrint} />}{docx && active && <DocxDialog prepared={docx.prepared} source={docx.source} phase={docx.phase} onGenerate={options => void generateDocx(options)} onCancel={() => cancelDocx()} onLocate={offset => cancelDocx(offset)} onReadOther={onReadOther} />}{historyOpen && active && <HistoryDialog fileId={fileId} text={text} bytes={historyBytes()} snapshot={snapshot} revision={revision} resources={images.resources} onClose={closeHistory} onRestore={restoreHistory} />}{batchOpen && active && <BatchImageDialog text={text} fileId={fileId} resources={images.resources} onClose={closeBatch} onHistory={() => { setBatchOpen(false); setHistoryOpen(true) }} onApply={applyBatch} />}</>
}
