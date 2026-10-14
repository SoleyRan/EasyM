import { useEffect, useRef, useState } from 'react'
import { ApplicationDialog } from './ApplicationDialogs'
import { compareHistory } from '../platform/history'
import type { HistoryDiff } from '../core/history-diff'
import type { FileSnapshot } from '../core/codec'

export function ExternalChangeDialog({ disk, local, onClose, onReload, onSaveCopy, onLocate }: {
  disk: FileSnapshot; local: string; onClose(): void; onReload(): Promise<void>; onSaveCopy(): Promise<void>; onLocate(offset: number): void
}) {
  const [diff, setDiff] = useState<HistoryDiff | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false), running = useRef(false)
  useEffect(() => {
    const task = new AbortController()
    compareHistory(disk.text, local, task.signal).then(setDiff).catch(e => { if (!task.signal.aborted) setError(String(e)) })
    return () => task.abort()
  }, [disk, local])
  async function action(work: () => Promise<void>) {
    if (running.current) return
    running.current = true; setBusy(true); setError('')
    try { await work() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { running.current = false; setBusy(false) }
  }
  const first = diff?.lines.find(line => line.kind !== 'context' && line.after !== undefined)?.after
  const offset = first === undefined ? 0 : local.split('\n').slice(0, first - 1).reduce((sum, line) => sum + line.length + 1, 0)
  return <ApplicationDialog title="外部版本对比" onClose={onClose} busy={busy}>
    <p>自动保存已暂停，当前编辑与草稿保留。差异方向为「磁盘 → 本地」，可选择、复制双方正文；确认加载后会替换本地编辑。</p>
    <p>磁盘：{disk.encoding} · {disk.lineEnding}。即使正文相同，编码或换行变化也会提示。</p>
    {error && <p role="alert">{error}</p>}
    {!diff ? <p role="status">正在计算差异…</p> : <>
      <p>{diff.fallback ?? `新增 ${diff.additions} 行 / 删除 ${diff.deletions} 行`}</p>
      {!diff.fallback && <pre className="history-diff" aria-label="逐行差异">{diff.lines.slice(0, 4000).map((line, i) => <span key={i} className={`diff-${line.kind}`}>{line.kind === 'add' ? '+' : line.kind === 'delete' ? '−' : ' '} {line.before ?? '·'}:{line.after ?? '·'} {line.text}{'\n'}</span>)}{diff.lines.length > 4000 && '仅展示前 4000 行，双方全文如下。'}</pre>}
    </>}
    <div className="history-texts"><label>磁盘正文<textarea readOnly aria-label="磁盘正文" value={disk.text} /></label><label>本地正文<textarea readOnly aria-label="本地正文" value={local} /></label></div>
    {confirm && <p role="alert">加载将放弃当前本地编辑。建议先另存本地副本。<button disabled={busy} onClick={() => void action(onReload)}>确认加载磁盘版本</button><button disabled={busy} onClick={() => setConfirm(false)}>取消加载</button></p>}
    <div className="dialog-actions">
      <button disabled={busy || !diff || !!diff.fallback} onClick={() => onLocate(offset)}>定位本地差异</button>
      <button disabled={busy} onClick={() => void action(onSaveCopy)}>另存本地副本</button>
      <button disabled={busy} onClick={() => setConfirm(true)}>加载磁盘版本</button>
      <button disabled={busy} onClick={onClose}>保留本地编辑</button>
    </div>
  </ApplicationDialog>
}
