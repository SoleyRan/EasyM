import { useModalOverlay } from './Overlay'
import { useEffect, useRef, useState } from 'react'
import type { BatchOptions } from '../core/batch-images'
import { inspectBatch, generateBatch, type BatchItem, type BatchOutput } from '../platform/batch-images'
import type { ImageResources } from '../platform/images'
import { desktop } from '../platform/storage'
import { historyOperation, historyError, type HistoryStatus } from '../platform/history'

interface Props { text: string; fileId: string | null; resources: ImageResources; onClose(): void; onHistory(): void; onApply(outputs: BatchOutput[], options: BatchOptions, operationId: string): Promise<void> }
const size = (n: number) => `${(n / 1024).toFixed(1)} KiB`
export function BatchImageDialog({ text, fileId, resources, onClose, onHistory, onApply }: Props) {
  const [options, setOptions] = useState<BatchOptions>({ maxSide: 1920, format: 'keep', quality: 0.9, stripMetadata: true, background: null })
  const [items, setItems] = useState<BatchItem[]>([]), [selected, setSelected] = useState<number[]>([]), [outputs, setOutputs] = useState<BatchOutput[]>([])
  const [ready, setReady] = useState(false), [phase, setPhase] = useState<'inspect' | 'idle' | 'generate' | 'commit'>('inspect')
  const [error, setError] = useState(''), [message, setMessage] = useState('正在预检…'), [progress, setProgress] = useState(0)
  const [preview, setPreview] = useState(0), [urls, setUrls] = useState<string[]>([])
  const dialog = useRef<HTMLDivElement>(null), task = useRef<AbortController | null>(null), operation = useRef<string | null>(null), live = useRef(true)
  useModalOverlay(dialog, '.app-menu-trigger')
  const committing = useRef(false), processing = useRef(false)
  useEffect(() => {
    live.current = true; const controller = new AbortController(); task.current = controller
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus()
    void (async () => {
      if (!desktop || !fileId) { setMessage('请先在桌面版保存文档，再启用版本历史。'); return }
      const history = await historyOperation<HistoryStatus>(fileId, { action: 'status' })
      if (controller.signal.aborted) return
      if (!history.enabled || history.readOnly) { setMessage(history.warning ?? '请先启用版本历史，提交前需要完整快照。'); return }
      const value = await inspectBatch(text, resources, fileId, controller.signal)
      if (controller.signal.aborted) return
      setItems(value); setReady(true); setSelected(value.flatMap((item, i) => !item.error ? [i] : []).slice(0, 100)); setMessage('选择图片并生成实际对照；尚未修改正文。')
    })().catch(e => { if (!controller.signal.aborted) setError(historyError(e)) }).finally(() => { if (!controller.signal.aborted) setPhase('idle') })
    return () => { live.current = false; controller.abort(); task.current?.abort() }
  }, [])
  useEffect(() => {
    const output = outputs[preview]
    if (!output) { setUrls([]); return }
    const value = [URL.createObjectURL(output.source), URL.createObjectURL(output.result.blob)]; setUrls(value)
    return () => value.forEach(URL.revokeObjectURL)
  }, [outputs, preview])
  useEffect(() => {
    if (phase === 'commit') dialog.current?.focus()
    else if (phase === 'generate') dialog.current?.querySelector<HTMLButtonElement>('[data-cancel-generation]')?.focus()
    else if (!dialog.current?.contains(document.activeElement)) dialog.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [phase])
  const record = (status: string, id: string, value = options) => fileId ? historyOperation(fileId, { action: 'batchRecord', operationId: id, status, options: value }) : Promise.resolve()
  async function cancelGeneration() {
    if (committing.current) return
    task.current?.abort(); setOutputs([])
    const id = operation.current; operation.current = null
    if (id) await record('cancelled', id).catch(e => { if (live.current) setError(`取消日志未写入：${historyError(e)}`) })
    if (live.current) { setPhase('idle'); setMessage('已取消，正文和原资源保持完整。') }
  }
  async function close() { if (committing.current) return; await cancelGeneration(); onClose() }
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); if (!committing.current) void close() }
    }
    document.addEventListener('keydown', escape, true)
    return () => document.removeEventListener('keydown', escape, true)
  })
  async function invalidate(nextOptions = options, nextSelected = selected) {
    if (phase === 'generate' || phase === 'commit') return
    if (operation.current) await cancelGeneration()
    setOptions(nextOptions); setSelected(nextSelected); setOutputs([]); setError('')
  }
  async function generate() {
    if (processing.current || committing.current || !fileId) return
    processing.current = true
    const controller = new AbortController(); task.current = controller; const id = crypto.randomUUID(); operation.current = id
    setError(''); setOutputs([]); setPhase('generate'); setProgress(0); setMessage('正在生成，正文保持原状…')
    try {
      await record('started', id)
      const value = await generateBatch(selected.map(i => items[i]), options, fileId, controller.signal, done => { if (!controller.signal.aborted) setProgress(done) })
      if (!controller.signal.aborted) { setOutputs(value); setPreview(0); setMessage('全部生成成功，请检查前后对照后确认保存。') }
    } catch (e) {
      if (!controller.signal.aborted) { setError(historyError(e)); await record('failed', id).catch(log => setError(`${historyError(e)}；日志写入失败：${historyError(log)}`)); operation.current = null }
    } finally { processing.current = false; if (live.current && task.current === controller) setPhase('idle') }
  }
  async function apply() {
    if (committing.current || !operation.current || !outputs.length) return
    committing.current = true; setPhase('commit'); setError('')
    try { await onApply(outputs, options, operation.current); operation.current = null; onClose() }
    catch (e) { setError(historyError(e)); setMessage('批次未能完整应用；请检查错误，原编辑与草稿仍保留。') }
    finally { committing.current = false; if (live.current) setPhase('idle') }
  }
  const locked = phase === 'generate' || phase === 'commit' || phase === 'inspect'
  return <div className="modal-backdrop history-backdrop" onKeyDown={event => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!committing.current) void close() }
    if (event.key === 'Tab') {
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)') ?? [])
      event.preventDefault(); const i = controls.indexOf(document.activeElement as HTMLElement)
      controls[(i + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus()
    }
  }}>
    <div ref={dialog} tabIndex={-1} className="history-dialog batch-dialog" role="dialog" aria-modal="true" aria-labelledby="batch-title" aria-busy={locked}>
      <div className="panel-title"><h2 id="batch-title">批量处理图片</h2><button disabled={phase === 'commit'} onClick={() => void close()}>关闭批量图片</button></div>
      {!ready && phase !== 'inspect' && desktop && fileId && <button onClick={onHistory}>打开版本历史</button>}
      {ready && <>
        <fieldset disabled={locked} className="batch-options"><legend>输出选项</legend>
          <label>最大长边<input type="number" min={1} max={8192} value={options.maxSide} onChange={e => void invalidate({ ...options, maxSide: Number(e.target.value) })} /></label>
          <label>批量输出格式<select value={options.format} onChange={e => void invalidate({ ...options, format: e.target.value as BatchOptions['format'] })}><option value="keep">保持格式</option><option value="image/png">PNG</option><option value="image/jpeg">JPEG</option></select></label>
          <label>JPEG 质量<input type="number" min={10} max={100} value={Math.round(options.quality * 100)} onChange={e => void invalidate({ ...options, quality: Number(e.target.value) / 100 })} /></label>
          <label><input type="checkbox" checked={options.stripMetadata} onChange={e => void invalidate({ ...options, stripMetadata: e.target.checked })} />去除元数据</label>
          <label><input type="checkbox" checked={options.background !== null} onChange={e => void invalidate({ ...options, background: e.target.checked ? '#ffffff' : null })} />明确选择 JPEG 背景色</label>
          {options.background && <label>JPEG 背景色<input type="color" value={options.background} onChange={e => void invalidate({ ...options, background: e.target.value })} /></label>}
        </fieldset>
        <p>仅缩小当前显示副本。隐私元数据移除与 JPEG 质量分别设置；透明图转 JPEG 需背景色。取消去元数据时仅支持同格式 PNG 描述文本 / JPEG 注释；EXIF、XMP、ICC、IPTC 原样保留会被阻止。基准源与前快照保留原始字节。</p>
        <div className="history-controls"><button disabled={locked} onClick={() => void invalidate(options, items.flatMap((item, i) => item.error ? [] : [i]).slice(0, 100))}>选择前 100 个可用图片</button><button disabled={locked} onClick={() => void invalidate(options, [])}>取消选择</button><span>已选择 {selected.length} / 100</span></div>
        <div className="batch-list" role="group" aria-label="图片实例列表">{items.map((item, i) => <label key={item.reference.from} className="batch-item"><input aria-label={`选择图片 ${i + 1}`} type="checkbox" disabled={locked || !!item.error || (!selected.includes(i) && selected.length >= 100)} checked={selected.includes(i)} onChange={e => void invalidate(options, e.target.checked ? [...selected, i] : selected.filter(value => value !== i))} /><span><strong>{i + 1}. {item.reference.alt || '无 Alt 文本'}</strong><span>{item.reference.url}</span><span>{item.error ?? `${item.width} × ${item.height} · ${size(item.source!.size)}`}</span></span></label>)}</div>
        {!items.length && <p>当前正文没有可解析的图片引用。</p>}
        <div className="history-controls"><button disabled={locked || !selected.length} onClick={() => void generate()}>生成处理对照</button>{phase === 'generate' && <button data-cancel-generation onClick={() => void cancelGeneration()}>取消生成</button>}</div>
        {phase === 'generate' && <progress aria-label="批量图片进度" value={progress} max={selected.length} />}
        {!!outputs.length && <section aria-label="批量处理对照">
          <label>对照图片<select value={preview} onChange={e => setPreview(Number(e.target.value))}>{outputs.map((output, i) => <option value={i} key={output.instance.instanceId}>{i + 1}. {output.reference.alt || '图片'}</option>)}</select></label>
          <p>实际生成总量：{size(outputs.reduce((n, output) => n + output.source.size, 0))} → {size(outputs.reduce((n, output) => n + output.result.blob.size, 0))}（按实例统计）。预计输出体积来自真实生成字节。</p>
          <div className="batch-comparison"><figure><img src={urls[0]} alt="批量处理前" /><figcaption>处理前 {size(outputs[preview].source.size)}</figcaption></figure><figure><img src={urls[1]} alt="批量处理后" /><figcaption>处理后 {outputs[preview].result.width} × {outputs[preview].result.height} · {size(outputs[preview].result.blob.size)}</figcaption></figure></div>
          <p>确认将先保留完整恢复前快照，再一次保存正文和副本；旧资源保留，可整批撤销/重做。提交期间不能取消已派发的磁盘写入。</p>
          <button className="apply-button" disabled={locked} onClick={() => void apply()}>确认整批应用并保存</button>
        </section>}
      </>}
      {error && <p role="alert" className="image-error">{error}</p>}
      <p role="status" aria-live="polite">{phase === 'commit' ? '正在保留前快照并提交…' : message}{phase === 'generate' ? ` ${progress} / ${selected.length}` : ''}</p>
    </div>
  </div>
}
