import { useEffect, useRef, useState } from 'react'
import { createFromTemplate, localDate, templates, type NewDocument, type TemplateId } from '../core/templates'

interface Props { onCreate(document: NewDocument): void; onCancel(): void }

export function TemplateDialog({ onCreate, onCancel }: Props) {
  const dialog = useRef<HTMLFormElement>(null)
  const [selected, setSelected] = useState<TemplateId>('blank')
  const [title, setTitle] = useState('')
  const [date, setDate] = useState(localDate)
  const generated = createFromTemplate(selected, { title, date })
  useEffect(() => { dialog.current?.querySelector<HTMLSelectElement>('select')?.focus() }, [])
  return <div className="modal-backdrop" onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); onCancel() }
    if (event.key === 'Tab') {
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select, textarea') ?? [])
      const first = controls[0], last = controls.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault()
  }}>
    <form ref={dialog} className="template-dialog" role="dialog" aria-modal="true" aria-labelledby="template-title" onSubmit={event => { event.preventDefault(); onCreate(generated) }}>
      <h2 id="template-title">从模板新建</h2>
      <label>模板<select aria-label="模板" value={selected} onChange={event => {
        const next = event.target.value as TemplateId
        setSelected(next)
        setTitle(previous => previous === templates.find(item => item.id === selected)?.title ? templates.find(item => item.id === next)!.title : previous)
      }}>{templates.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <p className="panel-note">{templates.find(item => item.id === selected)?.description}</p>
      <div className="template-fields">
        <label>文档标题<input aria-label="文档标题" value={title} maxLength={200} placeholder="未命名" onChange={event => setTitle(event.target.value)} /></label>
        <label>日期<input aria-label="日期" value={date} maxLength={40} disabled={selected === 'blank'} onChange={event => setDate(event.target.value)} /></label>
      </div>
      <label>Markdown 内容预览<textarea aria-label="Markdown 内容预览" readOnly value={generated.text} placeholder="空白文档" /></label>
      <p className="panel-note">文件名：{generated.name}</p>
      <div className="panel-actions"><button type="button" onClick={onCancel}>取消</button><button type="submit" className="apply-button">创建文档</button></div>
    </form>
  </div>
}
