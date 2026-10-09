import { useEffect, useRef } from 'react'

interface Props { busy: boolean; pendingImage: boolean; error: string; onSave(): void; onRetain(): void; onCancel(): void }

export function CloseDialog({ busy, pendingImage, error, onSave, onRetain, onCancel }: Props) {
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => { dialog.current?.querySelector<HTMLButtonElement>('button')?.focus() }, [])
  return <div className="modal-backdrop close-backdrop" onKeyDown={(event) => {
    if (event.key === 'Escape' && !busy) onCancel()
    if (event.key === 'Tab') {
      const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
      const first = buttons[0], last = buttons.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
  }}>
    <div ref={dialog} className="close-dialog" role="dialog" aria-modal="true" aria-labelledby="close-title">
      <h2 id="close-title">关闭前保留修改</h2>
      <p>{pendingImage ? '图片修改尚未应用。可以返回编辑，或保留正文和图片草稿，下次启动继续。' : '正文尚未保存。保存文件后退出，或保留恢复草稿再退出。'}</p>
      {error && <p role="alert" className="image-error">{error}</p>}
      <div className="panel-actions">
        <button disabled={busy} onClick={onCancel}>返回编辑</button>
        <button disabled={busy} onClick={onRetain}>保留草稿并退出</button>
        <button className="apply-button" disabled={busy || pendingImage} onClick={onSave}>保存并退出</button>
      </div>
    </div>
  </div>
}
