import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { CommandDefinition, CommandStatus } from '../core/commands'
import { filterCommands, filterTabs, type QuickTab } from '../core/quick-entry'
import type { OverlayLease } from '../core/overlays'
import { cancelWorkspaceSearch, searchWorkspaceFilenames, type FilenameReport, type Workspace } from '../platform/workspace'
import { desktop } from '../platform/storage'
import { OverlayPortal, PositionedOverlay, useOverlays } from './Overlay'

export function SlashMenu({ rect, items, index, choose, close }: { rect: DOMRect; items: CommandDefinition[]; index: number; choose(id: string): void; close(): void }) {
  const { manager } = useOverlays(), lease = useRef<OverlayLease | null>(null), panel = useRef<HTMLDivElement>(null), dismiss = useRef(close)
  dismiss.current = close
  const [visible, setVisible] = useState(false)
  useLayoutEffect(() => {
    lease.current = manager.open('content', () => dismiss.current())
    setVisible(!!lease.current)
    if (!lease.current) dismiss.current()
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node)) dismiss.current() }
    document.addEventListener('pointerdown', outside)
    return () => { lease.current?.release(); document.removeEventListener('pointerdown', outside) }
  }, [manager])
  useEffect(() => { panel.current?.querySelector<HTMLElement>(`[data-slash-index="${index}"]`)?.scrollIntoView({ block: 'nearest' }) }, [index])
  return visible ? <PositionedOverlay label="快捷插入" className="slash-menu" lease={lease} element={panel} anchor={() => rect} onMouseDown={event => event.preventDefault()}>
    {items.map((item, i) => <button key={item.id} role="menuitem" data-slash-index={i} className={i === index ? 'active' : ''} onClick={() => choose(item.id)}>{item.label}</button>)}{!items.length && <p>没有匹配结果</p>}
    <small>↑↓ 选择 · Enter 插入 · Esc 保留原文</small>
  </PositionedOverlay> : null
}

export interface SearchItem { id: string; label: string; detail: string; shortcut?: string; status?: CommandStatus }
export function SearchOverlay({ title, query, onQuery, items, footer, error, pending = false, onComposing, onChoose, onClose }: {
  title: string; query: string; onQuery(value: string): void; items: SearchItem[]; footer?: ReactNode; error?: string; pending?: boolean;
  onComposing?(value: boolean): void; onChoose(id: string): void; onClose(): void;
}) {
  const { manager } = useOverlays(), panel = useRef<HTMLDivElement>(null), composing = useRef(false), close = useRef(onClose)
  close.current = onClose
  const [index, setIndex] = useState(0)
  const signature = items.map(item => item.id).join('\0')
  useEffect(() => setIndex(0), [query, signature])
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const lease = manager.open('menu', () => close.current())
    if (!lease) { close.current(); return }
    panel.current?.querySelector<HTMLInputElement>('input')?.focus()
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !composing.current) close.current() }
    document.addEventListener('pointerdown', outside)
    return () => {
      document.removeEventListener('pointerdown', outside); lease.release()
      const version = manager.version()
      requestAnimationFrame(() => {
        if (manager.version() !== version || manager.top()) return
        if (previous?.isConnected && !previous.closest('[hidden],[inert]')) previous.focus({ preventScroll: true })
        else document.querySelector<HTMLElement>('.document-panel:not([hidden]) .cm-content')?.focus({ preventScroll: true })
      })
    }
  }, [manager])
  useEffect(() => { panel.current?.querySelector<HTMLElement>(`[data-result-index="${index}"]`)?.scrollIntoView({ block: 'nearest' }) }, [index])
  return <OverlayPortal><div className="quick-entry-backdrop"><div className="quick-entry-panel" ref={panel} role="dialog" aria-label={title} onKeyDown={event => {
    if (event.nativeEvent.isComposing || composing.current) return
    if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      if (items.length) setIndex(current => event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length)
    } else if (event.key === 'Enter') { event.preventDefault(); const item = items[index]; if (item && item.status?.enabled !== false && !pending) onChoose(item.id) }
    else if (event.key === 'Tab') { event.preventDefault(); panel.current?.querySelector<HTMLInputElement>('input')?.focus() }
  }} onCompositionStart={() => { composing.current = true; onComposing?.(true) }} onCompositionEnd={() => queueMicrotask(() => { composing.current = false; onComposing?.(false) })}>
    <div className="quick-entry-heading"><h2>{title}</h2><button aria-label={`关闭${title}`} onClick={() => { if (!composing.current) onClose() }}>×</button></div>
    <input type="search" role="combobox" aria-label={`搜索${title}`} aria-expanded="true" aria-controls="quick-entry-results" aria-activedescendant={items[index] ? `quick-result-${index}` : undefined} autoComplete="off" maxLength={256} value={query} onChange={event => onQuery(event.target.value)} />
    <div className="quick-entry-results" id="quick-entry-results" role="listbox" aria-label={`${title}结果`} aria-busy={pending}>{items.map((item, i) => <div key={item.id} id={`quick-result-${i}`} role="option" aria-selected={i === index} aria-disabled={pending || item.status?.enabled === false} data-result-index={i} className="quick-entry-result" onMouseDown={event => event.preventDefault()} onMouseMove={() => setIndex(i)} onClick={() => { if (!composing.current && !pending && item.status?.enabled !== false) onChoose(item.id) }}>
      <span><strong>{item.label}</strong><small>{item.detail}</small>{item.status?.enabled === false && <small className="quick-entry-reason">{item.status.reason}</small>}</span>{item.shortcut && <kbd>{item.shortcut.replaceAll('Mod', /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl')}</kbd>}{item.status?.checked && <span aria-label={item.status.checked === 'mixed' ? '混合状态' : '已启用'}>{item.status.checked === 'mixed' ? '−' : '✓'}</span>}
    </div>)}{!items.length && <p>{pending ? '正在搜索…' : '没有匹配结果'}</p>}</div>
    {error && <p role="alert" className="image-error">{error}</p>}<div className="quick-entry-footer">{footer}<small>↑↓ / Home / End 选择 · Enter 打开 · Esc 关闭</small></div>
  </div></div></OverlayPortal>
}

export function CommandPalette({ definitions, status, choose, close }: { definitions: CommandDefinition[]; status(id: string): CommandStatus; choose(id: string): void; close(): void }) {
  const [query, setQuery] = useState('')
  return <SearchOverlay title="命令面板" query={query} onQuery={setQuery} items={filterCommands(definitions, query).map(command => ({ id: command.id, label: command.label, detail: command.group, shortcut: command.shortcut, status: status(command.id) }))} onChoose={choose} onClose={close} footer={<small>搜索中文名称或英文关键词</small>} />
}

export function QuickOpen({ tabs, workspace, pending, error, choose, close }: {
  tabs: QuickTab[]; workspace: Workspace | null; pending: boolean; error: string;
  choose(target: { tabId: string } | { workspaceId: string; path: string }): void; close(): void;
}) {
  const [query, setQuery] = useState(''), [report, setReport] = useState<FilenameReport | null>(null), [searching, setSearching] = useState(false), [searchError, setSearchError] = useState(''), [composing, setComposing] = useState(false)
  useEffect(() => {
    let alive = true, request: string | null = null
    setReport(null); setSearchError('')
    if (!workspace || !desktop || composing) { setSearching(false); return }
    setSearching(true)
    const timer = window.setTimeout(() => {
      request = crypto.randomUUID()
      void searchWorkspaceFilenames(workspace.id, query, request).then(result => { if (alive && !result.cancelled) setReport(result) }).catch(err => { if (alive) setSearchError(`文件名搜索失败：${String(err)}`) }).finally(() => { if (alive) setSearching(false) })
    }, 200)
    return () => { alive = false; clearTimeout(timer); if (request) void cancelWorkspaceSearch(request).catch(() => undefined) }
  }, [workspace?.id, query, composing])
  const opened = filterTabs(tabs, query), paths = report?.paths ?? []
  return <SearchOverlay title="快速打开" query={query} onQuery={setQuery} pending={pending} error={error || searchError} onComposing={setComposing} items={[
    ...opened.map(tab => ({ id: `tab:${tab.id}`, label: tab.name, detail: `已打开 · ${tab.path || '草稿 / 独立文件'}` })),
    ...paths.map((path, index) => ({ id: `path:${index}`, label: path.split('/').at(-1)!, detail: `工作区 · ${path}` })),
  ]} onChoose={id => { if (id.startsWith('tab:')) choose({ tabId: id.slice(4) }); else if (workspace && paths[Number(id.slice(5))]) choose({ workspaceId: workspace.id, path: paths[Number(id.slice(5))] }) }} onClose={close} footer={<>
    <small>{!desktop ? '浏览器演示仅搜索已打开文档。' : !workspace ? '打开工作区后可按文件名 / 相对路径搜索。' : searching ? '正在搜索授权工作区文件名…' : `扫描 ${report?.scanned ?? 0} 个条目${report?.skipped ? ` · 跳过 ${report.skipped} 个不可访问条目` : ''}`}</small>
    {report?.limited && <p role="status">结果受限，请缩小查询</p>}{pending && <p role="status">正在打开文件，关闭此面板可取消切换。</p>}
  </>} />
}
