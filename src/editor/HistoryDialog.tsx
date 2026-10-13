import { useEffect, useRef, useState } from 'react'
import { decodeFile, type FileSnapshot } from '../core/codec'
import type { HistoryDiff } from '../core/history-diff'
import type { ImageResources } from '../platform/images'
import { sourceHash } from '../platform/images'
import { collectHistoryResources } from '../platform/history-resources'
import { desktop, readImageBlob } from '../platform/storage'
import { compareHistory, historyError, historyInput, historyOperation, type CleanupPlan, type HistorySnapshot, type HistoryStatus } from '../platform/history'

interface Props {
  fileId: string | null; text: string; bytes: Uint8Array | null; snapshot: FileSnapshot; revision: string | null; resources: ImageResources
  onClose(): void
  onRestore(snapshotId: string): Promise<void>
}
const reasons: Record<string, string> = { baseline: '启用基线', manual: '手动', automatic: '自动保存', 'pre-save': '首次保存前', 'pre-restore': '恢复前', restore: '恢复结果', 'pre-batch': '批处理前', batch: '批处理结果' }
const volume = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`
export function HistoryDialog(props: Props) {
  const { fileId, text, bytes, revision, resources, snapshot, onClose, onRestore } = props
  const dialog = useRef<HTMLDivElement>(null), task = useRef<AbortController | null>(null), mounted = useRef(true)
  const [history, setHistory] = useState<HistoryStatus | null>(null), [selected, setSelected] = useState<HistorySnapshot | null>(null)
  const [target, setTarget] = useState<FileSnapshot | null>(null), [diff, setDiff] = useState<HistoryDiff | null>(null)
  const [busy, setBusy] = useState(false), [comparing, setComparing] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const [name, setName] = useState(''), [budget, setBudget] = useState('512'), [cleanup, setCleanup] = useState<CleanupPlan | null>(null)
  const [remove, setRemove] = useState<string[]>([]), [confirmRestore, setConfirmRestore] = useState(false)
  const [thumbnails, setThumbnails] = useState<{ path: string; url: string }[]>([]), [imageChanges, setImageChanges] = useState<string[]>([])
  const available = desktop && !!fileId
  useEffect(() => {
    mounted.current = true
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => { mounted.current = false; task.current?.abort() }
  }, [])
  const applyStatus = (value: HistoryStatus) => { setHistory(value); setBudget(String(value.budgetBytes / 1024 / 1024)); setRemove([]); setCleanup(null) }
  async function action(work: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError('')
    try { await work() } catch (e) { if (mounted.current) setError(historyError(e)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const query = <T,>(request: Record<string, unknown>) => historyOperation<T>(fileId!, request)
  useEffect(() => {
    if (!available) return
    let live = true
    setBusy(true)
    void query<HistoryStatus>({ action: 'status' }).then(value => { if (live) applyStatus(value) }).catch(e => { if (live) setError(historyError(e)) }).finally(() => { if (live) setBusy(false) })
    return () => { live = false }
    // The host locks current text and authorization for this panel's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId])
  useEffect(() => {
    if (!selected || !target || !fileId) return
    let alive = true; const urls: string[] = []
    setThumbnails([]); setImageChanges([])
    void (async () => {
      const [{ references }] = await collectHistoryResources([text])
      if (!alive) return
      const pictures = [], changes = [], referenced = new Set(references), current = new Set(referenced)
      for (const resource of selected.resources) {
        if (!alive) return
        if (resource.role === 'source') continue
        if (!current.delete(resource.path)) changes.push(`− 引用 ${resource.path}`)
        else {
          try {
            const blob = resources.assets[resource.path] ?? await readImageBlob(fileId, resource.path)
            const hash = (await sourceHash(blob)).replace('sha256:', '')
            changes.push(hash === resource.hash ? `= 图片字节相同 ${resource.path}` : `~ 图片内容变化 ${resource.path}`)
          } catch { changes.push(`? 当前图片缺失 ${resource.path}`) }
        }
        if (resource.hash && pictures.length < 12) {
          try {
            const value = await historyOperation<{ bytes: number[]; mime: string }>(fileId, { action: 'object', snapshotId: selected.snapshotId, hash: resource.hash })
            if (!alive) return
            const url = URL.createObjectURL(new Blob([new Uint8Array(value.bytes)], { type: value.mime })); urls.push(url); pictures.push({ path: resource.path, url })
          } catch { changes.push(`! 归档图片校验失败 ${resource.path}`) }
        }
      }
      for (const path of current) changes.push(`+ 引用 ${path}`)
      const targetInstances = selected.metadata.instances
      for (const instance of resources.instances.filter(i => referenced.has(i.displayPath))) {
        const old = targetInstances.find(i => i.instanceId === instance.instanceId)
        if (!old) changes.push(`+ 图片实例 ${instance.instanceId}`)
        else if (JSON.stringify(old.recipe) !== JSON.stringify(instance.recipe)) changes.push(`~ 图片参数变化 ${instance.instanceId}`)
      }
      for (const instance of targetInstances) if (!resources.instances.some(i => i.instanceId === instance.instanceId)) changes.push(`− 图片实例 ${instance.instanceId}`)
      if (alive) { setThumbnails(pictures); setImageChanges(changes) }
    })().catch(e => { if (alive) setImageChanges([`! 图片对照未完成：${historyError(e)}`]) })
    return () => { alive = false; urls.forEach(URL.revokeObjectURL) }
  }, [selected, target, fileId, text, resources])
  async function select(item: HistorySnapshot) {
    task.current?.abort(); setSelected(item); setName(item.name ?? ''); setTarget(null); setDiff(null); setConfirmRestore(false); setComparing(true); setError('')
    const controller = new AbortController(); task.current = controller
    try {
      const detail = await query<{ bytes: number[] }>({ action: 'detail', snapshotId: item.snapshotId })
      if (controller.signal.aborted) return
      const decoded = decodeFile(new Uint8Array(detail.bytes)); setTarget(decoded)
      const result = await compareHistory(decoded.text, text, controller.signal)
      if (!controller.signal.aborted) setDiff(result)
    } catch (e) { if (!controller.signal.aborted) setError(historyError(e)) }
    finally { if (task.current === controller) { task.current = null; setComparing(false) } }
  }
  const close = () => { if (!busy) { task.current?.abort(); onClose() } }
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); close() } }
    document.addEventListener('keydown', escape, true)
    return () => document.removeEventListener('keydown', escape, true)
  })
  return <div className="modal-backdrop history-backdrop" onKeyDown={event => {
    if (event.key !== 'Tab') return
    const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea') ?? [])
    event.preventDefault(); const index = controls.indexOf(document.activeElement as HTMLElement)
    controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus()
  }}>
    <div className="history-dialog" role="dialog" aria-modal="true" aria-labelledby="history-title" ref={dialog} aria-busy={busy}>
      <div className="panel-title"><h2 id="history-title">版本历史</h2><button disabled={busy} onClick={close}>关闭版本历史</button></div>
      {!available && <p>{desktop ? '请先通过 EM 菜单另存为，保存文件后可启用持久版本历史。' : '版本历史是桌面本地功能。浏览器草稿仍使用本机草稿恢复；请在 EasyM 桌面版中打开已保存文件。'}</p>}
      {history?.warning && <p role="alert">{history.warning}</p>}
      {available && !history?.enabled && !history?.readOnly && <section>
        <p>启用后，正文与本地 PNG/JPEG 图片会归档到文档目录的 <code>.easym/history/</code>。复制或分享目录时，历史内容也可能一起分享。版本历史不能代替备份。</p>
        <button disabled={busy || !history} onClick={() => void action(async () => { const [references] = await collectHistoryResources([snapshot.originalText]); applyStatus(await query<HistoryStatus>({ action: 'enable', ...references, expectedRevision: revision })); setMessage('已启用，并归档磁盘基线。') })}>启用版本历史</button>
        {!!history?.orphans.length && <label>明确重新关联移动 / 重命名的历史<select aria-label="重新关联历史" defaultValue="" disabled={busy} onChange={event => {
          const documentId = event.target.value
          if (documentId && window.confirm('将当前路径明确关联到选定历史？仅可关联原路径已不存在的同目录历史。')) void action(async () => applyStatus(await query<HistoryStatus>({ action: 'reassociate', documentId })))
        }}><option value="">选择原路径</option>{history.orphans.map(item => <option value={item.documentId} key={item.documentId}>{item.path}</option>)}</select></label>}
      </section>}
      {history?.enabled && !history.readOnly && <>
        <div className="history-controls">
          <label>快照名称<input aria-label="快照名称" maxLength={128} value={name} disabled={busy} onChange={e => setName(e.target.value)} /></label>
          <button disabled={busy || !bytes} onClick={() => void action(async () => { applyStatus(await query<HistoryStatus>({ action: 'capture', input: await historyInput(bytes!, resources, revision), name: name || null })); setMessage('当前编辑已创建手动快照，正文没有被保存或替换。') })}>创建快照</button>
          <button disabled={busy} onClick={() => void action(async () => applyStatus(await query<HistoryStatus>({ action: 'status' })))}>刷新历史</button>
          <label>目录配额 MiB<input aria-label="历史配额 MiB" type="number" min={1} max={4096} value={budget} disabled={busy} onChange={e => setBudget(e.target.value)} /></label>
          <button disabled={busy} onClick={() => void action(async () => applyStatus(await query<HistoryStatus>({ action: 'configure', budgetMiB: Number(budget) })))}>更新配额</button>
        </div>
        <p className="history-note">使用 {volume(history.usedBytes)} / {volume(history.budgetBytes)}；自动快照最少间隔 60 秒。清理候选：超过 30 天或最近 100 个以外的自动版本；手动、固定和恢复前版本受保护。</p>
        {history.paused && <p role="alert">历史空间不足，新增快照已暂停；请清理或提高配额。</p>}
        {!bytes && <p role="alert">当前为混合换行且有编辑，请先确认并保存换行格式，再创建快照或恢复。</p>}
        <div className="history-columns"><section className="history-list" aria-label="历史快照列表">
          {!history.snapshots.length && <p>还没有快照；可重试创建手动快照。</p>}
          {history.snapshots.map(item => <div key={item.snapshotId} className={`history-item ${selected?.snapshotId === item.snapshotId ? 'selected' : ''}`}>
            <input type="checkbox" aria-label={`选择清理 ${item.snapshotId}`} disabled={busy || !!item.pinned} checked={remove.includes(item.snapshotId)} onChange={e => { setCleanup(null); setRemove(e.target.checked ? [...remove, item.snapshotId] : remove.filter(id => id !== item.snapshotId)) }} />
            <button disabled={busy} aria-pressed={selected?.snapshotId === item.snapshotId} onClick={() => void select(item)}><strong>{item.name || reasons[item.reason] || item.reason}{item.pinned ? ' · 固定' : ''}</strong><span>{new Date(item.createdAt).toLocaleString()} · {reasons[item.reason]}</span><span>{item.complete ? '完整' : '缺少图片'} · 正文 {volume(item.bodySize)} · 图片 {volume(item.resources.reduce((n, r) => n + r.size, 0))}</span></button>
          </div>)}
        </section><section className="history-detail" aria-label="版本差异">
          {!selected && <p>选择一个版本，查看正文、图片和与当前编辑的差异。</p>}
          {selected && <>
            {!!selected.unarchivedReferences?.length && <p role="alert">未归档的本地引用：{selected.unarchivedReferences.join('、')}。仅可另存正文。</p>}
            <div className="history-controls"><button disabled={busy} onClick={() => void action(async () => {
              const value = await query<HistoryStatus>({ action: 'annotate', snapshotId: selected.snapshotId, name: name || null, pinned: !!selected.pinned }); applyStatus(value); setSelected(value.snapshots.find(s => s.snapshotId === selected.snapshotId) ?? null)
            })}>保存名称</button><button disabled={busy} aria-pressed={!!selected.pinned} onClick={() => void action(async () => {
              const value = await query<HistoryStatus>({ action: 'annotate', snapshotId: selected.snapshotId, name: selected.name ?? null, pinned: !selected.pinned }); applyStatus(value); setSelected(value.snapshots.find(s => s.snapshotId === selected.snapshotId) ?? null)
            })}>{selected.pinned ? '取消固定' : '固定快照'}</button>
              <button disabled={busy || !target} onClick={() => void action(async () => { const result = await query<{ warning?: string } | null>({ action: 'copy', snapshotId: selected.snapshotId, bodyOnly: false }); setMessage(result ? result.warning ?? '完整副本已保存，保持目标原始正文的编码与换行。' : '另存已取消。') })}>另存完整副本</button>
              <button disabled={busy || !target} onClick={() => { if (window.confirm('仅另存原始正文，图片可能缺失。继续？')) void action(async () => { const result = await query<unknown>({ action: 'copy', snapshotId: selected.snapshotId, bodyOnly: true }); setMessage(result ? '正文副本已保存；图片未复制，请检查缺图。' : '另存已取消。') }) }}>仅另存正文</button>
            </div>
            {target && <p>归档 {target.encoding.toUpperCase()} / {target.lineEnding.toUpperCase()}；当前 {snapshot.encoding.toUpperCase()} / {snapshot.lineEnding.toUpperCase()}。{target.encoding !== snapshot.encoding || target.lineEnding !== snapshot.lineEnding ? '存在字节格式差异；恢复沿用当前文件格式，完整副本保留归档原始字节。' : '编码与换行策略相同。'}</p>}
            {comparing && <p role="status">正在后台比较… <button onClick={() => { task.current?.abort(); task.current = null; setComparing(false); setDiff({ lines: [], additions: 0, deletions: 0, fallback: '已取消逐行差异；请查看双方全文。' }) }}>取消差异计算</button></p>}
            {diff && <><p>{diff.fallback ?? `+ 新增 ${diff.additions} 行 / − 删除 ${diff.deletions} 行（归档 → 当前）`}</p>{!diff.fallback && <pre className="history-diff" aria-label="逐行差异">{diff.lines.slice(0, 4000).map((line, i) => <span key={i} className={`diff-${line.kind}`}>{line.kind === 'add' ? '+' : line.kind === 'delete' ? '−' : ' '} {line.before ?? '·'}:{line.after ?? '·'} {line.text}{'\n'}</span>)}{diff.lines.length > 4000 && '…仅展示前 4000 行，双方全文如下。'}</pre>}</>}
            {target && <div className="history-texts"><label>归档正文<textarea readOnly aria-label="归档正文" value={target.text} /></label><label>当前正文<textarea readOnly aria-label="当前正文" value={text} /></label></div>}
            {!!imageChanges.length && <><h3>图片与实例变化</h3><p>引用路径变化与图片字节变化分别记录。</p><ul>{imageChanges.map((change, i) => <li key={i}>{change}</li>)}</ul></>}
            {!!thumbnails.length && <div className="history-thumbnails">{thumbnails.map(item => <figure key={item.path}><img src={item.url} alt={`归档 ${item.path}`} /><figcaption>{item.path}</figcaption></figure>)}</div>}
            <button className="apply-button" disabled={busy || comparing || !diff || !target || !selected.complete || !bytes || snapshot.lineEnding === 'mixed'} onClick={() => setConfirmRestore(true)}>恢复此版本…</button>
            {confirmRestore && <div className="history-confirm" role="group" aria-label="确认恢复版本"><p>已显示归档与当前的差异。确认后将保存当前版本为恢复前快照，恢复正文和归档图片，并保存到当前文件；可一次撤销。外部冲突将阻止覆盖。</p><button disabled={busy} onClick={() => setConfirmRestore(false)}>取消恢复</button><button disabled={busy} onClick={() => void action(async () => { await onRestore(selected.snapshotId) })}>确认恢复并保存</button></div>}
          </>}
        </section></div>
        <div className="history-cleanup"><button disabled={busy} onClick={() => void action(async () => { setCleanup(await query<CleanupPlan>({ action: 'cleanupPreview', selected: remove })); setMessage('清理预览已生成，尚未删除任何数据。') })}>预览清理{remove.length ? `（选中 ${remove.length} 个）` : '（过期自动快照 / 孤立对象）'}</button>
          {cleanup && <div role="group" aria-label="确认历史清理"><p>拟删除 {cleanup.candidates.length} 个快照，预计回收对象 {volume(cleanup.reclaimBytes)}。只清理当前目录的历史，不删除正文、assets 或草稿。</p><ul>{cleanup.candidates.map(item => <li key={item.snapshotId}>{item.document} · {new Date(item.createdAt).toLocaleString()} · {item.name || reasons[item.reason]}</li>)}</ul><button disabled={busy} onClick={() => setCleanup(null)}>取消清理</button><button disabled={busy} onClick={() => void action(async () => { applyStatus(await query<HistoryStatus>({ action: 'cleanupCommit', selected: remove, token: cleanup.token })); setSelected(null); setTarget(null); setDiff(null); setMessage('清理完成。手动选择的未固定版本和过期自动版本已处理。') })}>确认清理</button></div>}
        </div>
      </>}
      {error && <p role="alert" className="image-error">{error}</p>}
      <p role="status" aria-live="polite">{busy ? '正在处理，请稍候…' : message}</p>
    </div>
  </div>
}
