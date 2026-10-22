import { useEffect, useRef, useState } from 'react'
import { ApplicationDialog } from './ApplicationDialogs'
import type { IdentityResolution, PauseReason } from '../core/sync-identity'
import { commitIdentity, disableIdentity, identityError, previewIdentity, type IdentityPreview } from '../platform/sync-identity'
import { syncHash } from '../core/sync-contract'
import { encodeWorkspaceIdentity } from '../core/sync-identity'

const reasons: Record<PauseReason, string> = {
  possible_move: '可能是外部移动或重命名',
  duplicate_history_id: '与其他文档共用同一历史身份（可能是复制的目录）',
  path_conflict: '与其他路径仅大小写或 Unicode 规范化不同',
  unportable_path: '文件名无法在 Windows、macOS、Linux 上同时保存',
  history_unreadable: '所在目录的版本历史无法校验',
}
type Choice = '' | 'assign' | `bind:${string}`

/** Explicit preview/confirm flow for `.easym/sync/workspace.json`. Never edits documents. */
export function IdentityDialog({ workspace, name, onClose }: { workspace: string; name: string; onClose(): void }) {
  const [preview, setPreview] = useState<IdentityPreview | null>(null), [error, setError] = useState(''), [message, setMessage] = useState('')
  const [busy, setBusy] = useState(true), [choices, setChoices] = useState<Record<string, Choice>>({}), [forget, setForget] = useState<Set<string>>(new Set())
  const generation = useRef(0)
  async function load() {
    const token = ++generation.current
    setBusy(true); setError(''); setChoices({}); setForget(new Set())
    try { const value = await previewIdentity(workspace); if (token === generation.current) setPreview(value) }
    catch (e) { if (token === generation.current) { setPreview(null); setError(identityError(e)) } }
    finally { if (token === generation.current) setBusy(false) }
  }
  useEffect(() => { void load(); return () => { generation.current++ } }, [workspace])
  const plan = preview?.plan
  const resolutions: IdentityResolution[] = [
    ...Object.entries(choices).flatMap(([path, choice]): IdentityResolution[] => choice === 'assign' ? [{ kind: 'assign', path }] : choice.startsWith('bind:') ? [{ kind: 'bind', path, documentId: choice.slice(5) }] : []),
    ...[...forget].map((documentId): IdentityResolution => ({ kind: 'forget', documentId })),
  ]
  const boundTargets = new Set(Object.values(choices).filter((c) => c.startsWith('bind:')).map((c) => c.slice(5)))
  const pending = !!plan && (plan.changed || resolutions.length > 0)
  async function run(action: () => Promise<string>) {
    setBusy(true); setError(''); setMessage('')
    try { const text = await action(); setMessage(text); await load() }
    catch (e) { setError(identityError(e)); setBusy(false) }
  }
  return <ApplicationDialog title="同步身份" busy={busy} onClose={() => { if (!busy) onClose() }}>
    <p>为工作区「{name}」中的 Markdown 文档记录持久身份，保存在 <code>.easym/sync/workspace.json</code>。只记录相对路径与身份，不含设备路径、端点或凭据；不改写正文、图片或版本历史。</p>
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {busy && !plan && <p role="status">正在扫描工作区…</p>}
    {plan && preview && <>
      <p className="panel-note">{preview.enabled ? '已启用' : '尚未启用'} · 工作区身份 {preview.workspaceId.slice(0, 8)} · 已记录 {plan.identity.documents.length - plan.added.length} 个文档</p>
      {plan.added.length > 0 && <section><h3>{preview.enabled ? '新增文档' : '将记录的文档'}（{plan.added.length}）</h3>
        <ul className="identity-list">{plan.added.slice(0, 200).map((doc) => <li key={doc.path}>{doc.path}{doc.reusedHistory && <small>（沿用版本历史身份）</small>}</li>)}</ul>
        {plan.added.length > 200 && <p className="panel-note">另有 {plan.added.length - 200} 个未列出。</p>}
      </section>}
      {plan.paused.length > 0 && <section><h3>需要确认（{plan.paused.length}）</h3>
        <p>以下文档暂不记录身份。EasyM 不会根据内容猜测文档身份。</p>
        <ul className="identity-list">{plan.paused.map((item) => {
          const resolvable = item.reason === 'possible_move' || item.reason === 'duplicate_history_id'
          return <li key={item.path}><span>{item.path}</span> <small>{reasons[item.reason]}</small>
            {resolvable && <label> 处理：<select disabled={busy} value={choices[item.path] ?? ''} onChange={(e) => setChoices({ ...choices, [item.path]: e.target.value as Choice })}>
              <option value="">暂不处理</option>
              <option value="assign">作为新文档</option>
              {item.reason === 'possible_move' && plan.missing.filter((doc) => !forget.has(doc.documentId) && (!boundTargets.has(doc.documentId) || choices[item.path] === `bind:${doc.documentId}`)).map((doc) => <option key={doc.documentId} value={`bind:${doc.documentId}`}>是 {doc.path} 移动后的版本</option>)}
            </select></label>}
          </li>
        })}</ul>
      </section>}
      {plan.missing.length > 0 && <section><h3>已记录但找不到（{plan.missing.length}）</h3>
        <p>身份会保留，直到确认已删除或与上方文档关联。</p>
        <ul className="identity-list">{plan.missing.map((doc) => <li key={doc.documentId}><label><input type="checkbox" disabled={busy || boundTargets.has(doc.documentId)} checked={forget.has(doc.documentId)} onChange={(e) => { const next = new Set(forget); if (e.target.checked) next.add(doc.documentId); else next.delete(doc.documentId); setForget(next) }} /> 已在外部删除：{doc.path}</label></li>)}</ul>
      </section>}
      {!pending && !plan.paused.length && !plan.missing.length && <p>身份记录与磁盘一致，无需更改。</p>}
    </>}
    <div className="dialog-actions">
      {preview?.enabled && preview.baseRevision && <button disabled={busy} onClick={() => { if (window.confirm('停用将删除 .easym/sync/workspace.json；文档、图片和版本历史不受影响。确定？')) void run(async () => { await disableIdentity(workspace, preview.baseRevision as string); return '已停用同步身份，仅删除了身份文件。' }) }}>停用</button>}
      <button disabled={busy} onClick={() => void load()}>重新扫描</button>
      <button disabled={busy || !pending || !preview} onClick={() => preview && void run(async () => {
        const identity = await commitIdentity(workspace, preview, resolutions)
        const revision = await syncHash(encodeWorkspaceIdentity(identity))
        return `${preview.enabled ? '已更新' : '已启用'}同步身份：${identity.documents.length} 个文档（${revision.slice(7, 15)}）。`
      })}>{preview?.enabled ? '应用更改' : '启用'}</button>
      <button disabled={busy} onClick={onClose}>完成</button>
    </div>
  </ApplicationDialog>
}
