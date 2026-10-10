import { useCallback, useEffect, useRef, useState } from 'react'
import DocumentEditor, { type DocumentHandle, type DocumentSummary, type FileAction } from './editor/DocumentEditor'
import { CloseDialog } from './editor/CloseDialog'
import { TemplateDialog } from './editor/TemplateDialog'
import type { NewDocument } from './core/templates'
import { listenForClose, closeWindow, minimizeWindow, toggleMaximizeWindow, dragWindow, windowState, setFullscreen, listenWindowState } from './platform/window'
import { drafts } from './platform/drafts'
import { releaseDocument, type OpenedFile } from './platform/storage'
import type { Workspace, WorkspaceLocation } from './platform/workspace'
import { desktop } from './platform/storage'
import { ContextMenuProvider, useContextMenu } from './editor/ContextMenu'

interface Tab { id: string; draftKey: string; file?: OpenedFile; blank?: boolean; seed?: NewDocument; path?: string | null; location?: WorkspaceLocation }
const first: Tab = { id: 'current', draftKey: 'current' }
const themes = { light: '清爽浅色', dark: '午夜深色', paper: '暖纸', forest: '护眼绿' }
type Theme = keyof typeof themes

export default function App() {
  return <ContextMenuProvider><Application /></ContextMenuProvider>
}

function Application() {
  const contextMenu = useContextMenu()
  const [tabs, setTabs] = useState<Tab[]>([first])
  const [active, setActive] = useState(first.id)
  const [summaries, setSummaries] = useState<Record<string, DocumentSummary>>({})
  const handles = useRef(new Map<string, DocumentHandle>())
  const [closing, setClosing] = useState<string[] | 'window' | null>(null)
  const [closeBusy, setCloseBusy] = useState(false)
  const closeOperation = useRef(false)
  const [error, setError] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [templateOpen, setTemplateOpen] = useState(false)
  const restoreTemplateFocus = useRef(false)
  const [styleMenuOpen, setStyleMenuOpen] = useState(false)
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [showFiles, setShowFiles] = useState(false)
  const [reading, setReading] = useState(false)
  const [windowBusy, setWindowBusy] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const readingRef = useRef(false)
  const windowOperation = useRef(false)
  const previousFullscreen = useRef(false)
  const [showToolbar, setShowToolbar] = useState(() => {
    try { return localStorage.getItem('easym-toolbar') !== 'hidden' } catch { return true }
  })
  const menu = useRef<HTMLDivElement>(null)
  const tablist = useRef<HTMLDivElement>(null)
  const [theme, setTheme] = useState<Theme>(() => {
    try { const stored = localStorage.getItem('easym-theme'); return stored && Object.hasOwn(themes, stored) ? stored as Theme : 'light' } catch { return 'light' }
  })
  const report = useCallback((id: string, summary: DocumentSummary, handle: DocumentHandle) => {
    handles.current.set(id, handle)
    setSummaries((previous) => JSON.stringify(previous[id]) === JSON.stringify(summary) ? previous : { ...previous, [id]: summary })
  }, [])
  async function toggleReading(next: boolean) {
    if (windowOperation.current || next === readingRef.current) return
    windowOperation.current = true; setWindowBusy(true); setMenuOpen(false)
    try {
      if (next) {
        previousFullscreen.current = (await windowState()).fullscreen
        await setFullscreen(true)
      } else await setFullscreen(previousFullscreen.current)
      readingRef.current = next; setReading(next)
    } catch (err) { setError(`切换阅读模式失败：${String(err)}`) }
    finally { windowOperation.current = false; setWindowBusy(false) }
  }
  const exitReading = useRef(() => undefined as void)
  exitReading.current = () => { void toggleReading(false) }
  useEffect(() => {
    let disposed = false; let stop: (() => void) | undefined
    const update = () => { void windowState().then((state) => {
      if (disposed) return
      setMaximized(state.maximized)
      if (readingRef.current && !state.fullscreen && !windowOperation.current) { readingRef.current = false; setReading(false) }
    }).catch((err) => { if (!disposed) setError(String(err)) }) }
    update()
    listenWindowState(update).then((unlisten) => { if (disposed) unlisten(); else stop = unlisten }).catch((err) => { if (!disposed) setError(String(err)) })
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && readingRef.current) { event.preventDefault(); exitReading.current() }
    }
    window.addEventListener('keydown', escape)
    return () => { disposed = true; stop?.(); window.removeEventListener('keydown', escape) }
  }, [])
  useEffect(() => { try { localStorage.setItem('easym-theme', theme) } catch { /* Theme remains usable without persistence. */ } }, [theme])
  useEffect(() => { try { localStorage.setItem('easym-toolbar', showToolbar ? 'visible' : 'hidden') } catch { /* Visibility remains usable without persistence. */ } }, [showToolbar])
  useEffect(() => {
    if (!menuOpen) { setStyleMenuOpen(false); return }
    menu.current?.querySelector<HTMLButtonElement>('[role^=menuitem]:not(:disabled)')?.focus()
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) setMenuOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [menuOpen])
  useEffect(() => {
    if (styleMenuOpen) menu.current?.querySelector<HTMLButtonElement>('[role=menuitemradio][aria-checked=true]')?.focus()
  }, [styleMenuOpen])
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
    drafts.keys().then((keys) => {
      if (alive) setTabs((previous) => [...previous, ...keys.filter((key) => key.startsWith('document:') && !previous.some((tab) => tab.draftKey === key)).map((key) => ({ id: key, draftKey: key }))])
    }).catch((err) => setError(String(err)))
    return () => { alive = false }
  }, [])
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
  const requestClose = (id: string | string[] | 'window') => {
    if (templateOpen) { cancelTemplate(); return }
    const ids = id === 'window' ? tabs.map(tab => tab.id) : Array.isArray(id) ? [...new Set(id)] : [id]
    if (!ids.length) return
    const targets = ids.map(target => handles.current.get(target)).filter((h): h is DocumentHandle => !!h)
    if (closing || closeBusy || closeOperation.current || targets.length !== ids.length || targets.some((handle) => handle.summary.busy || !handle.canLeave())) { setError('正在处理、输入或恢复草稿，请完成后再关闭。'); return }
    setError('')
    setMenuOpen(false)
    if (targets.some((handle) => handle.summary.dirty || handle.summary.pendingImage)) { setClosing(id === 'window' ? 'window' : ids); return }
    closeOperation.current = true; setCloseBusy(true)
    void (id === 'window' ? closeWindow() : remove(ids, false)).catch((err) => setError(String(err))).finally(() => { closeOperation.current = false; setCloseBusy(false) })
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
      if (closing === 'window') await closeWindow()
      else await remove(closing, action !== 'save')
      setClosing(null)
    } catch (err) { if (action === 'discard') targetHandles().forEach((handle) => handle.resume()); setError(String(err)) }
    finally { closeOperation.current = false; setCloseBusy(false) }
  }
  function cancelTemplate() {
    restoreTemplateFocus.current = true
    setTemplateOpen(false)
  }
  const blocked = templateOpen || closeBusy || !!closing || !summaries[active] || !!summaries[active]?.busy || !!summaries[active]?.pendingImage
  const fileAction = (action: FileAction) => {
    setMenuOpen(false)
    handles.current.get(active)?.run(action)
  }
  return <div className={`application ${reading ? 'reading-mode' : ''}`} data-theme={theme}>
    <div className="document-strip" hidden={reading} inert={templateOpen}>
      <div className="app-menu" ref={menu} onKeyDown={(event) => {
        const inStyleMenu = !!(event.target as HTMLElement).closest('#style-menu')
        if ((inStyleMenu && ['ArrowLeft', 'Escape'].includes(event.key)) || (event.key === 'Escape' && styleMenuOpen)) {
          event.preventDefault(); event.stopPropagation(); setStyleMenuOpen(false); menu.current?.querySelector<HTMLButtonElement>('.style-menu-trigger')?.focus(); return
        }
        if (event.key === 'ArrowRight' && (event.target as HTMLElement).closest('.style-menu-trigger')) { event.preventDefault(); setStyleMenuOpen(true); return }
        if (event.key === 'Escape') { event.preventDefault(); setMenuOpen(false); menu.current?.querySelector<HTMLButtonElement>('.app-menu-trigger')?.focus() }
        if (menuOpen && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          const currentMenu = (event.target as HTMLElement).closest('[role=menu]')
          const items = Array.from(currentMenu?.querySelectorAll<HTMLButtonElement>('[role^=menuitem]:not(:disabled)') ?? []).filter((item) => item.closest('[role=menu]') === currentMenu)
          const index = items.indexOf(document.activeElement as HTMLButtonElement)
          items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
        }
        if (event.key === 'Tab') setMenuOpen(false)
      }}>
        <button className="app-menu-trigger brand-mark" aria-label="EM 菜单" title="EasyM · 文件菜单" aria-haspopup="menu" aria-expanded={menuOpen} aria-controls="file-menu" disabled={closeBusy || !!closing} onClick={() => setMenuOpen(!menuOpen)}>EM</button>
        {menuOpen && <div className="file-menu" id="file-menu" role="menu" aria-label="文件菜单">
          <button role="menuitem" disabled={blocked || !handles.current.get(active)?.canEdit()} onClick={() => fileAction('new')}>新建文档</button>
          <button role="menuitem" disabled={blocked || !handles.current.get(active)?.canEdit()} onClick={() => { setMenuOpen(false); setTemplateOpen(true) }}>从模板新建</button>
          <button role="menuitem" disabled={blocked || !handles.current.get(active)?.canEdit()} onClick={() => fileAction('open')}>打开文件</button>
          <button role="menuitem" disabled={blocked || !handles.current.get(active)?.canEdit()} onClick={() => fileAction('workspace')}>打开工作区</button>
          <div className="menu-divider" role="separator" />
          <button role="menuitem" disabled={blocked || !handles.current.get(active)?.canEdit()} onClick={() => fileAction('saveAs')}>{desktop ? '另存为 / 冲突副本' : '下载副本'}</button>
          <button role="menuitem" disabled={blocked || !desktop || !summaries[active]?.fileId || !handles.current.get(active)?.canEdit()} onClick={() => fileAction('reload')}>重新加载外部版本</button>
          <button role="menuitem" disabled={blocked || !handles.current.get(active)?.canEdit()} onClick={() => fileAction('exportHtml')}>导出 HTML</button>
          <button role="menuitem" disabled={blocked || !handles.current.get(active)?.canEdit()} onClick={() => fileAction('print')}>打印文档</button>
          <div className="menu-divider" role="separator" />
          <div className="style-menu">
            <button className="style-menu-trigger" role="menuitem" aria-label="Style · 配色主题" aria-haspopup="menu" aria-expanded={styleMenuOpen} aria-controls="style-menu" onClick={() => setStyleMenuOpen(!styleMenuOpen)}>Style · 配色主题 <span aria-hidden="true">›</span></button>
            {styleMenuOpen && <div className="theme-submenu" id="style-menu" role="menu" aria-label="配色主题">
              {Object.entries(themes).map(([value, label]) => <button role="menuitemradio" aria-checked={theme === value} key={value} onClick={() => { setTheme(value as Theme); setMenuOpen(false); setStyleMenuOpen(false) }}><span aria-hidden="true">{theme === value ? '✓' : '　'}</span> {label}</button>)}
            </div>}
          </div>
        </div>}
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
          const canClose = (ids: string[]) => ids.length > 0 && !closing && !closeBusy && !closeOperation.current && !templateOpen && ids.every(id => {
            const handle = handles.current.get(id)
            return !!handle && !handle.summary.busy && handle.canLeave()
          })
          const all = tabs.map(item => item.id), others = all.filter(id => id !== tab.id)
          contextMenu(event, [
            { label: '关闭当前', disabled: !canClose([tab.id]), run: () => requestClose(tab.id) },
            { label: '关闭所有', disabled: !canClose(all), run: () => requestClose(all) },
            { label: '关闭所有其他', disabled: !canClose(others), run: () => requestClose(others) },
          ])
        }}>
          <button role="tab" title={summaries[tab.id]?.name ?? tab.file?.name ?? '未命名.md'} tabIndex={tab.id === active ? 0 : -1} id={`tab-${tab.id}`} aria-controls={`panel-${tab.id}`} aria-selected={tab.id === active} disabled={blocked} onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !handles.current.get(active)?.canLeave()) return
            event.preventDefault()
            const index = tabs.findIndex((item) => item.id === tab.id)
            const next = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]
            setActive(next.id); document.getElementById(`tab-${next.id}`)?.focus()
          }} onClick={() => { if (handles.current.get(active)?.canLeave()) setActive(tab.id) }}>{summaries[tab.id]?.name ?? tab.file?.name ?? '未命名.md'}{summaries[tab.id]?.dirty ? ' *' : ''}</button>
          <button className="tab-close" aria-label={`关闭 ${summaries[tab.id]?.name ?? tab.file?.name ?? '未命名.md'}`} disabled={blocked} onClick={() => requestClose(tab.id)}>×</button>
        </div>)}
        <button className="new-document" aria-label="新建标签" disabled={blocked} onClick={() => { if (handles.current.get(active)?.canLeave()) add() }}>＋</button>
      </div>
      <div className="titlebar-drag" aria-hidden="true" onMouseDown={(event) => { if (event.button === 0) void dragWindow().catch((err) => setError(String(err))) }} onDoubleClick={() => void toggleMaximizeWindow().catch((err) => setError(String(err)))} />
      {desktop && <div className="window-controls" aria-label="窗口控制">
        <button aria-label="最小化窗口" title="最小化" onClick={() => void minimizeWindow().catch((err) => setError(String(err)))}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10" /></svg></button>
        <button aria-label={maximized ? '还原窗口' : '最大化窗口'} title={maximized ? '还原' : '最大化'} onClick={() => void toggleMaximizeWindow().catch((err) => setError(String(err)))}><svg viewBox="0 0 16 16" aria-hidden="true">{maximized ? <path d="M5 5V3h8v8h-2M3 5h8v8H3Z" /> : <path d="M3 3h10v10H3Z" />}</svg></button>
        <button className="window-close" aria-label="关闭窗口" title="关闭" disabled={closeBusy || !!closing} onClick={() => requestClose('window')}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 3 10 10M13 3 3 13" /></svg></button>
      </div>}
    </div>
    {error && !closing && <div className="global-error" role="alert">{error}<button aria-label="关闭提示" onClick={() => setError('')}>×</button></div>}
    {tabs.map((tab) => <section key={tab.id} role="tabpanel" id={`panel-${tab.id}`} aria-labelledby={`tab-${tab.id}`} hidden={tab.id !== active} className="document-panel" inert={!!closing || closeBusy || templateOpen}>
      <DocumentEditor reading={reading} readingBusy={windowBusy} onReading={(next) => void toggleReading(next)} id={tab.id} active={tab.id === active} suspended={!!closing || closeBusy || templateOpen} draftKey={tab.draftKey} file={tab.file} blank={tab.blank} seed={tab.seed} path={tab.path} location={tab.location} workspace={workspace} onWorkspaceChange={setWorkspace} showFiles={showFiles} onShowFiles={setShowFiles} showToolbar={showToolbar} onShowToolbar={setShowToolbar} onNew={() => add()} onOpen={add} onReport={report} />
    </section>)}
    {templateOpen && <TemplateDialog onCancel={cancelTemplate} onCreate={seed => {
      if (!handles.current.get(active)?.canEdit()) return
      setTemplateOpen(false); add(undefined, null, null, undefined, seed)
    }} />}
    {closing && <CloseDialog scope={closing === 'window' ? 'window' : closing.length > 1 ? 'tabs' : 'tab'} error={error} busy={closeBusy} pendingImage={targetHandles().some((handle) => handle.summary.pendingImage)} onSave={() => void finish('save')} onRetain={() => void finish('retain')} onDiscard={() => void finish('discard')} onCancel={() => { setClosing(null); setError('') }} />}
  </div>
}
