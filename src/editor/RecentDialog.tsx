import { useEffect, useRef, useState } from 'react'
import { ApplicationDialog } from './ApplicationDialogs'
import { recentState, forgetRecent, recentError, type RecentEntry } from '../platform/recent'

export function RecentDialog({ open, close }: { open(entry: RecentEntry, current: () => boolean): Promise<void>; close(): void }) {
  const [entries, setEntries] = useState<RecentEntry[]>([]), [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const generation = useRef(0), running = useRef(false)
  useEffect(() => {
    const token = ++generation.current
    recentState().then(result => { if (token === generation.current) setEntries(result.entries) }).catch(e => { if (token === generation.current) setError(recentError(e)) }).finally(() => { if (token === generation.current) setLoading(false) })
    return () => { generation.current++ }
  }, [])
  async function action(entry: RecentEntry | null, remove: boolean) {
    if (running.current) return
    running.current = true; setBusy(true); setError('')
    const token = ++generation.current
    try {
      if (remove) { await forgetRecent(entry?.id ?? null); const result = await recentState(); if (token === generation.current) setEntries(result.entries) }
      else if (entry) await open(entry, () => token === generation.current)
    } catch (e) { if (token === generation.current) setError(recentError(e)) }
    finally { running.current = false; if (token === generation.current) setBusy(false) }
  }
  return <ApplicationDialog title="最近打开" onClose={close}>
    <p>最近 30 个文件和 10 个工作区。重开会复用已有标签，保留当前编辑。移除记录不删除文件、草稿或版本历史。</p>
    {error && <p role="alert">{error}</p>}
    {loading ? <p role="status">正在读取最近记录…</p> : !entries.length && <p>还没有最近打开记录。</p>}
    <div className="recent-list" aria-busy={busy}>
      {entries.map(entry => <div className="recent-row" key={entry.id}>
        <button disabled={busy || loading} className="recent-open" title={entry.location} onClick={() => void action(entry, false)}><strong>{entry.kind === 'workspace' ? '工作区 · ' : ''}{entry.name}</strong><small>{entry.location}</small></button>
        <button disabled={busy || loading} aria-label={`移除记录 ${entry.name}`} onClick={() => void action(entry, true)}>移除</button>
      </div>)}
    </div>
    <div className="dialog-actions"><button disabled={busy || loading || !entries.length} onClick={() => void action(null, true)}>清空最近记录</button><button onClick={close}>完成</button></div>
  </ApplicationDialog>
}
