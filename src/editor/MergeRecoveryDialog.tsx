import { useEffect, useState } from 'react'
import { ApplicationDialog } from './ApplicationDialogs'
import { listMergeRecovery, restoreMergeCopy, mergeError, type MergeRecord, type RecoverySide } from '../platform/merge-transaction'

export function MergeRecoveryDialog({ fileId, onClose }: { fileId: string; onClose(): void }) {
  const [records, setRecords] = useState<MergeRecord[]>([]), [loading, setLoading] = useState(true)
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    listMergeRecovery(fileId).then(value => { if (alive) { setRecords(value.records); setMessage(value.warnings.join('\n')) } }).catch(e => { if (alive) setError(mergeError(e)) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [fileId])
  async function recover(operationId: string, side: RecoverySide) {
    if (busy) return
    setBusy(true); setError('')
    try {
      const result = await restoreMergeCopy(fileId, operationId, side)
      if (result) setMessage(`已恢复到新目录：${result.path}。当前文档未改变，可从 EM 菜单打开该副本。`)
    } catch (e) { setError(mergeError(e)) } finally { setBusy(false) }
  }
  return <ApplicationDialog title="合并恢复记录" busy={busy} onClose={onClose}>
    <p>合并前强制保留的共同祖先、本地、磁盘和候选版本，不依赖是否启用版本历史。含旧正文及图片，请作为文档私有数据保管。</p>
    <p>恢复会校验所有文件，并在选择的父目录中新建独立目录，原文件保持不变。中断或未提交的候选也可以取回；候选记录不代表磁盘已成功合并。</p>
    {error && <p role="alert">{error}</p>}{message && <p role="status" className="panel-note">{message}</p>}
    {loading ? <p role="status">正在读取恢复记录…</p> : !records.length ? <p>当前文档没有合并恢复记录。</p> : records.map(record => <section key={record.operationId}>
      <h3>{new Date(record.createdAt).toLocaleString()}</h3><p className="panel-note">{record.recoveryPath}</p>
      <div className="dialog-actions">{(['base', 'local', 'disk', 'result'] as const).map((side, index) => <button key={side} disabled={busy} onClick={() => void recover(record.operationId, side)}>恢复{['共同祖先', '本地版本', '磁盘版本', '合并候选'][index]}副本</button>)}</div>
    </section>)}
  </ApplicationDialog>
}
