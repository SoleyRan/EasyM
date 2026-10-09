import { useEffect, useRef, useState } from 'react'
import { prefixLines, replaceSelection, wrapSelection } from './core/document'
import { blankSnapshot, decodeFile, encodeFile, type FileSnapshot } from './core/codec'
import { parseDocument } from './core/markdown'
import { Editor, type EditorHandle } from './editor/Editor'
import { desktop, openDocument, saveDocument, readImage, reloadDocument, materializeResources } from './platform/storage'
import { drafts, type Draft } from './platform/drafts'
import { ImagePanel } from './editor/ImagePanel'
import { useImages } from './editor/useImages'
import { emptyResources } from './platform/images'
import { listenForClose, closeWindow } from './platform/window'
import { CloseDialog } from './editor/CloseDialog'
import { usePreview } from './editor/usePreview'
import { WorkspaceTree } from './editor/WorkspaceTree'
import { openWorkspace, listWorkspace, openWorkspaceDocument, readWorkspaceImage, type Workspace, type WorkspaceImage } from './platform/workspace'
import type { OpenedFile } from './platform/storage'
import { readClipboardImageFiles } from './platform/clipboard'

type ViewMode = 'source' | 'split'
type Command = 'bold' | 'italic' | 'quote' | 'bullet' | 'task' | 'heading' | 'ordered' | 'code' | 'link'
const initialText = '# 欢迎使用 EasyM\n\n本地优先的 Markdown 编辑器。\n\n## 开始写作\n\n使用左侧「打开文件」导入 Markdown，或创建新文档。使用「分屏」查看预览，点击右侧大纲跳转到标题。\n\n- 使用工具栏或快捷键修改当前选区\n- 粘贴、拖入或选择 PNG/JPEG 图片\n- 双击预览图片，编辑当前图片的副本\n\n> 编辑后记得保存；再次打开时可恢复未完成的草稿。'

function errorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error)
  const labels: Record<string, string> = {
    revision_conflict: '文件已被外部修改。请重新打开外部版本，或将本地内容另存为冲突副本。',
    permission_denied: '没有文件访问权限，请重新选择文件。',
    quota_exceeded: '文件超过当前资源限制，请缩小文件后重试。',
    resource_missing: '文件或资源已被移动，请重新选择。',
    io_failed: '写入失败，本地编辑和草稿仍保留，请重试或另存。',
    clipboard_busy: '剪贴板正在被其他程序使用，请稍后重新粘贴。',
    multiple_clipboard_images: '请每次复制并粘贴一张 PNG/JPEG 图片。',
  }
  return labels[value] ?? value
}

export default function App() {
  const [text, setText] = useState(initialText)
  const [view, setView] = useState<ViewMode>('source')
  const [name, setName] = useState('未命名.md')
  const [fileId, setFileId] = useState<string | null>(null)
  const [revision, setRevision] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<FileSnapshot>(blankSnapshot)
  const [epoch, setEpoch] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('准备就绪')
  const [draftStatus, setDraftStatus] = useState('')
  const [error, setError] = useState('')
  const [pendingDraft, setPendingDraft] = useState<Draft | null>(null)
  const [draftReady, setDraftReady] = useState(false)
  const [focus, setFocus] = useState(false)
  const [showFiles, setShowFiles] = useState(true)
  const [showOutline, setShowOutline] = useState(true)
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [workspacePath, setWorkspacePath] = useState<string | null>(null)
  const [treeRevision, setTreeRevision] = useState(0)
  const [exitRequested, setExitRequested] = useState(false)
  const [exitBusy, setExitBusy] = useState(false)
  const editor = useRef<EditorHandle>(null)
  const preview = useRef<HTMLElement>(null)
  const changeRevision = useRef(0)
  const saving = useRef(false)
  const panelApplying = useRef(false)
  const draftQueue = useRef(Promise.resolve<unknown>(undefined))
  const draftTimer = useRef<number | undefined>(undefined)
  const draftGeneration = useRef(0)
  const flushDraft = useRef<() => void>(() => undefined)
  const { parsed, parsedText } = usePreview(text, setError)
  const imagePicker = useRef<HTMLInputElement>(null)
  function openedResources(body: string, instances = images.resources.instances) {
    const paths = new Set(parseDocument(body).images.map((item) => item.url))
    return { assets: {}, instances: instances.filter((item) => paths.has(item.displayPath)) }
  }
  const images = useImages({
    text, fileId, blocked: busy || exitRequested || !!pendingDraft || !draftReady || !!editor.current?.composing(),
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
  const requestExit = useRef<() => void>(() => undefined)
  requestExit.current = () => {
    if (busy || images.busy || images.applying || panelApplying.current || !draftReady || exitBusy) {
      setError('正在处理或保存，请等待完成后再关闭窗口。'); return
    }
    if (dirty || images.session) setExitRequested(true)
    else void closeWindow().catch((err) => setError(errorMessage(err)))
  }

  useEffect(() => {
    let disposed = false
    let stop: (() => void) | undefined
    listenForClose(() => requestExit.current()).then((unlisten) => { if (disposed) unlisten(); else stop = unlisten })
      .catch((err) => setError(`无法注册关闭保护：${errorMessage(err)}`))
    return () => { disposed = true; stop?.() }
  }, [])

  async function clearDraft() {
    draftGeneration.current++
    window.clearTimeout(draftTimer.current)
    await draftQueue.current.catch(() => undefined)
    await drafts.clear()
    setDraftStatus('')
  }

  function enqueueDraft(): Promise<unknown> {
    const generation = draftGeneration.current
    const current: Draft = { version: 1, name, text, snapshot, resources: images.resources, imageSession: images.session, fileId, baseRevision: revision, updatedAt: Date.now() }
    const hasLocalChanges = dirty || !!images.session
    draftQueue.current = draftQueue.current.catch(() => undefined).then(async () => {
      if (generation !== draftGeneration.current || !hasLocalChanges) return
      let resourceError: unknown
      try { current.resources = await materializeResources(fileId, current.resources ?? emptyResources()) } catch (err) { resourceError = err }
      if (generation !== draftGeneration.current) return
      await drafts.save(current)
      if (resourceError) throw new Error(`正文草稿已保存，但图片副本不完整：${errorMessage(resourceError)}`)
    })
    return draftQueue.current
  }

  flushDraft.current = () => {
    if (!draftReady || pendingDraft || (!dirty && !images.session) || images.busy || images.applying || panelApplying.current || busy || exitBusy) return
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

  async function finishExit(saveFile: boolean) {
    if (exitBusy) return
    setExitBusy(true); setError('')
    window.clearTimeout(draftTimer.current)
    try {
      if (saveFile) { if (!await save()) return }
      else { await enqueueDraft(); setDraftStatus('草稿已保存') }
      await closeWindow()
    } catch (err) { setError(`退出已取消：${errorMessage(err)}`) }
    finally { setExitBusy(false) }
  }

  useEffect(() => {
    let alive = true
    drafts.load().then((draft) => { if (alive && draft) setPendingDraft(draft) })
      .catch((err) => { if (alive) setError(errorMessage(err)) })
      .finally(() => { if (alive) setDraftReady(true) })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!draftReady || pendingDraft || (!dirty && !images.session) || images.applying) return
    setDraftStatus('草稿待保存')
    draftTimer.current = window.setTimeout(() => {
      const version = changeRevision.current
      enqueueDraft().then(() => { if (version === changeRevision.current) setDraftStatus('草稿已保存') })
        .catch((err) => { setDraftStatus('草稿保存失败'); setError(errorMessage(err)) })
    }, 700)
    return () => window.clearTimeout(draftTimer.current)
  }, [text, name, snapshot, dirty, draftReady, pendingDraft, images.resources, images.session, images.applying, fileId, revision])

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => { if (!desktop && (dirty || images.session)) event.preventDefault() }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty, images.session])

  useEffect(() => {
    if (!preview.current || view !== 'split') return
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
  }, [parsed.html, fileId, view, images.resources])

  function changed(next: string) {
    changeRevision.current++
    setText(next)
    setDirty(true)
    setStatus('正文未保存')
  }

  function load(nextText: string, nextName: string, nextSnapshot: FileSnapshot, id: string | null, baseRevision: string | null, modified = false) {
    draftGeneration.current++
    changeRevision.current++
    setText(nextText); setName(nextName); setSnapshot(nextSnapshot); setFileId(id); setRevision(baseRevision)
    setEpoch((value) => value + 1); setDirty(modified); setError(''); setDraftStatus('')
    setWorkspacePath(null)
    setStatus(modified ? '恢复到草稿，请另存以保留原文件' : '文件已打开')
    images.setResources(emptyResources()); images.setSession(null); parsedText.current = ''
  }

  function mayReplace(): boolean {
    if (pendingDraft || !draftReady) return false
    return !dirty || window.confirm('当前正文未写入文件。继续将替换当前编辑内容；请先保存或下载副本。')
  }

  async function open(read: () => Promise<OpenedFile | null> = openDocument, path: string | null = null) {
    if (busy || !mayReplace()) return
    setBusy(true)
    try {
      const file = await read()
      if (!file) return
      const decoded = decodeFile(file.bytes)
      await clearDraft()
      load(decoded.text, file.name, decoded, file.id, file.revision)
      setWorkspacePath(path)
      images.setResources(openedResources(decoded.text, file.metadata?.instances ?? [])); if (file.warning && parseDocument(decoded.text).images.length) setError(errorMessage(file.warning))
    } catch (err) { setError(errorMessage(err)) }
    finally { setBusy(false) }
  }

  async function chooseWorkspace(refresh = false) {
    if (disabled) return
    setBusy(true)
    try {
      const next = refresh && workspace ? { ...workspace, entries: await listWorkspace(workspace.id) } : await openWorkspace()
      if (next) { setWorkspace(next); setWorkspacePath(null); setTreeRevision((value) => value + 1) }
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

  async function save(saveAs = false): Promise<boolean> {
    if (saving.current || pendingDraft || !draftReady || images.busy || images.session) return false
    saving.current = true; setBusy(true); setError(''); setStatus('正在保存…')
    const savingRevision = changeRevision.current
    const savingText = text
    try {
      const mixed = snapshot.lineEnding === 'mixed' && text !== snapshot.originalText
      if (mixed && !window.confirm('该文件混合使用 LF/CRLF。修改后需统一为 LF；是否继续保存？')) { setStatus('保存已取消'); return false }
      const bytes = encodeFile(snapshot, savingText, mixed ? 'lf' : undefined)
      const result = await saveDocument({ id: fileId, name, revision }, bytes, saveAs, images.resources)
      if (!result) { setStatus('保存已取消'); return false }
      setFileId(result.id); setName(result.name); setRevision(result.revision); setSnapshot(decodeFile(bytes))
      if (result.warning) setError(errorMessage(result.warning))
      if (savingRevision === changeRevision.current) {
        if (result.destination === 'disk') {
          setDirty(false)
          await clearDraft()
        }
        setStatus(result.destination === 'disk' ? '文件已保存' : '已生成下载副本；确认下载完成后保留它')
      } else setStatus('已保存上一版本，当前编辑尚未保存')
      return result.destination === 'disk' && savingRevision === changeRevision.current
    } catch (err) { setStatus('保存失败'); setError(errorMessage(err)); return false }
    finally { saving.current = false; setBusy(false) }
  }

  function command(kind: Command) {
    if (disabled || editor.current?.composing()) return
    const selection = editor.current?.selection() ?? { anchor: 0, head: 0 }
    const current = changeRevision.current
    const result = kind === 'bold' || kind === 'italic' ? wrapSelection(current, text, selection, kind === 'bold' ? '**' : '*')
      : kind === 'code' ? replaceSelection(current, selection, `\n\`\`\`\n${text.slice(Math.min(selection.anchor, selection.head), Math.max(selection.anchor, selection.head))}\n\`\`\`\n`)
      : kind === 'link' ? replaceSelection(current, selection, `[${text.slice(Math.min(selection.anchor, selection.head), Math.max(selection.anchor, selection.head)) || '链接文字'}](https://example.com)`)
      : prefixLines(current, text, selection, { heading: '## ', quote: '> ', bullet: '- ', task: '- [ ] ', ordered: '1. ' }[kind])
    if (result.baseTextRevision === changeRevision.current) editor.current?.patch(result.patches, result.selection)
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

  const disabled = busy || exitRequested || !!pendingDraft || !draftReady || images.busy || !!images.session
  const shortcuts = navigator.platform.includes('Mac') ? '⌘S' : 'Ctrl+S'
  const commands: Array<[Command, string, string]> = [['bold', 'B', '加粗'], ['italic', 'I', '斜体'], ['heading', 'H', '标题'], ['bullet', '☷', '无序列表'], ['ordered', '1.', '有序列表'], ['task', '☑', '任务列表'], ['quote', '❞', '引用'], ['code', '{ }', '代码块'], ['link', '↗', '链接']]

  return <div className={`app-shell ${focus ? 'focus-mode' : ''}`}>
    <input hidden ref={imagePicker} type="file" accept="image/png,image/jpeg" onChange={(event) => { void images.importFiles(Array.from(event.target.files ?? [])); event.target.value = '' }} />
    {images.session && <ImagePanel key={images.session.instance.instanceId} image={images.session} onBusy={(value) => { panelApplying.current = value }} onCancel={() => { images.cancel(); if (!dirty) void clearDraft().catch((err) => setError(errorMessage(err))) }} onChange={images.update} onApply={images.apply} />}
    {exitRequested && <CloseDialog error={error} busy={exitBusy} pendingImage={!!images.session} onSave={() => void finishExit(true)} onRetain={() => void finishExit(false)} onCancel={() => setExitRequested(false)} />}
    <header className="topbar">
      <div className="brand"><span className="brand-mark">M</span><strong>Easy Markdown</strong></div>
      <div className="breadcrumb">{desktop ? workspacePath ? workspace?.name : '本地文档' : '开发预览'} <span>/</span> {workspacePath ?? name}</div>
      <div className="top-actions"><span className="workspace-badge">v0.1 开发版</span><button disabled={disabled} className="primary-button" onClick={() => void save()}>{desktop ? '保存' : '下载 Markdown'} <span>{shortcuts}</span></button></div>
    </header>
    <div className="workspace">
      {showFiles && <aside className="sidebar left-sidebar">
        <div className="sidebar-heading"><h2>文档</h2><button className="icon-button" aria-label="收起文件栏" onClick={() => setShowFiles(false)}>‹</button></div>
        <button className="quick-row" disabled={disabled} onClick={() => void open()}>↗ <span>打开文件</span></button>
        {desktop && <button className="quick-row" disabled={disabled} onClick={() => void chooseWorkspace()}>▤ <span>打开工作区</span></button>}
        {workspace && <button className="quick-row" disabled={disabled} onClick={() => void chooseWorkspace(true)}>⟳ <span>刷新文件树</span></button>}
        {desktop && fileId && <button className="quick-row" disabled={disabled} onClick={() => void reloadExternal()}>⟳ <span>重新加载外部版本</span></button>}
        <button className="quick-row" disabled={disabled} onClick={() => { if (mayReplace()) load('', '未命名.md', blankSnapshot(), null, null, true) }}>＋ <span>新建文档</span></button>
        <button className="quick-row" disabled={disabled} onClick={() => void save(true)}>↧ <span>{desktop ? '另存为 / 冲突副本' : '下载副本'}</span></button>
        <div className="sidebar-label">当前文件</div><div className="file-row active">□ {name}{dirty ? ' ·' : ''}</div>
        {workspace && <WorkspaceTree key={treeRevision} workspace={workspace} disabled={disabled} selected={workspacePath} onOpen={(path) => void open(() => openWorkspaceDocument(workspace.id, path), path)} onImage={(image) => void importWorkspaceImage(image)} onError={(message) => setError(errorMessage(message))} />}
        <div className="outline-empty"><strong>原文保持，文件自由</strong><p>预览来自 Markdown。打开未编辑文件再保存时，保留原始字节、BOM 和换行。</p><p>{desktop ? '系统对话框授予当前文件的访问权限。' : '浏览器预览编辑应用副本，下载不会自动覆盖原文件。'}</p></div>
        <div className="sidebar-footer"><span>本地优先</span><span className="version">v0.1.0-dev</span></div>
      </aside>}
      {!showFiles && <button className="reopen-sidebar left-reopen" aria-label="展开文件栏" onClick={() => setShowFiles(true)}>›</button>}
      <main className="editor-area">
        <div className="document-tabs"><div className="tab active"><span className="tab-dot" />{name}{dirty && ' *'}</div></div>
        <div className="view-switcher"><div className="view-tabs"><button className={view === 'source' ? 'selected' : ''} onClick={() => setView('source')}>源码</button><button className={view === 'split' ? 'selected' : ''} onClick={() => setView('split')}>分屏</button><button disabled title="尚未通过中文输入与光标验证">即时渲染 · 待验证</button></div><button className="focus-button" onClick={() => setFocus(!focus)}>{focus ? '退出专注' : '专注模式'}</button></div>
        <div className="toolbar">{commands.map(([kind, label, title]) => <button key={kind} disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={() => command(kind)} title={title} aria-label={title}>{label}</button>)}<span className="toolbar-divider" /><button title="插入 PNG/JPEG 图片" aria-label="插入图片" disabled={disabled} onClick={() => imagePicker.current?.click()}>▣</button><button aria-label="撤销" disabled={disabled} onClick={() => editor.current?.undo()}>↶</button><button aria-label="重做" disabled={disabled} onClick={() => editor.current?.redo()}>↷</button></div>
        {error && <div className="error-banner" role="alert">{error}<button aria-label="关闭错误提示" onClick={() => setError('')}>×</button></div>}
        {pendingDraft && <div className="recovery-banner" role="dialog" aria-label="恢复草稿"><strong>发现未完成草稿：{pendingDraft.name}</strong><span>恢复为应用副本，可另存；原文件不会被覆盖。</span><button onClick={() => void recover(true)}>恢复草稿</button><button onClick={() => void recover(false)}>放弃草稿</button></div>}
        {images.busy && <div className="recovery-banner" role="status">正在处理图片…<button onClick={images.cancel}>取消任务</button></div>}
        <div className={`content-grid view-${view}`} inert={disabled}>
          <Editor key={epoch} ref={editor} initialText={text} onChange={changed} onSave={() => void save()} onImages={(files) => void images.importFiles(files)} onClipboardFiles={() => void importClipboardImages()} onWorkspaceImage={(image) => void importWorkspaceImage(image)} onCommand={(kind) => kind === 'image' ? imagePicker.current?.click() : command(kind as Command)} />
          {view === 'split' && <article ref={preview} className="preview" aria-label="Markdown 预览" onDoubleClick={(event) => {
            const node = (event.target as HTMLElement).closest<HTMLImageElement>('img[data-source-from]')
            const reference = parsed.images.find((item) => item.from === Number(node?.dataset.sourceFrom))
            if (reference && parsedText.current === text) void images.edit(reference)
          }} onClick={(event) => {
            const target = event.target as HTMLElement
            if (target.closest('a')) event.preventDefault()
            const node = target.closest<HTMLElement>('[data-source-from]')
            if (parsedText.current === text && node?.dataset.sourceFrom) editor.current?.jump(Number(node.dataset.sourceFrom))
          }} dangerouslySetInnerHTML={{ __html: parsed.html }} />}
        </div>
        <div className="statusbar" role="status"><span className={`status-dot ${dirty ? 'dirty' : 'saved'}`} />{status}<span className="status-separator" />{snapshot.encoding.toUpperCase()} · {snapshot.lineEnding.toUpperCase()} · {text.split('\n').length} 行<span className="status-spacer" />{draftStatus}</div>
      </main>
      {showOutline && <aside className="sidebar right-sidebar"><div className="sidebar-heading"><h2>文档大纲</h2><button className="icon-button" aria-label="收起大纲" onClick={() => setShowOutline(false)}>›</button></div><nav className="outline">{parsed.headings.map((heading) => <button key={heading.offset} className={`outline-item level-${heading.level}`} onClick={() => editor.current?.jump(heading.offset)}>{heading.title}</button>)}</nav>{!parsed.headings.length && <div className="outline-empty"><div className="empty-icon">⌁</div><strong>尚无标题</strong><p>输入 # 标题创建大纲，点击标题可跳转到正文。</p></div>}</aside>}
      {!showOutline && <button className="reopen-sidebar right-reopen" aria-label="展开大纲" onClick={() => setShowOutline(true)}>‹</button>}
    </div>
  </div>
}
