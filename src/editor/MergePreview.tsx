import { useEffect, useState } from 'react'
import { analyzeMerge } from '../platform/merge'
import type { MergePlan } from '../core/merge'

const MAX_PREVIEW = 200000, MAX_FRAGMENT = 20000, MAX_CONFLICTS = 20
export function MergePreview({ base, local, disk }: { base: string | null; local: string; disk: string }) {
  const [plan, setPlan] = useState<MergePlan | null>(null)
  useEffect(() => {
    const task = new AbortController()
    setPlan(null)
    void analyzeMerge(base, local, disk, task.signal).then(result => {
      if (!task.signal.aborted) setPlan(result)
    }).catch(error => {
      if (!task.signal.aborted) setPlan({ status: 'unavailable', reason: error instanceof Error ? error.message : String(error) })
    })
    return () => task.abort()
  }, [base, local, disk])
  return <section className="merge-preview" aria-label="三方合并分析">
    <h3>三方合并分析</h3>
    <p>共同祖先为本标签最后成功打开或保存的正文。本步仅预览，不应用或写回文件，自动保存继续暂停。</p>
    {!plan ? <p role="status">正在分析共同祖先、本地和磁盘版本…</p> : plan.status === 'unavailable' ? <p role="status">{plan.reason}</p> : <>
      <p role="status">{plan.status === 'clean' ? '没有文本冲突，可组合双方改动。' : `有 ${plan.conflicts} 处文本冲突，需要逐处确认。`} 图片、编码和换行仍需单独核对。</p>
      {plan.status === 'clean' && <label>合并候选（只读）<textarea readOnly aria-label="合并候选（只读）" value={(plan.text ?? '').slice(0, MAX_PREVIEW)} />{(plan.text?.length ?? 0) > MAX_PREVIEW && <span>仅展示前 200,000 字符；请查看双方全文。</span>}</label>}
      {plan.chunks.filter(chunk => chunk.kind === 'conflict').slice(0, MAX_CONFLICTS).map((chunk, index) => <div key={index} className="merge-conflict">
        <h4>冲突 {index + 1} · 基线{chunk.from === chunk.to ? `第 ${chunk.from + 1} 行前插入` : `第 ${chunk.from + 1}–${chunk.to} 行`}</h4>
        <div className="history-texts merge-texts">{(['base', 'local', 'disk'] as const).map((side, i) => <label key={side}>{['共同祖先', '本地片段', '磁盘片段'][i]}<textarea readOnly aria-label={`冲突 ${index + 1} ${['共同祖先', '本地片段', '磁盘片段'][i]}`} value={chunk[side].join('\n').slice(0, MAX_FRAGMENT)} />{chunk[side].join('\n').length > MAX_FRAGMENT && <span>片段仅展示前 20,000 字符。</span>}</label>)}</div>
      </div>)}
      {plan.conflicts > MAX_CONFLICTS && <p>仅展示前 20 处冲突；双方完整正文仍在下方，不生成带冲突标记的正文。</p>}
    </>}
  </section>
}
