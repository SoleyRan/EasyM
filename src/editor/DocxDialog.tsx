import { useModalOverlay } from './Overlay'
import { useEffect, useMemo, useRef, useState } from 'react'
import { canGenerateDocx, type PreparedDocx } from '../core/docx-model'
import { defaultDocxOptions, type DocxOptions } from '../core/docx-options'

export type DocxPhase = 'preflight' | 'ready' | 'generating' | 'saving'
interface Props {
  prepared: PreparedDocx | null
  source: string
  phase: DocxPhase
  onGenerate(options: DocxOptions): void
  onCancel(): void
  onLocate(offset: number): void
  onReadOther?: () => void
}

export function DocxDialog({ prepared, source, phase, onGenerate, onCancel, onLocate, onReadOther }: Props) {
  const dialog = useRef<HTMLFormElement>(null)
  useModalOverlay(dialog, '.app-menu-trigger')
  const [options, setOptions] = useState<DocxOptions>(defaultDocxOptions)
  const ready = phase === 'ready', cancellable = phase !== 'saving'
  const lines = useMemo(() => {
    const starts = [0]
    for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1)
    return starts
  }, [source])
  function position(offset: number) {
    let low = 0, high = lines.length
    while (low < high) { const middle = (low + high) >>> 1; if (lines[middle] <= offset) low = middle + 1; else high = middle }
    return `第 ${low} 行 · 第 ${offset - lines[low - 1] + 1} 列`
  }
  useEffect(() => { dialog.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() }, [])
  useEffect(() => {
    if (ready) dialog.current?.querySelector<HTMLSelectElement>('select')?.focus()
    else if (phase === 'generating') dialog.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    else if (phase === 'saving') dialog.current?.focus()
  }, [phase, ready])
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); if (cancellable) onCancel() }
    }
    document.addEventListener('keydown', escape, true)
    return () => document.removeEventListener('keydown', escape, true)
  }, [cancellable, onCancel])
  const warnings = prepared?.model.warnings
  return <div className="modal-backdrop docx-backdrop" onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
      event.preventDefault(); event.stopPropagation()
      if (cancellable) onCancel()
    }
    if (event.key === 'Tab') {
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled)') ?? [])
      const index = controls.indexOf(document.activeElement as HTMLElement)
      event.preventDefault()
      if (controls.length) controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length].focus()
      else dialog.current?.focus()
    }
    if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault()
  }}>
    <form className="docx-dialog" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="docx-title" onSubmit={event => {
      event.preventDefault()
      if (ready && prepared && canGenerateDocx(prepared.model, options.allowImagePlaceholders)) onGenerate(options)
    }}>
      <h2 id="docx-title">导出 DOCX</h2>
      <p className="panel-note">导出当前正文，包含未保存的编辑。</p>
      <p className="panel-note">脚注输出为文末脚注；公式和 Mermaid 图表保留可编辑源码，元数据保留原文。具体降级见预检提示。</p>
      {prepared && <>
        <p className="docx-filename">文件名：<strong>{prepared.model.name}</strong></p>
        <div className="docx-options">
          <label>纸张<select aria-label="DOCX 纸张" disabled={!ready} value={options.page} onChange={event => setOptions({ ...options, page: event.target.value as DocxOptions['page'] })}><option value="a4">A4</option><option value="letter">Letter</option></select></label>
          <label>办公样式<select aria-label="DOCX 办公样式" disabled={!ready} value={options.style} onChange={event => setOptions({ ...options, style: event.target.value as DocxOptions['style'] })}><option value="default">默认办公</option><option value="compact">紧凑办公</option></select></label>
        </div>
        <h3>预检提示 · {warnings!.total} 项</h3>
        <ul className="docx-warnings" aria-label="DOCX 预检提示">
          {warnings!.items.map((warning, index) => <li key={index}>
            <span>{warning.message}</span>
            {warning.resource && <code>{warning.resource}</code>}
            {warning.code !== 'font_fallback' && <button type="button" disabled={!ready} onClick={() => onLocate(warning.range.from)} title="返回正文并定位">{position(warning.range.from)} · 定位</button>}
          </li>)}
        </ul>
        {warnings!.total > warnings!.items.length && <p className="panel-note">仅显示前 {warnings!.items.length} 项明细，共 {warnings!.total} 项。</p>}
        {!!warnings!.imageFailures && <div className="docx-image-warning">
          <p>{warnings!.imageFailures} 项图片无法导出，默认禁止生成。</p>
          <label><input type="checkbox" disabled={!ready} checked={!!options.allowImagePlaceholders} onChange={event => setOptions({ ...options, allowImagePlaceholders: event.target.checked })} />使用图片占位继续</label>
        </div>}
      </>}
      <p role="status" aria-live="polite">{phase === 'preflight' ? '正在预检正文与图片…' : phase === 'generating' ? '正在生成 DOCX…' : phase === 'saving' ? '正在保存，请在保存对话框中操作…' : '预检完成，请确认导出选项。'}</p>
      <div className="panel-actions"><button type="button" disabled={!cancellable} onClick={onCancel}>取消</button>{onReadOther && (phase === 'preflight' || phase === 'generating') && <button type="button" onClick={onReadOther}>阅读其他文档</button>}<button className="apply-button" type="submit" disabled={!ready || !prepared || !canGenerateDocx(prepared.model, options.allowImagePlaceholders)}>生成 DOCX</button></div>
    </form>
  </div>
}
