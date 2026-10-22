import { useEffect, useRef, useState } from 'react'
import { ApplicationDialog } from './ApplicationDialogs'
import { commitRename, listDirectories, listTrash, moveTarget, planRename, renameTarget, restoreTrash, workspaceOpError, type RenamePlan, type RenameResult, type TrashEntry } from '../platform/workspace-ops'

/**
 * Rename (same directory) or move (to another existing directory) with a link-update preview.
 * Nothing changes until the user confirms the plan. `beforeCommit` lets the caller refuse when
 * an open tab has unsaved edits; `onDone` receives the result so open tabs can reload.
 */
export function RenameDialog({ workspace, path, mode = 'rename', beforeCommit, onDone, onClose }: { workspace: string; path: string; mode?: 'rename' | 'move'; beforeCommit?(): Promise<void>; onDone(result: RenameResult): void; onClose(): void }) {
  const current = path.split('/').at(-1) ?? path
  const currentDir = path.split('/').slice(0, -1).join('/')
  const [name, setName] = useState(current), [plan, setPlan] = useState<RenamePlan | null>(null)
  const [directories, setDirectories] = useState<string[] | null>(null), [directory, setDirectory] = useState(currentDir)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const generation = useRef(0)
  useEffect(() => {
    if (mode !== 'move') return
    let alive = true
    listDirectories(workspace).then((value) => { if (alive) setDirectories(value) }).catch((e) => { if (alive) setError(workspaceOpError(e)) })
    return () => { alive = false }
  }, [mode, workspace])
  const target = () => mode === 'move' ? moveTarget(path, directory) : renameTarget(path, name)
  async function preview() {
    const token = ++generation.current
    setBusy(true); setError(''); setPlan(null)
    try {
      const value = await planRename(workspace, path, target())
      if (token === generation.current) setPlan(value)
    } catch (e) { if (token === generation.current) setError(workspaceOpError(e)) }
    finally { if (token === generation.current) setBusy(false) }
  }
  async function confirm() {
    if (!plan) return
    setBusy(true); setError('')
    try { await beforeCommit?.(); onDone(await commitRename(workspace, plan)) }
    catch (e) { setError(workspaceOpError(e)); setPlan(null); setBusy(false) }
  }
  const unchanged = mode === 'move' ? directory === currentDir : !name.trim() || name === current
  return <ApplicationDialog title={mode === 'move' ? '移动文档' : '重命名文档'} onClose={onClose} busy={busy}>
    {mode === 'move'
      ? <p>移动到工作区内已有的目录。文档身份、版本历史、引用的图片和相对链接会一并处理；原目录中的图片保留，不会删除。</p>
      : <p>在同一目录内重命名。文档身份、版本历史和指向它的相对链接会一并更新。</p>}
    {mode === 'move'
      ? <label>目标目录 <select autoFocus value={directory} disabled={busy || !directories} onChange={(e) => { setDirectory(e.target.value); setPlan(null) }}>
          {(directories ?? [currentDir]).map((dir) => <option key={dir} value={dir}>{dir || '（工作区根目录）'}</option>)}
        </select></label>
      : <label>新名称 <input autoFocus value={name} disabled={busy} onChange={(e) => { setName(e.target.value); setPlan(null) }} onKeyDown={(e) => { if (e.key === 'Enter' && !plan) void preview() }} /></label>}
    {error && <p role="alert">{error}</p>}
    {plan && <div role="status">
      <p>{plan.from} → <strong>{plan.to}</strong></p>
      {plan.incoming.length ? <ul className="identity-list">{plan.incoming.map((item) => <li key={item.path}>{item.path}<small>{item.links} 处链接</small></li>)}</ul> : <p>没有其他文档链接到它。</p>}
      {plan.outgoing > 0 && <p>文档自身有 {plan.outgoing} 处链接会更新。</p>}
      {plan.images.length > 0 && <p>{plan.images.length} 张图片会复制到目标目录（原图保留）。</p>}
      {plan.skipped.length > 0 && <p>{plan.skipped.length} 个文档不是 UTF-8 文本，未检查链接：{plan.skipped.join('、')}</p>}
    </div>}
    <div className="dialog-actions">
      {plan ? <button disabled={busy} onClick={() => void confirm()}>{mode === 'move' ? '确认移动' : '确认重命名'}</button> : <button disabled={busy || unchanged} onClick={() => void preview()}>预览</button>}
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
