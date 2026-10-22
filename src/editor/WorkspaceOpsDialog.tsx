import { useEffect, useRef, useState } from 'react'
import { ApplicationDialog } from './ApplicationDialogs'
import { commitRename, listTrash, planRename, renameTarget, restoreTrash, workspaceOpError, type RenamePlan, type TrashEntry } from '../platform/workspace-ops'

/** Rename with a link-update preview. Nothing changes until the user confirms the plan. */
export function RenameDialog({ workspace, path, onDone, onClose }: { workspace: string; path: string; onDone(path: string): void; onClose(): void }) {
  const current = path.split('/').at(-1) ?? path
  const [name, setName] = useState(current), [plan, setPlan] = useState<RenamePlan | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const generation = useRef(0)
  async function preview() {
    const token = ++generation.current
    setBusy(true); setError(''); setPlan(null)
    try {
      const value = await planRename(workspace, path, renameTarget(path, name))
      if (token === generation.current) setPlan(value)
    } catch (e) { if (token === generation.current) setError(workspaceOpError(e)) }
    finally { if (token === generation.current) setBusy(false) }
  }
  async function confirm() {
    if (!plan) return
    setBusy(true); setError('')
    try { const result = await commitRename(workspace, plan); onDone(result.path) }
    catch (e) { setError(workspaceOpError(e)); setPlan(null); setBusy(false) }
  }
  return <ApplicationDialog title="重命名文档" onClose={onClose} busy={busy}>
    <p>在同一目录内重命名。文档身份、版本历史和指向它的相对链接会一并更新。</p>
    <label>新名称 <input autoFocus value={name} disabled={busy} onChange={(e) => { setName(e.target.value); setPlan(null) }} onKeyDown={(e) => { if (e.key === 'Enter' && !plan) void preview() }} /></label>
    {error && <p role="alert">{error}</p>}
    {plan && <div role="status">
      <p>{plan.from} → <strong>{plan.to}</strong></p>
      {plan.incoming.length ? <ul className="identity-list">{plan.incoming.map((item) => <li key={item.path}>{item.path}<small>{item.links} 处链接</small></li>)}</ul> : <p>没有其他文档链接到它。</p>}
      {plan.outgoing > 0 && <p>文档自身有 {plan.outgoing} 处链接会更新。</p>}
      {plan.skipped.length > 0 && <p>{plan.skipped.length} 个文档不是 UTF-8 文本，未检查链接：{plan.skipped.join('、')}</p>}
    </div>}
    <div className="dialog-actions">
      {plan ? <button disabled={busy} onClick={() => void confirm()}>确认重命名</button> : <button disabled={busy || !name.trim() || name === current} onClick={() => void preview()}>预览</button>}
      <button disabled={busy} onClick={onClose}>取消</button>
    </div>
  </ApplicationDialog>
}

/** In-app trash under `.easym/trash/`. Restoring never overwrites an existing file. */
export function TrashDialog({ workspace, onRestored, onClose }: { workspace: string; onRestored(): void; onClose(): void }) {
  const [entries, setEntries] = useState<TrashEntry[] | null>(null), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [message, setMessage] = useState('')
  async function load() {
    try { setEntries(await listTrash(workspace)) } catch (e) { setError(workspaceOpError(e)) }
  }
  useEffect(() => { void load() }, [workspace])
  async function restore(entry: TrashEntry) {
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await restoreTrash(workspace, entry.operationId)
      setMessage(`已恢复 ${result.path}${result.warning ? '；同步身份未恢复，请在“同步身份”中处理。' : '。'}`)
      onRestored(); await load()
    } catch (e) { setError(workspaceOpError(e)) }
    finally { setBusy(false) }
  }
  return <ApplicationDialog title="工作区回收站" onClose={onClose} busy={busy}>
    <p>删除的文档保存在工作区的 .easym/trash 中，图片和版本历史不受影响。恢复时若原位置已有同名文件，不会覆盖。</p>
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {entries === null ? <p role="status">正在读取…</p> : !entries.length ? <p>回收站为空。</p> :
      <div className="recent-list">{entries.map((entry) => <div className="recent-row" key={entry.operationId}>
        <span className="recent-open"><strong>{entry.path}</strong><small>{new Date(entry.deletedAt).toLocaleString()}</small></span>
        <button disabled={busy} aria-label={`恢复 ${entry.path}`} onClick={() => void restore(entry)}>恢复</button>
      </div>)}</div>}
    <div className="dialog-actions"><button disabled={busy} onClick={onClose}>完成</button></div>
  </ApplicationDialog>
}
