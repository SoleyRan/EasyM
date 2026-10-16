import { useEffect, useRef, useState } from 'react'
import { ApplicationDialog } from './ApplicationDialogs'
import { backupError, createBackup, inspectBackup, releaseBackup, restoreBackup, validateBackup, type BackupDraft, type BackupInspection } from '../platform/backup'

export function BackupDialog({ draft, onClose }: { draft: BackupDraft; onClose(): void }) {
  const [includeHistory, setIncludeHistory] = useState(false), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [confirmed, setConfirmed] = useState(false)
  const [inspection, setInspection] = useState<{ value: BackupInspection; references: string[][] } | null>(null)
  const running = useRef(false), alive = useRef(true), token = useRef<string | null>(null)
  function release() { const value = token.current; token.current = null; if (value) void releaseBackup(value).catch(() => {}) }
  useEffect(() => { alive.current = true; return () => { alive.current = false; release() } }, [])
  async function task(action: () => Promise<void>) {
    if (running.current) return
    running.current = true; setBusy(true); setError(''); setMessage('')
    try { await action() } catch (e) { if (alive.current) setError(backupError(e)) }
    finally { running.current = false; if (alive.current) setBusy(false) }
  }
  async function inspect() {
    release(); setInspection(null); setConfirmed(false)
    const value = await inspectBackup()
    if (!value) { if (alive.current) setMessage('已取消选择备份。'); return }
    if (!alive.current) { void releaseBackup(value.token).catch(() => {}); return }
    token.current = value.token
    try {
      const references = await validateBackup(value)
      if (alive.current) setInspection({ value, references })
    } catch (e) { release(); throw e }
  }
  return <ApplicationDialog title="文档备份与恢复" busy={busy} onClose={() => { if (!running.current) onClose() }}>
    <section><h3>创建当前文档备份</h3>
      <p>备份打开窗口时的正文（含未保存编辑）、引用的 PNG/JPEG 及图片编辑资源。远程图片保留链接。备份可能含私有内容，请妥善保管。</p>
      <p className="panel-note">文档：{draft.name}</p>
      <label className="setting-row"><span>包含此文档已登记的版本历史</span><input type="checkbox" checked={includeHistory} disabled={busy || !draft.id} onChange={e => setIncludeHistory(e.target.checked)} /></label>
      <p>默认只备份当前文档；勾选后包含此文档的快照、命名与固定状态。历史损坏或缺失时请取消勾选后重试。新文档请先另存后再包含历史。</p>
      {draft.error && <p role="note">{backupError(draft.error)}</p>}
      <button disabled={busy || !draft.bytes} onClick={() => void task(async () => { const result = await createBackup(draft, includeHistory); if (alive.current) setMessage(result ? `备份已创建并校验：${result.documentName}，${result.files} 个文件。` : '已取消创建备份。') })}>创建备份…</button>
    </section>
    <section><h3>从备份恢复</h3>
      <p>选择 .easym-backup.zip 后校验格式、全部哈希、路径、资源及历史。确认后选择父目录，恢复到新的 EasyM-restored 目录。当前编辑内容保持不变。</p>
      <button disabled={busy} onClick={() => void task(inspect)}>选择并校验备份…</button>
      {inspection && <><dl style={{ overflowWrap: 'anywhere' }}><dt>文档</dt><dd>{inspection.value.summary.documentName}</dd><dt>创建时间</dt><dd>{new Date(inspection.value.summary.createdAt).toLocaleString()}</dd><dt>内容</dt><dd>{inspection.value.summary.files} 个文件 · {(inspection.value.summary.bytes / 1024).toFixed(1)} KiB · {inspection.value.summary.includesHistory ? '含此文档版本历史' : '仅当前文档'}</dd></dl>
        <p className="panel-note" style={{ overflowWrap: 'anywhere' }}>校验值：{inspection.value.summary.packageHash}</p>
        <label className="setting-row"><span>已审查备份信息，确认恢复到新目录</span><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} /></label>
        <button disabled={busy || !confirmed} onClick={() => void task(async () => {
          const path = await restoreBackup(inspection.value.token, inspection.references)
          if (!alive.current) return
          if (path) { token.current = null; setInspection(null); setConfirmed(false); setMessage(`已恢复到：${path}。可从 EM → 打开文件打开恢复副本。`) }
          else setMessage('已取消选择恢复目录，尚未恢复。')
        })}>选择父目录并恢复…</button>
      </>}
    </section>
    {error && <p role="alert">{error}</p>}
    <p role="status" className="panel-note" style={{ overflowWrap: 'anywhere' }}>{busy ? '正在处理并校验，请稍候…' : message}</p>
    <div className="dialog-actions"><button disabled={busy} onClick={onClose}>完成</button></div>
  </ApplicationDialog>
}
