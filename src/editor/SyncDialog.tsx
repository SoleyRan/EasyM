import { useEffect, useRef, useState } from 'react'
import { ApplicationDialog } from './ApplicationDialogs'
import { MergePreview } from './MergePreview'
import type { ConflictVersions, OpenConflict, SyncView } from './useSync'
import { mergeBytes } from '../platform/merge-transaction'
import { REJOIN_CODES } from '../core/sync-engine'
import { identityError, previewIdentity, type IdentityPreview } from '../platform/sync-identity'
import { probeEndpoint, syncError, unbindWorkspace } from '../platform/sync-native'
import { pairWorkspace, previewRemote, type Credentials, type RemotePreview } from '../platform/sync-pairing'
import type { SyncStatus } from '../platform/sync-controller'

export function statusText(status: SyncStatus | null): string {
  if (!status) return '未连接'
  if (status.kind === 'syncing') return '同步中…'
  if (status.kind === 'retrying') return `连接暂时失败，${Math.max(1, Math.round((status.at - Date.now()) / 1000))} 秒后重试`
  if (status.kind === 'paused') return status.code ? `已暂停：${syncError(status.code)}` : '已暂停'
  return status.lastSync ? `已同步 · ${new Date(status.lastSync).toLocaleTimeString()}` : '等待同步'
}

type Choice = { kind: 'new' } | { kind: 'join'; workspaceId: string }

/** Sync settings for the open workspace: pairing with preview, status, pause and exit. */
export function SyncDialog({ workspace, name, sync, onClose }: { workspace: string; name: string; sync: SyncView; onClose(): void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  async function task(action: () => Promise<void>, map: (e: unknown) => string = syncError) {
    setBusy(true); setError(''); setMessage('')
    try { await action() } catch (e) { if (alive.current) setError(map(e)) }
    finally { if (alive.current) setBusy(false) }
  }
  return <ApplicationDialog title="同步" busy={busy} onClose={() => { if (!busy) onClose() }}>
    <p>把工作区「{name}」同步到你自己的 WebDAV 服务器。正文和图片保存在服务器的 easym-sync 目录中；密码只存放在系统凭据存储里。同步不能代替备份。</p>
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {sync.binding
      ? <Bound workspace={workspace} sync={sync} busy={busy} task={task} setMessage={setMessage} />
      : <Pairing workspace={workspace} sync={sync} busy={busy} task={task} setMessage={setMessage} />}
    <div className="dialog-actions"><button disabled={busy} onClick={onClose}>完成</button></div>
  </ApplicationDialog>
}

interface PartProps { workspace: string; sync: SyncView; busy: boolean; task(action: () => Promise<void>, map?: (e: unknown) => string): Promise<void>; setMessage(message: string): void }
function Bound({ workspace, sync, busy, task, setMessage }: PartProps) {
  const binding = sync.binding!, report = sync.report, paused = sync.status?.kind === 'paused'
  return <section>
    <h3>已连接</h3>
    <p className="panel-note">{binding.username} @ {binding.endpoint}</p>
    <p role="status" aria-live="polite">{statusText(sync.status)}</p>
    {report && <ul className="identity-list">
      <li>{report.published ? '已上传本机修改' : '本机没有新修改'}{report.downloaded > 0 && `，下载 ${report.downloaded} 个文档`}</li>
      {[...new Set(report.conflicts.filter((c) => c.reason === 'merged').map((c) => c.path))].map((p) => <li key={`merged:${p}`}>{p} 在两台设备上改了不同的段落，已自动合并双方改动</li>)}
      {report.conflicts.filter((c) => c.reason === 'both_changed' && c.copy).map((c) => <li key={`copy:${c.copy}`}>{c.path} 在两台设备上改了同一处，另一版本另存为 {c.copy}</li>)}
      {report.copies.map((c) => <li key={c.copy}>{c.path} 在两台设备上都被修改，远端版本另存为 {c.copy}</li>)}
      {report.keptDeletes.map((p) => <li key={p}>{p} 在其他设备被删除，但本机有修改，已保留</li>)}
      {report.restored.map((p) => <li key={p}>{p} 已删除，但其他设备之后修改过，已恢复</li>)}
      {report.deferred.map((p) => <li key={p}>{p} 在其他设备被删除；关闭其标签页后移到回收站</li>)}
      {report.skipped.map((s) => <li key={s.path}>{s.path} 未上传：{s.reason === 'missing_assets' ? '引用的图片缺失' : '文件名无法跨平台保存'}</li>)}
      {report.failed.map((f) => <li key={f.path}>{f.path} 本次未能写入（{syncError(f.error)}），下次同步重试</li>)}
    </ul>}
    {paused && sync.status?.kind === 'paused' && sync.status.code && REJOIN_CODES.has(sync.status.code) && <section aria-label="恢复同步">
      <p>继续同步前需要以新的设备身份重新加入。本机文件、回收站和待解决的冲突都会保留；与服务器不一致的文档会另存为冲突副本，不会互相覆盖。</p>
      <div className="dialog-actions">
        <button disabled={busy} onClick={() => void task(async () => { await sync.rejoin(); setMessage('已以新的设备身份重新加入，正在同步。') })}>以新设备身份重新加入</button>
      </div>
    </section>}
    {report && report.openConflicts.length > 0 && <Conflicts sync={sync} busy={busy} task={task} setMessage={setMessage} />}
    <div className="dialog-actions">
      <button disabled={busy || paused || sync.status?.kind === 'syncing'} onClick={() => sync.request()}>立即同步</button>
      {paused ? <button disabled={busy} onClick={() => sync.resume()}>继续同步</button> : <button disabled={busy} onClick={() => sync.pause()}>暂停</button>}
      <button disabled={busy} onClick={() => {
        if (!window.confirm('退出同步将删除本机保存的连接、密码和同步状态。工作区文件和服务器上的数据都会保留，之后可以重新连接。确定？')) return
        void task(async () => { sync.pause(); await unbindWorkspace(workspace); sync.refresh(); setMessage('已退出同步。工作区文件和服务器数据未改动。') })
      }}>退出同步</button>
    </div>
  </section>
}
const SYNC_LABELS = { local: '本文档', disk: '冲突副本', intro: '共同祖先为两台设备分开修改前的版本。逐处选择后应用；本文档原来的正文和冲突副本都会移到回收站，可以随时恢复。' }

/** v2 step 4B: open sync conflicts, resolved line by line or by keeping one whole version. */
function Conflicts({ sync, busy, task, setMessage }: Omit<PartProps, 'workspace'>) {
  const conflicts = sync.report!.openConflicts
  const [selected, setSelected] = useState<OpenConflict | null>(null)
  const [versions, setVersions] = useState<ConflictVersions | null>(null)
  // A resolved conflict leaves the list after the next pass; close it if it disappears.
  useEffect(() => { if (selected && !conflicts.some((c) => c.copyId === selected.copyId)) { setSelected(null); setVersions(null) } }, [conflicts, selected])
  const open = (entry: OpenConflict) => void task(async () => { setSelected(entry); setVersions(null); setVersions(await sync.loadConflict(entry)) })
  const apply = (bytes: Uint8Array | null, done: string) => void task(async () => {
    if (!selected || !versions) return
    await sync.resolveConflict(selected, versions, bytes)
    setSelected(null); setVersions(null); setMessage(done)
  })
  return <section aria-label="同步冲突">
    <h3>待解决的冲突（{conflicts.length}）</h3>
    <ul className="identity-list">
      {conflicts.map((c) => <li key={c.copyId}>{c.path} 与 {c.copy} <button disabled={busy} aria-pressed={selected?.copyId === c.copyId} onClick={() => open(c)}>解决</button></li>)}
    </ul>
    {selected && !versions && <p role="status">正在读取双方版本…</p>}
    {selected && versions && <div className="sync-conflict">
      <p>{selected.path} 在两台设备上改了同一处，另一版本保存在 {selected.copy}。{versions.base === null && '找不到共同祖先，只能整篇保留其中一个版本。'}</p>
      <div className="dialog-actions">
        <button disabled={busy} onClick={() => apply(null, `已保留 ${selected.path}，冲突副本已移到回收站。`)}>保留本文档</button>
        <button disabled={busy} onClick={() => apply(versions.theirs.originalBytes, `已改用冲突副本的内容；原来的正文和副本都在回收站。`)}>改用冲突副本</button>
      </div>
      {versions.base !== null && <MergePreview base={versions.base} local={versions.mine.text} disk={versions.theirs.text} busy={busy} labels={SYNC_LABELS}
        formats={{ local: versions.mine, disk: versions.theirs }}
        onApply={(candidate) => apply(mergeBytes(candidate.text, candidate.format === 'local' ? versions.mine : versions.theirs), `已合并 ${selected.path}；原来的正文和冲突副本都在回收站。`)} />}
    </div>}
  </section>
}

function Pairing({ workspace, sync, busy, task, setMessage }: PartProps) {
  const [credentials, setCredentials] = useState<Credentials>({ endpoint: '', username: '', password: '' })
  const [identity, setIdentity] = useState<IdentityPreview | null>(null)
  const [remotes, setRemotes] = useState<string[] | null>(null)
  const [choice, setChoice] = useState<Choice>({ kind: 'new' })
  const [preview, setPreview] = useState<RemotePreview | null>(null)
  const [link, setLink] = useState(false)
  const edit =(patch: Partial<Credentials>) => { setCredentials({ ...credentials, ...patch }); setRemotes(null); setPreview(null) }
  const ready = !!identity?.enabled && identity.baseRevision !== null

  async function check() {
    const value = await previewIdentity(workspace).catch((e) => { throw new Error(identityError(e)) })
    setIdentity(value)
    if (!value.enabled) throw new Error('identity_missing')
    const list = await probeEndpoint(credentials.endpoint, credentials.username, credentials.password)
    setRemotes(list)
    // The workspace's own id on the server means this device is reconnecting.
    if (list.includes(value.workspaceId)) await previewChoice({ kind: 'join', workspaceId: value.workspaceId }, value)
    else setChoice({ kind: 'new' })
  }
  async function previewChoice(next: Choice, current = identity) {
    setChoice(next); setPreview(null); setLink(false)
    if (next.kind === 'join' && current) setPreview(await previewRemote(credentials, next.workspaceId, current.plan.identity))
  }
  async function connect() {
    if (!identity || identity.baseRevision === null) return
    const join = choice.kind === 'join' ? { workspaceId: choice.workspaceId, link: link && preview ? preview.commits : null } : null
    await pairWorkspace(workspace, credentials, identity.plan.identity, identity.baseRevision, join)
    setCredentials({ ...credentials, password: '' })
    sync.refresh()
    setMessage('已连接。首次同步会在后台进行，状态显示在此对话框和标签栏。')
  }

  return <section>
    <h3>连接服务器</h3>
    <label>WebDAV 地址 <input type="url" autoComplete="url" placeholder="https://example.com/remote.php/dav/files/用户名/" value={credentials.endpoint} disabled={busy} onChange={(e) => edit({ endpoint: e.target.value })} /></label>
    <label>用户名 <input autoComplete="username" value={credentials.username} disabled={busy} onChange={(e) => edit({ username: e.target.value })} /></label>
    <label>密码或应用密码 <input type="password" autoComplete="current-password" value={credentials.password} disabled={busy} onChange={(e) => edit({ password: e.target.value })} /></label>
    <div className="dialog-actions">
      <button disabled={busy || !credentials.endpoint || !credentials.username || !credentials.password} onClick={() => void task(check, (e) => e instanceof Error && e.message === 'identity_missing' ? '请先在 EM 菜单 →“同步身份”中启用工作区身份。' : e instanceof Error && !/^[a-z_:0-9]+$/.test(e.message) ? e.message : syncError(e))}>检查连接</button>
    </div>
    {remotes && ready && <fieldset>
      <legend>同步方式</legend>
      <label><input type="radio" name="sync-choice" checked={choice.kind === 'new'} disabled={busy} onChange={() => void task(() => previewChoice({ kind: 'new' }))} /> 作为新的同步工作区上传（{identity!.plan.identity.documents.length} 个文档）</label>
      {remotes.map((id) => <label key={id}><input type="radio" name="sync-choice" checked={choice.kind === 'join' && choice.workspaceId === id} disabled={busy} onChange={() => void task(() => previewChoice({ kind: 'join', workspaceId: id }))} /> 加入服务器上已有的工作区 {id.slice(0, 8)}{id === identity!.workspaceId ? '（本工作区）' : ''}</label>)}
      {choice.kind === 'join' && preview && <p role="status">将下载 {preview.download} 个文档、上传 {preview.upload} 个；{preview.devices} 台设备已在使用。</p>}
      {choice.kind === 'join' && preview && preview.collisions.length > 0 && <div>
        <p>两边都有同名文档：{preview.collisions.join('、')}</p>
        <label><input type="radio" name="sync-link" checked={!link} disabled={busy} onChange={() => setLink(false)} /> 保留两份：远端版本另存为“同步副本”</label>
        <label><input type="radio" name="sync-link" checked={link} disabled={busy} onChange={() => setLink(true)} /> 视为同一文档：内容相同不重复下载，内容不同时远端版本另存为副本</label>
      </div>}
      <p className="panel-note">连接前不会改动任何文件。本机文档不会被删除或覆盖。</p>
      <div className="dialog-actions"><button disabled={busy || (choice.kind === 'join' && !preview)} onClick={() => void task(connect)}>连接并同步</button></div>
    </fieldset>}
  </section>
}
