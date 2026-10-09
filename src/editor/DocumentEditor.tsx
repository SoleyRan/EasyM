import { useEffect, useRef, useState } from 'react'
import { prefixLines, replaceSelection, wrapSelection } from '../core/document'
import { blankSnapshot, decodeFile, encodeFile, type FileSnapshot } from '../core/codec'
import { parseDocument } from '../core/markdown'
import { Editor, type EditorHandle, type SourceScroll } from './Editor'
import { codeBlockCommand } from '../core/code-block'
import { desktop, openDocument, saveDocument, readImage, reloadDocument, materializeResources } from '../platform/storage'
import { drafts, type Draft } from '../platform/drafts'
import { ImagePanel } from './ImagePanel'
import { useImages } from './useImages'
import { emptyResources } from '../platform/images'
import { usePreview } from './usePreview'
import { WorkspaceTree } from './WorkspaceTree'
import { openWorkspace, listWorkspace, openWorkspaceDocument, readWorkspaceImage, type Workspace, type WorkspaceImage } from '../platform/workspace'
import type { OpenedFile } from '../platform/storage'
import { readClipboardImageFiles } from '../platform/clipboard'
import { ResizableSidebar } from './ResizableSidebar'

type ViewMode = 'source' | 'split'
type Command = 'bold' | 'italic' | 'quote' | 'bullet' | 'task' | 'heading' | 'ordered' | 'code' | 'link'
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
    io_failed: '写入失败，本地编辑和草稿仍保留，请重试或另存。',
    clipboard_busy: '剪贴板正在被其他程序使用，请稍后重新粘贴。',
    multiple_clipboard_images: '请每次复制并粘贴一张 PNG/JPEG 图片。',
  }
  return labels[value] ?? value
}

export interface DocumentSummary { name: string; dirty: boolean; busy: boolean; pendingImage: boolean; fileId: string | null }
export type FileAction = 'new' | 'open' | 'workspace' | 'saveAs' | 'reload'
export interface DocumentHandle { summary: DocumentSummary; canLeave(): boolean; canEdit(): boolean; run(action: FileAction): void; retain(): Promise<void>; discard(): Promise<void>; resume(): void; save(): Promise<boolean> }
interface Props {
  reading: boolean; readingBusy: boolean; onReading(next: boolean): void
  id: string; active: boolean; suspended: boolean; draftKey: string; file?: OpenedFile; blank?: boolean; path?: string | null
  workspace: Workspace | null; onWorkspaceChange(workspace: Workspace): void
  showFiles: boolean; onShowFiles(show: boolean): void; showToolbar: boolean; onShowToolbar(show: boolean): void
  onNew(): void; onOpen(file: OpenedFile, path: string | null, workspace: Workspace | null): void
  onReport(id: string, summary: DocumentSummary, handle: DocumentHandle): void
}
export default function DocumentEditor({ reading, readingBusy, onReading, id, active, suspended, draftKey, file, blank, path, workspace, onWorkspaceChange, showFiles, onShowFiles, showToolbar, onShowToolbar, onNew, onOpen, onReport }: Props) {
  const [initial] = useState(() => file ? decodeFile(file.bytes) : blankSnapshot())
  const [text, setText] = useState(file ? initial.text : blank ? '' : initialText)
  const [view, setView] = useState<ViewMode>('source')
  const [name, setName] = useState(file?.name ?? '未命名.md')
  const [fileId, setFileId] = useState<string | null>(file?.id ?? null)
  const [revision, setRevision] = useState<string | null>(file?.revision ?? null)
  const [snapshot, setSnapshot] = useState<FileSnapshot>(initial)
  const [epoch, setEpoch] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [autoSaving, setAutoSaving] = useState(false)
  const [autoSavePaused, setAutoSavePaused] = useState(false)
  const [status, setStatus] = useState(file ? '文件已打开' : '准备就绪')
  const [draftStatus, setDraftStatus] = useState('')
  const [error, setError] = useState('')
  const [pendingDraft, setPendingDraft] = useState<Draft | null>(null)
  const [draftReady, setDraftReady] = useState(false)
  const [draftUnavailable, setDraftUnavailable] = useState(false)
  const [showOutline, setShowOutline] = useState(false)
  const [codeLanguage, setCodeLanguage] = useState('')
  const [workspacePath, setWorkspacePath] = useState<string | null>(path ?? null)
  const [treeRevision, setTreeRevision] = useState(0)
  const editor = useRef<EditorHandle>(null)
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
    if (reading) {
      const node = Array.from(preview.current?.querySelectorAll<HTMLElement>('[data-source-from]') ?? []).find((element) => Number(element.dataset.sourceFrom) === offset)
      node?.scrollIntoView({ block: 'start' })
      return
    }
    scrollOwner.current = 'source'
    expectedPreview.current = null
    editor.current?.jump(offset)
    // Also sync when the heading is already visible and CodeMirror does not scroll.
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
  function openedResources(body: string, instances = images.resources.instances) {
    const paths = new Set(parseDocument(body).images.map((item) => item.url))
    return { assets: {}, instances: instances.filter((item) => paths.has(item.displayPath)) }
  }
  const images = useImages({
    text, fileId, blocked: reading || busy || autoSaving || !!pendingDraft || !draftReady || !!editor.current?.composing(),
    selection: () => editor.current?.selection() ?? { anchor: text.length, head: text.length },
    patch: (from, to, insert) => editor.current?.patch([{ from, to, insert }]) ?? false,
    error: setError,
    persist: async (nextText, resources, operationId) => {
      if (!desktop || !fileId) return
      const mixed = snapshot.lineEnding === 'mixed' && nextText !== snapshot.originalText
      if (mixed && !window.confirm('图片应用将保存正文，并将混合换行统一为 LF。是否继续？')) throw new Error('应用已取消，原版本仍保留。')
      const bytes = encodeFile(snapshot, nextText, mixed ? 'lf' : undefined)
      const result = await saveDocument({ id: fileId, name, revision }, bytes, false, resources, operationId)
      if (!result) throw new Error('保存已取消，原版本仍保留。')
      await clearDraft().catch((err) => setError(errorMessage(err)))
      setRevision(result.revision); setSnapshot(decodeFile(bytes)); if (result.warning) setError(errorMessage(result.warning))
    },
    applied: () => { setView('split'); if (desktop && fileId) setDirty(false); setStatus(desktop && fileId ? '图片副本与正文已保存' : '图片已应用，请下载工作区副本') },
  })
  const disabled = busy || draftUnavailable || !!pendingDraft || !draftReady || images.busy || !!images.session
  const summary = { name: pendingDraft?.name ?? name, dirty: dirty || !!pendingDraft || draftUnavailable, fileId, busy: busy || autoSaving || images.busy || images.applying || !draftReady, pendingImage: !!images.session }
  useEffect(() => {
    onReport(id, summary, { summary, canLeave: () => !saving.current && !busy && !images.busy && !images.applying && !panelApplying.current && draftReady && !editor.current?.composing(),
      canEdit: () => !disabled && !saving.current && !editor.current?.composing(),
      run: (action) => {
        if (disabled || saving.current || editor.current?.composing()) return
        if (action === 'new') onNew()
        else if (action === 'open') void open()
        else if (action === 'workspace') void chooseWorkspace()
        else if (action === 'reload') void reloadExternal()
        else void save(true)
      },
      retain: async () => { if (!pendingDraft && !draftUnavailable && (dirty || images.session)) { window.clearTimeout(draftTimer.current); await enqueueDraft() } },
      discard: async () => { discarded.current = true; await clearDraft() },
      resume: () => { discarded.current = false; flushDraft.current() }, save: () => save(),
    })
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
    if (!desktop || !fileId || !dirty || disabled || images.applying || autoSaving || autoSavePaused || suspended || discarded.current) return
    let timer: number
    const attempt = () => {
      // Wait for IME composition to finish instead of persisting an intermediate syllable.
      if (editor.current?.composing()) { timer = window.setTimeout(attempt, 250); return }
      void save(false, true)
    }
    timer = window.setTimeout(attempt, 1200)
    return () => window.clearTimeout(timer)
  }, [text, dirty, fileId, revision, snapshot, disabled, images.applying, autoSaving, autoSavePaused, suspended, images.resources])

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => { if (!desktop && (dirty || images.session)) event.preventDefault() }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty, images.session])

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

  async function open(read: () => Promise<OpenedFile | null> = openDocument, path: string | null = null) {
    if (disabled || saving.current || editor.current?.composing()) return
    setBusy(true)
    try {
      const file = await read()
      if (!file) return
      decodeFile(file.bytes)
      onOpen(file, path, workspace)
    } catch (err) { setError(errorMessage(err)) }
    finally { setBusy(false) }
  }

  async function chooseWorkspace(refresh = false) {
    if (disabled || saving.current) return
    setBusy(true)
    try {
      const next = refresh && workspace ? { ...workspace, entries: await listWorkspace(workspace.id) } : await openWorkspace()
      if (next) { onWorkspaceChange(next); onShowFiles(true); setTreeRevision((value) => value + 1) }
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

  async function reloadExternal() {
    if (!desktop || !fileId || busy || !mayReplace()) return
    setBusy(true); setError(''); setStatus('正在重新加载外部版本…')
    try {
      const file = await reloadDocument(fileId)
      const decoded = decodeFile(file.bytes)
      await clearDraft()
      load(decoded.text, file.name, decoded, file.id, file.revision)
      images.setResources(openedResources(decoded.text, file.metadata?.instances ?? []))
      if (file.warning && parseDocument(decoded.text).images.length) setError(errorMessage(file.warning))
    } catch (err) { setError(errorMessage(err)); setStatus('重新加载失败') }
    finally { setBusy(false) }
  }

  async function save(saveAs = false, automatic = false): Promise<boolean> {
    if (saving.current || draftUnavailable || pendingDraft || !draftReady || images.busy || images.applying || panelApplying.current || images.session || editor.current?.composing()) return false
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
      const result = await saveDocument({ id: fileId, name, revision }, bytes, saveAs, images.resources)
      if (!result) { if (automatic) setAutoSavePaused(true); setStatus('保存已取消'); return false }
      if (result.destination === 'disk') persistedTextRevision.current = savingRevision
      setAutoSavePaused(false)
      setFileId(result.id); setName(result.name); setRevision(result.revision); setSnapshot(decodeFile(bytes))
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

  function command(kind: Command) {
    if (disabled || editor.current?.composing()) return
    const selection = editor.current?.selection() ?? { anchor: 0, head: 0 }
    const current = changeRevision.current
    const result = kind === 'bold' || kind === 'italic' ? wrapSelection(current, text, selection, kind === 'bold' ? '**' : '*')
      : kind === 'code' ? codeBlockCommand(current, text, selection, codeLanguage, editor.current?.fencedCode() ?? null)
      : kind === 'link' ? replaceSelection(current, selection, `[${text.slice(Math.min(selection.anchor, selection.head), Math.max(selection.anchor, selection.head)) || '链接文字'}](https://example.com)`)
      : prefixLines(current, text, selection, { heading: '## ', quote: '> ', bullet: '- ', task: '- [ ] ', ordered: '1. ' }[kind])
    if (result.baseTextRevision === changeRevision.current) editor.current?.patch(result.patches, result.selection)
  }

  function chooseCodeLanguage(language: string) {
    setCodeLanguage(language)
    if (disabled || editor.current?.composing()) return
    const block = editor.current?.fencedCode()
    if (!block) return
    const selection = editor.current!.selection()
    const result = codeBlockCommand(changeRevision.current, text, selection, language, block)
    editor.current?.patch(result.patches, result.selection)
  }

  async function recover(keep: boolean) {
    const draft = pendingDraft
    if (!draft) return
    try {
      if (keep) {
        load(draft.text, draft.name, draft.snapshot, null, null, true); images.setResources(draft.resources ?? emptyResources())
        if (draft.imageSession && draft.imageSession.baseText === draft.text) images.setSession(draft.imageSession)
      }
      else await clearDraft()
      setPendingDraft(null)
    } catch (err) { setError(errorMessage(err)) }
  }

  const commands: Array<[Command, string, string]> = [['bold', 'B', '加粗'], ['italic', 'I', '斜体'], ['heading', 'H', '标题'], ['bullet', '☷', '无序列表'], ['ordered', '1.', '有序列表'], ['task', '☑', '任务列表'], ['quote', '❞', '引用'], ['code', '{ }', '代码块'], ['link', '↗', '链接']]
  const languages = ['', 'javascript', 'typescript', 'python', 'rust', 'java', 'c', 'cpp', 'csharp', 'go', 'html', 'css', 'json', 'yaml', 'sql', 'bash', 'powershell', 'markdown', 'text']

  return <div className={`app-shell ${reading ? 'reading-document' : ''}`}>
    <input hidden ref={imagePicker} type="file" accept="image/png,image/jpeg" onChange={(event) => { void images.importFiles(Array.from(event.target.files ?? [])); event.target.value = '' }} />
    {images.session && <ImagePanel key={images.session.instance.instanceId} image={images.session} onBusy={(value) => { panelApplying.current = value }} onCancel={() => { images.cancel(); if (!dirty) void clearDraft().catch((err) => setError(errorMessage(err))) }} onChange={images.update} onApply={images.apply} />}
    <div className="workspace">
      {showFiles && <ResizableSidebar side="left">
        <div className="sidebar-heading"><h2>文档</h2><button className="icon-button" aria-label="收起文件栏" onClick={() => onShowFiles(false)}>‹</button></div>
        {workspace && <button className="quick-row" disabled={disabled} onClick={() => void chooseWorkspace(true)}>⟳ <span>刷新文件树</span></button>}
        <div className="sidebar-label">当前文件</div><div className="file-row active" title={name}><span aria-hidden="true">□</span><span className="current-file-name">{name}</span>{dirty && <span aria-label="未保存">·</span>}</div>
        {workspace && <WorkspaceTree key={treeRevision} workspace={workspace} disabled={disabled} selected={workspacePath} onOpen={(path) => void open(() => openWorkspaceDocument(workspace.id, path), path)} onImage={(image) => void importWorkspaceImage(image)} onError={(message) => setError(errorMessage(message))} />}
        {!workspace && <div className="outline-empty"><p>点击 EM 菜单打开工作区，浏览 Markdown 和图片文件。</p></div>}
        <div className="sidebar-footer"><span>本地优先</span><span className="version">v0.1.0-dev</span></div>
      </ResizableSidebar>}
      <main className="editor-area">
        <div className="view-switcher">{!reading && <div className="view-tabs"><button className={view === 'source' ? 'selected' : ''} onClick={() => setView('source')}>源码</button><button className={view === 'split' ? 'selected' : ''} onClick={() => setView('split')}>分屏</button><button disabled title="尚未通过中文输入与光标验证">即时渲染 · 待验证</button></div>}<div className="pane-actions"><button aria-label={showFiles ? '收起文件栏' : '展开文件栏'} aria-expanded={showFiles} onClick={() => onShowFiles(!showFiles)}>文件树</button><button aria-label={showOutline ? '收起大纲' : '展开大纲'} aria-expanded={showOutline} onClick={() => setShowOutline(!showOutline)}>大纲</button>{!reading && <button aria-label={showToolbar ? '隐藏格式工具栏' : '显示格式工具栏'} aria-expanded={showToolbar} onClick={() => onShowToolbar(!showToolbar)}>格式工具栏</button>}<button className="reading-button" disabled={readingBusy || (!reading && (disabled || !!editor.current?.composing()))} onClick={() => onReading(!reading)}>{reading ? '退出阅读模式' : '阅读模式'}</button></div></div>
        {showToolbar && !reading && <div className="toolbar" role="toolbar" aria-label="格式工具栏">{commands.map(([kind, label, title]) => <button key={kind} disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={() => command(kind)} title={title} aria-label={title}>{label}</button>)}<label className="code-language">语言 <select aria-label="代码块语言" value={codeLanguage} disabled={disabled} title="光标在代码块中时修改语言；否则选择新代码块的语言" onChange={(event) => chooseCodeLanguage(event.target.value)}>{!languages.includes(codeLanguage) && <option value={codeLanguage}>{codeLanguage}</option>}{languages.map((language) => <option key={language} value={language}>{language || '无语言'}</option>)}</select></label><span className="toolbar-divider" /><button title="插入 PNG/JPEG 图片" aria-label="插入图片" disabled={disabled} onClick={() => imagePicker.current?.click()}>▣</button><button aria-label="撤销" disabled={disabled} onClick={() => editor.current?.undo()}>↶</button><button aria-label="重做" disabled={disabled} onClick={() => editor.current?.redo()}>↷</button>{view === 'split' && <span className="toolbar-hint">源码与预览双向同步</span>}</div>}
        {error && <div className="error-banner" role="alert">{error}<button aria-label="关闭错误提示" onClick={() => setError('')}>×</button></div>}
        {pendingDraft && <div className="recovery-banner" role="dialog" aria-label="恢复草稿"><strong>发现未完成草稿：{pendingDraft.name}</strong><span>恢复为应用副本，可另存；原文件不会被覆盖。</span><button onClick={() => void recover(true)}>恢复草稿</button><button onClick={() => void recover(false)}>放弃草稿</button></div>}
        {images.busy && <div className="recovery-banner" role="status">正在处理图片…<button onClick={images.cancel}>取消任务</button></div>}
        <div className={`content-grid view-${reading ? 'reading' : view}`} inert={disabled} onWheelCapture={(event) => { scrollOwner.current = (event.target as HTMLElement).closest('.preview') ? 'preview' : 'source'; expectedPreview.current = null }} onPointerDownCapture={(event) => { scrollOwner.current = (event.target as HTMLElement).closest('.preview') ? 'preview' : 'source'; expectedPreview.current = null }} onKeyDownCapture={(event) => { scrollOwner.current = (event.target as HTMLElement).closest('.preview') ? 'preview' : 'source'; expectedPreview.current = null }}>
          <div className="source-pane" hidden={reading} inert={reading}><Editor key={epoch} ref={editor} initialText={text} onChange={changed} onScroll={syncPreview} onCodeLanguage={(language) => { if (language !== null) setCodeLanguage(language) }} onSave={() => void save()} onImages={(files) => void images.importFiles(files)} onClipboardFiles={() => void importClipboardImages()} onWorkspaceImage={(image) => void importWorkspaceImage(image)} onCommand={(kind) => kind === 'image' ? imagePicker.current?.click() : command(kind as Command)} /></div>
          {(view === 'split' || reading) && <article ref={preview} className="preview" aria-label="Markdown 预览" onScroll={syncSource} onLoadCapture={() => syncPreview(sourceScroll.current, true)} onDoubleClick={(event) => {
            if (reading) return
            const node = (event.target as HTMLElement).closest<HTMLImageElement>('img[data-source-from]')
            const reference = parsed.images.find((item) => item.from === Number(node?.dataset.sourceFrom))
            if (reference && parsedText.current === text) void images.edit(reference)
          }} onClick={(event) => {
            const target = event.target as HTMLElement
            if (target.closest('a')) event.preventDefault()
            const node = target.closest<HTMLElement>('[data-source-from]')
            if (!reading && parsedText.current === text && node?.dataset.sourceFrom) jumpTo(Number(node.dataset.sourceFrom))
          }} dangerouslySetInnerHTML={{ __html: parsed.html }} />}
        </div>
        <div className="statusbar" role="status"><span className={`status-dot ${dirty ? 'dirty' : 'saved'}`} />{status}<span className="status-separator" />{snapshot.encoding.toUpperCase()} · {snapshot.lineEnding.toUpperCase()} · {statistics.lines} 行 · <span title="Markdown 源文字符数，不含空白；emoji 按一个 Unicode 字符计数">{statistics.characters} 字</span><span className="status-spacer" />{draftStatus}</div>
      </main>
      {showOutline && <ResizableSidebar side="right"><div className="sidebar-heading"><h2>文档大纲</h2><button className="icon-button" aria-label="收起大纲" onClick={() => setShowOutline(false)}>›</button></div><nav className="outline">{parsed.headings.map((heading) => <button key={heading.offset} className={`outline-item level-${heading.level}`} title={heading.title} onClick={() => jumpTo(heading.offset)}>{heading.title}</button>)}</nav>{!parsed.headings.length && <div className="outline-empty"><div className="empty-icon">⌁</div><strong>尚无标题</strong><p>输入 # 标题创建大纲，点击标题可跳转到正文。</p></div>}</ResizableSidebar>}
    </div>
  </div>
}
