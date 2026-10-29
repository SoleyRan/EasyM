import { useEffect, useMemo, useState } from 'react'
import { analyzeMerge } from '../platform/merge'
import { resolveMerge, type MergePlan, type MergeResolution } from '../core/merge'
import type { FileSnapshot } from '../core/codec'
import type { MergeCandidate, MergeFormat } from '../platform/merge-transaction'

const MAX_PREVIEW = 200000, MAX_FRAGMENT = 20000, MAX_CONFLICTS = 20
/** Side names and the explanation shown above the analysis; defaults describe an external change. */
export interface MergeLabels { local: string; disk: string; intro?: string }
const DEFAULT_LABELS: MergeLabels = { local: '本地', disk: '磁盘' }
export function MergePreview({ base, local, disk, onApply, busy = false, formats, labels = DEFAULT_LABELS }: { base: string | null; local: string; disk: string; onApply?(candidate: MergeCandidate): void; busy?: boolean; formats?: { local: FileSnapshot; disk: FileSnapshot }; labels?: MergeLabels }) {
  const [plan, setPlan] = useState<MergePlan | null>(null)
  const [choices, setChoices] = useState<Record<number, MergeResolution>>({}), [page, setPage] = useState(0), [previewPage, setPreviewPage] = useState(0)
  const [confirmed, setConfirmed] = useState(false), [format, setFormat] = useState<MergeFormat>('local')
  const [composing, setComposing] = useState(false)
  useEffect(() => {
    const task = new AbortController()
    setPlan(null)
    setChoices({}); setConfirmed(false); setPage(0); setPreviewPage(0)
    void analyzeMerge(base, local, disk, task.signal).then(result => {
      if (!task.signal.aborted) setPlan(result)
    }).catch(error => {
      if (!task.signal.aborted) setPlan({ status: 'unavailable', reason: error instanceof Error ? error.message : String(error) })
    })
    return () => task.abort()
  }, [base, local, disk])
  const resolved = useMemo(() => {
    if (!plan || plan.status === 'unavailable') return { text: null, error: '' }
    try { return { text: resolveMerge(plan, choices), error: '' } } catch (error) { return { text: null, error: error instanceof Error ? error.message : String(error) } }
  }, [plan, choices])
  const candidate = resolved.text
  const conflictChunks = plan && plan.status !== 'unavailable' ? plan.chunks.filter(chunk => chunk.kind === 'conflict') : []
  const choose = (index: number, value: MergeResolution) => { setChoices(current => ({ ...current, [index]: value })); setConfirmed(false); setPreviewPage(0) }
  return <section className="merge-preview" aria-label="三方合并分析" onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}>
    <h3>三方合并分析</h3>
    <p>{labels.intro ?? `共同祖先为本标签最后成功打开或保存的正文。${onApply ? '选择所有冲突并审查候选后可应用；提交前强制归档双方版本，自动保存暂时保持暂停。' : '本步仅预览，不应用或写回文件，自动保存继续暂停。'}`}</p>
    {!plan ? <p role="status">正在分析共同祖先、{labels.local}和{labels.disk}版本…</p> : plan.status === 'unavailable' ? <p role="status">{plan.reason}</p> : <>
      <p role="status">{plan.status === 'clean' ? '没有文本冲突，可组合双方改动。' : `有 ${plan.conflicts} 处文本冲突，需要逐处确认。`} 图片、编码和换行仍需单独核对。</p>
      {candidate !== null && <label>合并候选（只读）<textarea readOnly aria-label="合并候选（只读）" value={candidate.slice(previewPage * MAX_PREVIEW, (previewPage + 1) * MAX_PREVIEW)} />{candidate.length > MAX_PREVIEW && <span>每页最多 200,000 字符，当前第 {previewPage + 1} / {Math.ceil(candidate.length / MAX_PREVIEW)} 页。<button disabled={!previewPage || busy} onClick={() => setPreviewPage(n => n - 1)}>上一页候选</button><button disabled={(previewPage + 1) * MAX_PREVIEW >= candidate.length || busy} onClick={() => setPreviewPage(n => n + 1)}>下一页候选</button></span>}</label>}
      {conflictChunks.slice(page * MAX_CONFLICTS, (page + 1) * MAX_CONFLICTS).map((chunk, position) => {
        const index = page * MAX_CONFLICTS + position
        return <div key={index} className="merge-conflict">
        <h4>冲突 {index + 1} · 基线{chunk.from === chunk.to ? `第 ${chunk.from + 1} 行前插入` : `第 ${chunk.from + 1}–${chunk.to} 行`}</h4>
        <div className="history-texts merge-texts">{(['base', 'local', 'disk'] as const).map((side, i) => { const name = ['共同祖先', `${labels.local}片段`, `${labels.disk}片段`][i]; return <label key={side}>{name}<textarea readOnly aria-label={`冲突 ${index + 1} ${name}`} value={chunk[side].join('\n').slice(0, MAX_FRAGMENT)} />{chunk[side].join('\n').length > MAX_FRAGMENT && <span>片段仅展示前 20,000 字符。</span>}</label> })}</div>
        {onApply && <fieldset disabled={busy} className="merge-choices"><legend>解决冲突 {index + 1}</legend>
          {(['local', 'disk', 'manual'] as const).map((kind, i) => <button key={kind} aria-pressed={choices[index]?.kind === kind} onClick={() => choose(index, kind === 'manual' ? { kind, text: chunk.local.join('\n') } : { kind })}>{[`采用${labels.local}`, `采用${labels.disk}`, '手工编辑'][i]}</button>)}
          {choices[index]?.kind === 'manual' && <label>手工结果（留空删除该片段）<textarea aria-label={`冲突 ${index + 1} 手工结果`} value={choices[index].text} onChange={event => choose(index, { kind: 'manual', text: event.target.value })} /></label>}
        </fieldset>}
      </div>})}
      {plan.conflicts > MAX_CONFLICTS && <p>每页展示 20 处冲突，当前第 {page + 1} 页；双方完整正文仍在下方。<button disabled={busy || !page} onClick={() => setPage(n => n - 1)}>上一页冲突</button><button disabled={busy || (page + 1) * MAX_CONFLICTS >= plan.conflicts} onClick={() => setPage(n => n + 1)}>下一页冲突</button></p>}
      {onApply && <fieldset disabled={busy} className="merge-apply"><legend>审查并提交</legend>
        <p>已解决 {Object.keys(choices).length} / {plan.conflicts} 处冲突。未解决全部冲突时不能提交。</p>
        {resolved.error && <p role="status">{resolved.error}</p>}
        {formats && <label>保存编码与换行<select aria-label="合并保存格式" value={format} onChange={event => { setFormat(event.target.value as MergeFormat); setConfirmed(false) }}>{(['local', 'disk'] as const).map((side, i) => <option key={side} value={side}>{[`沿用${labels.local}`, `采用${labels.disk}`][i]}：{formats[side].encoding} / {formats[side].lineEnding === 'mixed' ? '混合换行将统一为 LF' : formats[side].lineEnding.toUpperCase()}</option>)}</select></label>}
        <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />已审查完整候选及保存格式，确认保存合并结果</label>
        <button disabled={busy || composing || candidate === null || !confirmed || base === null} onClick={() => { if (!composing && candidate !== null && base !== null) onApply({ base, local, disk, text: candidate, format, confirmed }) }}>应用合并并保存</button>
      </fieldset>}
    </>}
  </section>
}
