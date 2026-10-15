import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import DocumentEditor, { type DocumentHandle, type DocumentSummary, type FileAction } from './editor/DocumentEditor'
import { CloseDialog } from './editor/CloseDialog'
import { TemplateDialog } from './editor/TemplateDialog'
import type { NewDocument } from './core/templates'
import { listenForClose, closeWindow, minimizeWindow, toggleMaximizeWindow, dragWindow, windowState, setFullscreen, listenWindowState } from './platform/window'
import { drafts } from './platform/drafts'
import { loadSession, saveSession, MAX_SESSION_TABS } from './platform/session'
import { releaseDocument, type OpenedFile } from './platform/storage'
import type { Workspace, WorkspaceLocation } from './platform/workspace'
import { desktop } from './platform/storage'
import { ContextMenuProvider, useContextMenu } from './editor/ContextMenu'
import { SettingsDialog, GuideDialog } from './editor/ApplicationDialogs'
import { type Appearance, type Theme, defaultAppearance, loadAppearance, saveAppearance, appearanceTheme, storedPreference, needsGuide, completeGuide } from './platform/preferences'
import { OverlayProvider, OverlayHost, PositionedOverlay, useOverlays } from './editor/Overlay'
import type { OverlayLease } from './core/overlays'
import { CommandRegistry, commandDefinitions, type CommandContext } from './core/commands'
import type { CSSProperties } from 'react'
import { CommandPalette, QuickOpen } from './editor/QuickEntry'
import { openWorkspaceDocument } from './platform/workspace'
import { decodeFile } from './core/codec'
import { RecentDialog } from './editor/RecentDialog'
import { recentState, rememberSession, reopenRecentFile, reopenRecentWorkspace, recentError, type RecentState, type RecentEntry } from './platform/recent'
import { planRestoration } from './platform/restore-session'
import { loadMathRendering, saveMathRendering } from './platform/preferences'

interface Tab { id: string; draftKey: string; restoredName?: string; file?: OpenedFile; blank?: boolean; seed?: NewDocument; path?: string | null; location?: WorkspaceLocation }
const first: Tab = { id: 'current', draftKey: 'current' }

export default function App() {
  return <OverlayProvider><ContextMenuProvider><Application /></ContextMenuProvider></OverlayProvider>
}

function Application() {
  const contextMenu = useContextMenu()
  const { manager } = useOverlays()
  const menuLease = useRef<OverlayLease | null>(null)
  const exportLease = useRef<OverlayLease | null>(null)
  const menuSurface = useRef<HTMLDivElement>(null)
  const exportSurface = useRef<HTMLDivElement>(null)
  const [tabs, setTabs] = useState<Tab[]>([first])
  const [active, setActive] = useState(first.id)
  const [sessionReady, setSessionReady] = useState(false)
  const sessionWritable = useRef(false)
  const nativeSessionWritable = useRef(false), nativeSessionQueue = useRef(Promise.resolve())
  const nativeSessionValue = useRef('')
  const startupQueue = useRef(Promise.resolve())
  const [summaries, setSummaries] = useState<Record<string, DocumentSummary>>({})
  const handles = useRef(new Map<string, DocumentHandle>())
  const [closing, setClosing] = useState<string[] | 'window' | null>(null)
  const [closeBusy, setCloseBusy] = useState(false)
  const closeOperation = useRef(false)
  const [error, setError] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [templateOpen, setTemplateOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [recentOpen, setRecentOpen] = useState(false)
  const [guideOpen, setGuideOpen] = useState(needsGuide)
  const [appearance, setAppearance] = useState(loadAppearance)
  const [mathRendering, setMathRendering] = useState(loadMathRendering)
  const updateMathRendering = (enabled: boolean) => {
    setMathRendering(enabled)
    if (!saveMathRendering(enabled)) setError('无法保存公式设置，当前会话仍可使用。')
  }
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)
  const theme = appearanceTheme(appearance, systemDark), fontSize = appearance.fontSize
  const updateAppearance = (patch: Partial<Appearance>) => setAppearance(current => ({ ...current, ...patch }))
  const setTheme = (value: Theme) => updateAppearance(appearance.followSystem ? systemDark ? { darkTheme: value } : { lightTheme: value } : { theme: value })
  const showToolbar = appearance.toolbar, showSelectionTools = appearance.selectionTools
  const setShowToolbar = (value: boolean) => updateAppearance({ toolbar: value })
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!query) return
    const update = () => setSystemDark(query.matches)
    update(); query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  const initialAppearance = useRef(appearance)
  useEffect(() => {
    if (appearance !== initialAppearance.current && !saveAppearance(appearance)) setError('无法保存外观设置，当前会话仍可使用。')
  }, [appearance])
  const previousGuideVersion = useRef(storedPreference('easym-guide-version'))
  const appModal = settingsOpen || guideOpen || recentOpen
  const appModalRef = useRef(false)
  appModalRef.current = appModal
  function closeApplicationDialog() {
    if (guideOpen) {
      if (!completeGuide()) setError('无法保存导引记录，下次启动可能再次显示。')
      setGuideOpen(false)
    } else setSettingsOpen(false)
    requestAnimationFrame(() => menu.current?.querySelector<HTMLButtonElement>('.app-menu-trigger')?.focus())
  }
  const restoreTemplateFocus = useRef(false)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [quickEntry, setQuickEntry] = useState<{ kind: 'commands' | 'open'; context: CommandContext } | null>(null)
  const quickEntryRef = useRef(quickEntry); quickEntryRef.current = quickEntry
  const quickGeneration = useRef(0), quickOpening = useRef(false)
  const [quickBusy, setQuickBusy] = useState(false), [quickError, setQuickError] = useState('')
  const closeQuickEntry = () => { quickGeneration.current++; quickOpening.current = false; setQuickBusy(false); setQuickEntry(null) }
  useEffect(() => { if (quickEntry) closeQuickEntry() }, [active, workspace?.id])
  const [showFiles, setShowFiles] = useState(false)
  const [reading, setReading] = useState(false)
  const [windowBusy, setWindowBusy] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const readingRef = useRef(false)
  const windowOperation = useRef(false)
  const previousFullscreen = useRef(false)
  const readingFocus = useRef<HTMLElement | null>(null)
  const restoreReadingFocus = useRef(false)
  const menu = useRef<HTMLDivElement>(null)
  const tablist = useRef<HTMLDivElement>(null)
  const report = useCallback((id: string, summary: DocumentSummary, handle: DocumentHandle) => {
    handles.current.set(id, handle)
    setSummaries((previous) => JSON.stringify(previous[id]) === JSON.stringify(summary) ? previous : { ...previous, [id]: summary })
  }, [])
  async function toggleReading(next: boolean) {
    if (windowOperation.current || next === readingRef.current) return
    windowOperation.current = true; setWindowBusy(true); setMenuOpen(false)
    try {
      if (next) {
        readingFocus.current = document.activeElement as HTMLElement
        previousFullscreen.current = (await windowState()).fullscreen
        await setFullscreen(true)
      } else await setFullscreen(previousFullscreen.current)
      readingRef.current = next; restoreReadingFocus.current = true; setReading(next)
    } catch (err) { setError(`切换阅读模式失败：${String(err)}`) }
    finally { windowOperation.current = false; setWindowBusy(false) }
  }
  const exitReading = useRef(() => undefined as void)
  useEffect(() => {
    if (!restoreReadingFocus.current) return
    restoreReadingFocus.current = false
    if (reading) document.querySelector<HTMLButtonElement>('.document-panel:not([hidden]) .reading-button')?.focus()
    else if (readingFocus.current?.isConnected) readingFocus.current.focus()
    else document.querySelector<HTMLButtonElement>('.app-menu-trigger')?.focus()
  }, [reading])
  exitReading.current = () => { void toggleReading(false) }
  useEffect(() => {
    let disposed = false; let stop: (() => void) | undefined
    const update = () => { void windowState().then((state) => {
      if (disposed) return
      setMaximized(state.maximized)
      if (readingRef.current && !state.fullscreen && !windowOperation.current) { readingRef.current = false; restoreReadingFocus.current = true; setReading(false) }
    }).catch((err) => { if (!disposed) setError(String(err)) }) }
    update()
    listenWindowState(update).then((unlisten) => { if (disposed) unlisten(); else stop = unlisten }).catch((err) => { if (!disposed) setError(String(err)) })
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing && readingRef.current && !appModalRef.current) { event.preventDefault(); exitReading.current() }
    }
    window.addEventListener('keydown', escape)
    return () => { disposed = true; stop?.(); window.removeEventListener('keydown', escape) }
  }, [])
  useLayoutEffect(() => {
    if (!menuOpen) { menuLease.current?.release(); menuLease.current = null; setExportMenuOpen(false); return }
    menuLease.current = manager.open('menu', () => {
      setMenuOpen(false)
      if (!manager.top()) menu.current?.querySelector<HTMLButtonElement>('.app-menu-trigger')?.focus({ preventScroll: true })
    })
    if (!menuLease.current) { setMenuOpen(false); return }
    menuSurface.current?.querySelector<HTMLButtonElement>('[role^=menuitem]:not(:disabled)')?.focus()
    const outside = (event: PointerEvent) => { if (![menu.current, menuSurface.current, exportSurface.current].some(node => node?.contains(event.target as Node))) setMenuOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => { document.removeEventListener('pointerdown', outside); menuLease.current?.release() }
  }, [menuOpen, manager])
  useLayoutEffect(() => {
    if (!exportMenuOpen || !menuLease.current?.current()) return
    exportLease.current = manager.open('menu', () => {
      setExportMenuOpen(false)
      if (manager.top()?.id === menuLease.current?.id) menuSurface.current?.querySelector<HTMLButtonElement>('.export-menu-trigger')?.focus()
    }, menuLease.current.id)
    exportSurface.current?.querySelector<HTMLButtonElement>('[role=menuitem]:not(:disabled)')?.focus()
    return () => { exportLease.current?.release(); exportLease.current = null }
  }, [exportMenuOpen, manager])
  useEffect(() => {
    if (!templateOpen && restoreTemplateFocus.current) {
      restoreTemplateFocus.current = false
      menu.current?.querySelector<HTMLButtonElement>('.app-menu-trigger')?.focus()
    }
  }, [templateOpen])
  useEffect(() => {
    document.getElementById(`tab-${active}`)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [active])
  useEffect(() => {
    let alive = true
    const loaded = loadSession()
    startupQueue.current = startupQueue.current.then(async () => {
      if (!alive) return
      const messages: string[] = []
      let native: RecentState | null = null
      const [inventory, recent] = await Promise.allSettled([drafts.keys(), desktop ? recentState() : Promise.resolve(null)])
      if (!alive) return
      if (inventory.status === 'rejected') throw new Error(`无法读取草稿列表：${String(inventory.reason)}；会话索引已保留。`)
      if (recent.status === 'fulfilled') native = recent.value
      else messages.push(recentError(recent.reason))
      const restored = planRestoration(loaded.index, inventory.value, native)
      const next: Tab[] = []
      if (restored.workspaceId) {
        try { const workspace = await reopenRecentWorkspace(restored.workspaceId); if (!alive) return; setWorkspace(workspace); if (workspace.warning) messages.push(workspace.warning) }
        catch (err) { messages.push(`上次工作区：${recentError(err)}`) }
      }
      for (const tab of restored.tabs) {
        if (!alive) return
        if (tab.draft) next.push({ id: tab.draftKey, draftKey: tab.draftKey, restoredName: tab.name, blank: true })
        else if (tab.recentId) {
          let file: OpenedFile | null = null
          try {
            file = await reopenRecentFile(tab.recentId)
            if (!alive) { if (file.id) await releaseDocument(file.id).catch(() => undefined); return }
            decodeFile(file.bytes)
            if (file.warning) messages.push(file.warning)
            if (!next.some(item => item.file?.id === file!.id)) next.push({ id: tab.draftKey, draftKey: tab.draftKey, file })
          } catch (err) { if (file?.id) await releaseDocument(file.id).catch(() => undefined); messages.push(`${tab.name}：${recentError(err)}`) }
        }
      }
      if (!alive) return
      if (next.length) {
        const legacyWelcome = !loaded.index && !native?.session.tabs.length && !next.some(tab => tab.draftKey === 'current')
        setTabs([...(legacyWelcome ? [first] : []), ...next])
        setActive(legacyWelcome ? first.id : next.find(tab => tab.draftKey === restored.activeDraftKey)?.id ?? next[0].id)
      }
      if (restored.limited) messages.push('启动最多重开 20 个已保存文件；其余文件请通过最近打开访问。')
      sessionWritable.current = !loaded.error
      nativeSessionWritable.current = desktop && !!native
      if (loaded.error) messages.push(loaded.error)
      if (messages.length) setError(messages.join('\n'))
      setSessionReady(true)
    }).catch((err) => { if (alive) { setError(String(err)); setSessionReady(true) } })
    return () => { alive = false }
  }, [])
  useEffect(() => {
    if (!sessionReady || !sessionWritable.current) return
    try {
      if (tabs.length > MAX_SESSION_TABS) throw new Error('打开标签超过 100 个；草稿继续独立保存，会话索引未更新。')
      saveSession({ version: 1, tabs: tabs.map(tab => ({ draftKey: tab.draftKey, name: (summaries[tab.id]?.name ?? tab.restoredName ?? tab.file?.name ?? '未命名.md').slice(0, 512) })), activeDraftKey: tabs.find(tab => tab.id === active)?.draftKey ?? null })
    } catch (err) { setError(`无法保存会话索引：${String(err)}；正文与独立草稿不受影响。`) }
  }, [sessionReady, tabs, active, summaries])
  useEffect(() => {
    if (!sessionReady || !nativeSessionWritable.current || closing || closeBusy || tabs.some(tab => !summaries[tab.id] || summaries[tab.id].busy)) return
    const session = { tabs: tabs.map(tab => ({ draftKey: tab.draftKey, recentId: summaries[tab.id].recentId ?? null })), activeDraftKey: tabs.find(tab => tab.id === active)?.draftKey ?? null, workspaceId: workspace?.recentId ?? null }
    const value = JSON.stringify(session)
    if (nativeSessionValue.current === value) return
    nativeSessionValue.current = value
    const timer = window.setTimeout(() => {
      nativeSessionQueue.current = nativeSessionQueue.current.then(() => rememberSession(session)).catch(err => { nativeSessionValue.current = ''; setError(recentError(err)) })
    }, 150)
    return () => { window.clearTimeout(timer); if (nativeSessionValue.current === value) nativeSessionValue.current = '' }
  }, [sessionReady, tabs, active, summaries, workspace?.recentId, closing, closeBusy])
  const add = (file?: OpenedFile, path: string | null = null, nextWorkspace: Workspace | null = null, location?: WorkspaceLocation, seed?: NewDocument) => {
    if (nextWorkspace) setWorkspace(nextWorkspace)
    if (file?.id) {
      const existing = tabs.find((tab) => handles.current.get(tab.id)?.summary.fileId === file.id)
      if (existing) { setTabs(previous => previous.map(tab => tab.id === existing.id ? { ...tab, location } : tab)); setActive(existing.id); return }
    }
    const id = crypto.randomUUID()
    setTabs((previous) => [...previous, { id, draftKey: `document:${id}`, file, blank: !file, seed, path, location }])
    setActive(id)
  }
  const targetHandles = () => (closing === 'window' ? tabs.map(tab => tab.id) : closing ?? []).map(id => handles.current.get(id)).filter((handle): handle is DocumentHandle => !!handle)
  async function persistBeforeExit() {
    if (!nativeSessionWritable.current) return
    await nativeSessionQueue.current
    await rememberSession({ tabs: tabs.map(tab => ({ draftKey: tab.draftKey, recentId: handles.current.get(tab.id)?.summary.recentId ?? null })), activeDraftKey: tabs.find(tab => tab.id === active)?.draftKey ?? null, workspaceId: workspace?.recentId ?? null }).catch(err => setError(recentError(err)))
  }
  const remove = async (ids: string[], keepDraft: boolean) => {
    for (const id of ids) {
      const tab = tabs.find((tab) => tab.id === id)
      if (!keepDraft && tab) await drafts.clear(tab.draftKey)
      await releaseDocument(handles.current.get(id)?.summary.fileId ?? null)
    }
    ids.forEach(id => handles.current.delete(id))
    const remaining = tabs.filter((tab) => !ids.includes(tab.id))
    if (remaining.length) { setTabs(remaining); if (ids.includes(active)) setActive(remaining.at(-1)!.id) }
    else { const nextId = crypto.randomUUID(); setTabs([{ id: nextId, draftKey: `document:${nextId}`, blank: true }]); setActive(nextId) }
  }
  const requestClose = (id: string | string[] | 'window', prepared = false) => {
    if (!sessionReady || (appModal && !(id === 'window' && guideOpen))) return
    // The informational guide must not swallow an OS close request. Dismiss
    // it without acknowledging completion, then retain all document guards.
    if (id === 'window' && guideOpen) setGuideOpen(false)
    if (templateOpen) { cancelTemplate(); return }
    const ids = id === 'window' ? tabs.map(tab => tab.id) : Array.isArray(id) ? [...new Set(id)] : [id]
    if (!ids.length) return
    const targets = ids.map(target => handles.current.get(target)).filter((h): h is DocumentHandle => !!h)
    if (closing || closeBusy || closeOperation.current || targets.length !== ids.length || targets.some((handle) => handle.summary.busy || !handle.canLeave())) { setError('正在处理、输入或恢复草稿，请完成后再关闭。'); return }
    if (!prepared) { void (async () => { for (const handle of targets) if (handle.prepareLeave && !await handle.prepareLeave()) return; requestClose(id, true) })(); return }
    setError('')
    setMenuOpen(false)
    if (targets.some((handle) => handle.summary.dirty || handle.summary.pendingImage)) { setClosing(id === 'window' ? 'window' : ids); return }
    closeOperation.current = true; setCloseBusy(true)
    void (id === 'window' ? persistBeforeExit().then(closeWindow) : remove(ids, false)).catch((err) => setError(String(err))).finally(() => { closeOperation.current = false; setCloseBusy(false) })
  }
  const closeRequest = useRef(() => undefined as void); closeRequest.current = () => requestClose('window')
  useEffect(() => {
    let disposed = false; let stop: (() => void) | undefined
    listenForClose(() => closeRequest.current()).then((unlisten) => { if (disposed) unlisten(); else stop = unlisten }).catch((err) => setError(String(err)))
    return () => { disposed = true; stop?.() }
  }, [])
  async function finish(action: 'save' | 'retain' | 'discard') {
    if (!closing || closeBusy || closeOperation.current) return
    closeOperation.current = true; setCloseBusy(true); setError('')
    try {
      for (const handle of targetHandles()) {
        if (action === 'save' && handle.summary.dirty) { if (!await handle.save()) { setError(`${handle.summary.name} 保存未完成。返回编辑后查看该标签的提示；恢复中的草稿需先恢复再保存。`); return } }
        else if (action === 'retain') await handle.retain()
        else if (action === 'discard') await handle.discard()
      }
      if (closing === 'window') { await persistBeforeExit(); await closeWindow() }
      else await remove(closing, action !== 'save')
      setClosing(null)
    } catch (err) { if (action === 'discard') targetHandles().forEach((handle) => handle.resume()); setError(String(err)) }
    finally { closeOperation.current = false; setCloseBusy(false) }
  }
  function cancelTemplate() {
    restoreTemplateFocus.current = true
    setTemplateOpen(false)
  }
  const blocked = !sessionReady || appModal || templateOpen || closeBusy || !!closing || !summaries[active] || !!summaries[active]?.busy || !!summaries[active]?.pendingImage
  const appRuntime = useRef<{ context(): CommandContext; run(id: string): void; ready(): boolean }>(null!)
  const appCommands = useMemo(() => {
    const registry = new CommandRegistry(() => appRuntime.current.context())
    for (const definition of commandDefinitions.filter(item => item.id.startsWith('app.'))) registry.register({ ...definition,
      status: () => definition.id === 'app.recent' && !desktop ? { enabled: false, reason: '浏览器不支持记忆磁盘权限，请重新选择文件。' } : { enabled: appRuntime.current.ready(), reason: '请先完成当前文档操作。' }, run: () => appRuntime.current.run(definition.id) })
    return registry
  }, [])
  appRuntime.current = {
    context: () => handles.current.get(active)?.commandContext() ?? ({ documentId: active, fileId: summaries[active]?.fileId ?? null, textRevision: 0, selection: { anchor: 0, head: 0 }, active: true, reading, composing: false, lockReason: blocked ? '请先完成当前文档操作。' : undefined }),
    ready: () => sessionReady && !!handles.current.get(active)?.canEdit() && !Object.values(summaries).some(summary => summary.busy),
    run: commandId => {
      setMenuOpen(false)
      if (commandId === 'app.template') setTemplateOpen(true)
      else if (commandId === 'app.recent') { if (desktop) setRecentOpen(true); else setError('浏览器不能记忆磁盘权限，请使用打开文件重新选择；独立草稿仍可恢复。') }
      else if (commandId === 'app.commands' || commandId === 'app.quickOpen') { setQuickError(''); setQuickEntry({ kind: commandId === 'app.commands' ? 'commands' : 'open', context: appCommands.capture() }) }
      else setSettingsOpen(true)
    },
  }
  const executeApp = (commandId: string) => { const handle = handles.current.get(active); if (handle?.prepareLeave) { void handle.prepareLeave().then(proceed => { if (proceed) runApp(commandId) }); return } runApp(commandId) }
  const runApp = (commandId: string) => { void appCommands.execute(commandId).then(status => { if (!status.enabled) setError(status.reason ?? '操作暂不可用。') }).catch(err => setError(String(err))) }
  const quickRuntime = useRef({ blocked, executeApp }); quickRuntime.current = { blocked, executeApp }
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const id = event.key === 'F1' && !event.ctrlKey && !event.metaKey && !event.altKey ? 'app.commands' : (event.ctrlKey || event.metaKey) && event.altKey && !event.shiftKey && event.key.toLowerCase() === 'o' ? 'app.quickOpen' : null
      if (!id || event.defaultPrevented || event.isComposing || manager.modal() || quickEntryRef.current || quickRuntime.current.blocked) return
      event.preventDefault(); quickRuntime.current.executeApp(id)
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [manager])
  function chooseQuickCommand(commandId: string) {
    const session = quickEntryRef.current, handle = handles.current.get(active)
    if (!session || !handle) return
    const status = commandId.startsWith('app.') ? appCommands.status(commandId, session.context) : handle.commandStatus(commandId, session.context)
    if (!status.enabled) { setQuickError(status.reason ?? '操作暂不可用。'); return }
    closeQuickEntry()
    requestAnimationFrame(() => { if (commandId.startsWith('app.')) void appCommands.execute(commandId, undefined, session.context); else handle.execute(commandId, undefined, session.context) })
  }
  async function chooseQuickFile(target: { tabId: string } | { workspaceId: string; path: string }) {
    const session = quickEntryRef.current, handle = handles.current.get(active)
    if (!session || !handle || quickOpening.current) return
    if (!handle.commandStatus('file.open', session.context).enabled) { setQuickError('当前文档暂不可切换，请完成编辑或重新打开面板。'); return }
    if ('tabId' in target) { if (!tabs.some(tab => tab.id === target.tabId)) return; closeQuickEntry(); setActive(target.tabId); return }
    if (!desktop || workspace?.id !== target.workspaceId) return
    quickOpening.current = true; setQuickBusy(true); setQuickError('')
    const generation = ++quickGeneration.current
    let opened: OpenedFile | null = null, accepted = false
    try {
      opened = await openWorkspaceDocument(target.workspaceId, target.path)
      if (generation !== quickGeneration.current || quickEntryRef.current !== session) return
      if (!handle.commandStatus('file.open', session.context).enabled) throw new Error('目标文档或选区已变化，请重新打开面板。')
      decodeFile(opened.bytes)
      accepted = true; closeQuickEntry(); add(opened, target.path, workspace)
    } catch (err) { if (generation === quickGeneration.current) setQuickError(`打开文件失败：${String(err)}`) }
    finally {
      if (opened?.id && !accepted && ![...handles.current.values()].some(value => value.summary.fileId === opened!.id)) await releaseDocument(opened.id).catch(() => undefined)
      if (generation === quickGeneration.current) { quickOpening.current = false; setQuickBusy(false) }
    }
  }
  const fileAction = (action: FileAction) => {
    const handle = handles.current.get(active)
    if (blocked || !handle?.commandStatus('file.' + action).enabled) return
    setMenuOpen(false)
    handle.run(action)
  }
  async function openRecent(entry: RecentEntry, current: () => boolean) {
    const handle = handles.current.get(active), context = handle?.commandContext()
    if (!handle || !context || !handle.canLeave() || context.composing) throw new Error('请先完成当前文档操作。')
    const stillCurrent = () => current() && handles.current.get(active) === handle && handle.commandContext().textRevision === context.textRevision && !handle.commandContext().composing
    if (entry.kind === 'workspace') {
      const next = await reopenRecentWorkspace(entry.id)
      if (!stillCurrent()) return
      setWorkspace(next); setShowFiles(true); setRecentOpen(false)
      if (next.warning) setError(next.warning)
      return
    }
    let file: OpenedFile | null = null, accepted = false
    try {
      file = await reopenRecentFile(entry.id)
      if (!stillCurrent()) return
      decodeFile(file.bytes); accepted = true; add(file); setRecentOpen(false)
      if (file.warning) setError(file.warning)
    } finally { if (file?.id && !accepted && ![...handles.current.values()].some(handle => handle.summary.fileId === file!.id)) await releaseDocument(file.id).catch(() => undefined) }
  }
  return <div className={`application ${reading ? 'reading-mode' : ''}`} data-theme={theme} data-code-wrap={appearance.codeWrap} style={{ '--editor-font-size': `${fontSize}px`, '--body-line-height': appearance.lineHeight, '--content-width': appearance.contentWidth ? `${appearance.contentWidth}px` : '100%', '--code-font-size': `${appearance.codeFontSize}px` } as CSSProperties}>
    <div className="document-strip" hidden={reading} inert={templateOpen || appModal || !!summaries[active]?.tableDecision}>
      <div className="app-menu" ref={menu} onKeyDown={(event) => {
        const inExportMenu = !!(event.target as HTMLElement).closest('#export-menu')
        if ((inExportMenu && ['ArrowLeft', 'Escape'].includes(event.key)) || (event.key === 'Escape' && exportMenuOpen)) {
          event.preventDefault(); event.stopPropagation(); setExportMenuOpen(false); menuSurface.current?.querySelector<HTMLButtonElement>('.export-menu-trigger')?.focus(); return
        }
        if (event.key === 'ArrowRight' && (event.target as HTMLButtonElement).closest('.export-menu-trigger') && !(event.target as HTMLButtonElement).disabled) { event.preventDefault(); setExportMenuOpen(true); return }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenuOpen(false); menu.current?.querySelector<HTMLButtonElement>('.app-menu-trigger')?.focus() }
        if (menuOpen && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          const currentMenu = (event.target as HTMLElement).closest('[role=menu]') ?? menuSurface.current
          const items = Array.from(currentMenu?.querySelectorAll<HTMLButtonElement>('[role^=menuitem]:not(:disabled)') ?? []).filter((item) => item.closest('[role=menu]') === currentMenu)
          const index = items.indexOf(document.activeElement as HTMLButtonElement)
          items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
        }
        if (event.key === 'Tab') setMenuOpen(false)
      }}>
        <button className="app-menu-trigger brand-mark" aria-label="EM 菜单" title="EasyM · 文件菜单" aria-haspopup="menu" aria-expanded={menuOpen} aria-controls="file-menu" disabled={closeBusy || !!closing} onClick={() => setMenuOpen(!menuOpen)}>EM</button>
        {menuOpen && <PositionedOverlay className="file-menu" id="file-menu" label="文件菜单" element={menuSurface} lease={menuLease} anchor={() => menu.current?.querySelector('.app-menu-trigger')?.getBoundingClientRect() ?? null}>
          <button role="menuitem" disabled={blocked || !handles.current.get(active)?.commandStatus('file.new').enabled} onClick={() => fileAction('new')}>新建文档</button>
          <button role="menuitem" disabled={blocked || !handles.current.get(active)?.canEdit()} onClick={() => executeApp('app.template')}>从模板新建</button>
          <button role="menuitem" disabled={blocked || !handles.current.get(active)?.commandStatus('file.open').enabled} onClick={() => fileAction('open')}>打开文件</button>
          <button role="menuitem" disabled={blocked || !handles.current.get(active)?.commandStatus('file.workspace').enabled} onClick={() => fileAction('workspace')}>打开工作区</button>
          <button role="menuitem" title={desktop ? '重开最近的文件或工作区' : '浏览器不支持记忆磁盘权限，请重新选择文件'} disabled={blocked || !desktop} onClick={() => executeApp('app.recent')}>最近打开</button>
          <button role="menuitem" disabled={blocked || !appCommands.status('app.quickOpen').enabled} onClick={() => executeApp('app.quickOpen')}>快速打开 <kbd>Ctrl/⌘+Alt+O</kbd></button>
          <button role="menuitem" disabled={blocked || !appCommands.status('app.commands').enabled} onClick={() => executeApp('app.commands')}>命令面板 <kbd>F1</kbd></button>
          <div className="menu-divider" role="separator" />
          <button role="menuitem" disabled={blocked || !handles.current.get(active)?.canEdit()} onClick={() => fileAction('saveAs')}>{desktop ? '另存为 / 冲突副本' : '下载副本'}</button>
          <button role="menuitem" disabled={blocked || !desktop || !summaries[active]?.fileId || !handles.current.get(active)?.canEdit()} onClick={() => fileAction('reload')}>重新加载外部版本</button>
          <div className="export-menu">
            <button className="export-menu-trigger" role="menuitem" aria-label="导出" aria-haspopup="menu" aria-expanded={exportMenuOpen} aria-controls="export-menu" disabled={blocked || !handles.current.get(active)?.canEdit()} onClick={() => setExportMenuOpen(!exportMenuOpen)}>导出 <span aria-hidden="true">›</span></button>
            {exportMenuOpen && <PositionedOverlay className="file-menu export-submenu" id="export-menu" label="导出格式" element={exportSurface} lease={exportLease} side="right" anchor={() => {
              const row = menuSurface.current?.querySelector('.export-menu-trigger')?.getBoundingClientRect()
              const parent = menuSurface.current?.getBoundingClientRect()
              return row && parent ? new DOMRect(row.left, row.top, parent.right - row.left, row.height) : null
            }}>
              <button role="menuitem" disabled={blocked || !handles.current.get(active)?.canEdit()} onClick={() => fileAction('exportHtml')}>HTML</button>
              <button role="menuitem" title="导出当前正文（含未保存编辑）；请先完成输入法组合输入" disabled={blocked || !handles.current.get(active)?.canEdit()} onClick={() => fileAction('exportDocx')}>DOCX</button>
              <button role="menuitem" title="通过系统打印窗口另存为 PDF" disabled={blocked || !handles.current.get(active)?.canEdit()} onClick={() => fileAction('print')}>PDF</button>
            </PositionedOverlay>}
          </div>
          <button role="menuitem" disabled={blocked || !handles.current.get(active)?.commandStatus('file.history').enabled} onClick={() => fileAction('history')}>版本历史</button>
          <button role="menuitem" disabled={blocked || !handles.current.get(active)?.commandStatus('file.batchImages').enabled} onClick={() => fileAction('batchImages')}>批量处理图片</button>
          <div className="menu-divider" role="separator" />
          <button role="menuitem" disabled={blocked || !handles.current.get(active)?.canEdit() || Object.values(summaries).some(s => s.busy)} onClick={() => executeApp('app.settings')}>设置</button>
        </PositionedOverlay>}
      </div>
      <div ref={tablist} className="document-tablist" role="tablist" aria-label="打开的文档" onMouseDown={(event) => {
        if (desktop && event.button === 0 && event.target === event.currentTarget) void dragWindow().catch((err) => setError(String(err)))
      }} onDoubleClick={(event) => { if (event.target === event.currentTarget) void toggleMaximizeWindow().catch((err) => setError(String(err))) }} onWheel={(event) => {
        const list = event.currentTarget
        if (list.scrollWidth <= list.clientWidth || event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
        list.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? list.clientWidth : 1)
      }}>
        {tabs.map((tab) => <div className={`document-tab ${tab.id === active ? 'active' : ''}`} key={tab.id} onContextMenu={event => {
          setMenuOpen(false)
          const canClose = (ids: string[]) => ids.length > 0 && !appModal && !closing && !closeBusy && !closeOperation.current && !templateOpen && ids.every(id => {
            const handle = handles.current.get(id)
            return sessionReady && !!handle && !handle.summary.busy && handle.canLeave()
          })
          const all = tabs.map(item => item.id), others = all.filter(id => id !== tab.id)
          contextMenu(event, [
            { label: '关闭当前', disabled: !canClose([tab.id]), run: () => requestClose(tab.id) },
            { label: '关闭所有', disabled: !canClose(all), run: () => requestClose(all) },
            { label: '关闭所有其他', disabled: !canClose(others), run: () => requestClose(others) },
          ])
        }}>
          <button role="tab" title={summaries[tab.id]?.name ?? tab.restoredName ?? tab.file?.name ?? '未命名.md'} tabIndex={tab.id === active ? 0 : -1} id={`tab-${tab.id}`} aria-controls={`panel-${tab.id}`} aria-selected={tab.id === active} disabled={!sessionReady || templateOpen || closeBusy || !!closing || !handles.current.get(active)?.canSwitch()} onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !handles.current.get(active)?.canSwitch()) return
            event.preventDefault()
            const index = tabs.findIndex((item) => item.id === tab.id)
            const next = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]
            void (async () => { const handle = handles.current.get(active); if (!handle?.prepareLeave || await handle.prepareLeave()) { setActive(next.id); document.getElementById(`tab-${next.id}`)?.focus() } })()
          }} onClick={() => { const handle = handles.current.get(active); if (handle?.canSwitch()) void (async () => { if (!handle.prepareLeave || await handle.prepareLeave()) setActive(tab.id) })() }}>{summaries[tab.id]?.name ?? tab.restoredName ?? tab.file?.name ?? '未命名.md'}{summaries[tab.id]?.dirty ? ' *' : ''}</button>
          <button className="tab-close" aria-label={`关闭 ${summaries[tab.id]?.name ?? tab.file?.name ?? '未命名.md'}`} disabled={blocked} onClick={() => requestClose(tab.id)}>×</button>
        </div>)}
        <button className="new-document" aria-label="新建标签" disabled={blocked} onClick={() => { const handle = handles.current.get(active); if (handle?.canLeave()) void (async () => { if (!handle.prepareLeave || await handle.prepareLeave()) add() })() }}>＋</button>
      </div>
      <div className="titlebar-drag" aria-hidden="true" onMouseDown={(event) => { if (event.button === 0) void dragWindow().catch((err) => setError(String(err))) }} onDoubleClick={() => void toggleMaximizeWindow().catch((err) => setError(String(err)))} />
      {desktop && <div className="window-controls" aria-label="窗口控制">
        <button aria-label="最小化窗口" title="最小化" onClick={() => void minimizeWindow().catch((err) => setError(String(err)))}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10" /></svg></button>
        <button aria-label={maximized ? '还原窗口' : '最大化窗口'} title={maximized ? '还原' : '最大化'} onClick={() => void toggleMaximizeWindow().catch((err) => setError(String(err)))}><svg viewBox="0 0 16 16" aria-hidden="true">{maximized ? <path d="M5 5V3h8v8h-2M3 5h8v8H3Z" /> : <path d="M3 3h10v10H3Z" />}</svg></button>
        <button className="window-close" aria-label="关闭窗口" title="关闭" disabled={closeBusy || !!closing} onClick={() => requestClose('window')}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 3 10 10M13 3 3 13" /></svg></button>
      </div>}
    </div>
    <OverlayHost />
    {error && !closing && <div className="global-error" role="alert">{error}<button aria-label="关闭提示" onClick={() => setError('')}>×</button></div>}
    {!sessionReady && <p role="status">正在检查上次会话与草稿…</p>}
    {sessionReady && tabs.map((tab) => <section key={tab.id} role="tabpanel" id={`panel-${tab.id}`} aria-labelledby={`tab-${tab.id}`} hidden={tab.id !== active} className="document-panel" inert={!!quickEntry || !!closing || closeBusy || templateOpen || appModal}>
      <DocumentEditor quickEntryOpen={!!quickEntry} reading={reading} readingBusy={windowBusy} onReading={(next) => void toggleReading(next)} id={tab.id} active={tab.id === active} suspended={!sessionReady || !!closing || closeBusy || templateOpen || appModal} draftKey={tab.draftKey} file={tab.file} blank={tab.blank} seed={tab.seed} path={tab.path} location={tab.location} workspace={workspace} onWorkspaceChange={setWorkspace} showFiles={showFiles} onShowFiles={setShowFiles} showSelectionTools={showSelectionTools} showToolbar={showToolbar} onShowToolbar={setShowToolbar} onNew={() => add()} onOpen={add} onReleaseUnused={async file => { if (file.id && !tabs.some(tab => tab.file?.id === file.id || handles.current.get(tab.id)?.summary.fileId === file.id)) await releaseDocument(file.id) }} onReport={report} onReadOther={tabs.length > 1 ? () => {
        const next = tabs.find(item => item.id !== tab.id)!
        setActive(next.id)
        requestAnimationFrame(() => document.getElementById(`tab-${next.id}`)?.focus())
      } : undefined} mathRendering={mathRendering} />
    </section>)}
    {settingsOpen && <SettingsDialog fileId={summaries[active]?.fileId} theme={theme} onTheme={setTheme} appearance={appearance} onAppearance={updateAppearance} onResetAppearance={() => setAppearance({ ...defaultAppearance })} mathRendering={mathRendering} onMathRendering={updateMathRendering} onClose={closeApplicationDialog} onGuide={() => { setSettingsOpen(false); setGuideOpen(true) }} />}
    {guideOpen && <GuideDialog previousVersion={previousGuideVersion.current} onClose={closeApplicationDialog} />}
    {recentOpen && <RecentDialog open={openRecent} close={() => setRecentOpen(false)} />}
    {quickEntry?.kind === 'commands' && <CommandPalette definitions={commandDefinitions.filter(command => !['code.language', 'app.commands'].includes(command.id))} status={id => id.startsWith('app.') ? appCommands.status(id, quickEntry.context) : handles.current.get(active)?.commandStatus(id, quickEntry.context) ?? { enabled: false, reason: '请先打开文档。' }} choose={chooseQuickCommand} close={closeQuickEntry} />}
    {quickEntry?.kind === 'open' && <QuickOpen tabs={tabs.map(tab => ({ id: tab.id, name: summaries[tab.id]?.name ?? tab.file?.name ?? '未命名.md', path: tab.path }))} workspace={workspace} pending={quickBusy} error={quickError} choose={chooseQuickFile} close={closeQuickEntry} />}
    {templateOpen && <TemplateDialog onCancel={cancelTemplate} onCreate={seed => {
      const handle = handles.current.get(active)
      // This confirmed dialog result may create a tab while general commands are suspended.
      if (!handle?.canLeave() || handle.summary.busy || handle.summary.pendingImage) return
      setTemplateOpen(false); add(undefined, null, null, undefined, seed)
    }} />}
    {closing && <CloseDialog scope={closing === 'window' ? 'window' : closing.length > 1 ? 'tabs' : 'tab'} error={error} busy={closeBusy} pendingImage={targetHandles().some((handle) => handle.summary.pendingImage)} onSave={() => void finish('save')} onRetain={() => void finish('retain')} onDiscard={() => void finish('discard')} onCancel={() => { setClosing(null); setError('') }} />}
  </div>
}
