import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { exportStyles, type ExportDocument } from '../core/export'
import { printDocument } from '../platform/export'
import './print.css'

export function PrintDialog({ output, onClose }: { output: ExportDocument; onClose(): void }) {
  const dialog = useRef<HTMLDivElement>(null), root = useRef<HTMLElement>(null)
  const [printing, setPrinting] = useState(false), [error, setError] = useState('')
  const locked = useRef(false)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null; const title = document.title
    document.title = output.name.replace(/\.html$/i, ''); document.body.classList.add('easym-print-ready')
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !locked.current) { event.preventDefault(); event.stopPropagation(); onClose() }
      if (event.key === 'Tab') {
        const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
        const next = buttons[(buttons.indexOf(document.activeElement as HTMLButtonElement) + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]
        if (next) { event.preventDefault(); next.focus() }
      }
    }
    document.addEventListener('keydown', keyboard)
    return () => { document.removeEventListener('keydown', keyboard); document.body.classList.remove('easym-print-ready'); document.title = title; previous?.focus() }
  }, [output, onClose])
  async function print() {
    if (locked.current) return
    locked.current = true; setPrinting(true); setError('')
    try {
      await Promise.all(Array.from(root.current?.querySelectorAll('img') ?? []).map(image => image.decode().catch(() => { throw new Error('打印图片无法解码，请先导出 HTML 检查图片。') })))
      await document.fonts?.ready
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      await printDocument()
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { locked.current = false; setPrinting(false) }
  }
  return <>
    <div className="modal-backdrop print-backdrop"><div className="print-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="print-title">
      <div className="print-heading"><h2 id="print-title">打印预览</h2><button onClick={onClose} disabled={printing}>返回编辑</button></div>
      <p>仅打印正文，纸张、边距和 PDF 选项由系统打印对话框设置。</p>
      {!!output.warnings.length && <div className="print-warnings" role="alert">有 {output.warnings.length} 项图片未加载，将以文字占位打印。</div>}
      <div className="print-preview"><article className="export-document" dangerouslySetInnerHTML={{ __html: output.body }} /></div>
      {error && <p role="alert">{error}</p>}<div className="panel-actions"><button className="apply-button" onClick={() => void print()} disabled={printing}>{printing ? '正在打开打印…' : '打开系统打印'}</button></div>
    </div></div>
    {createPortal(<section id="easym-print-root" ref={root} aria-hidden="true"><style>{exportStyles}</style><article className="export-document" dangerouslySetInnerHTML={{ __html: output.body }} /></section>, document.body)}
  </>
}
