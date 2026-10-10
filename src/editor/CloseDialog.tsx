import { useEffect, useRef } from 'react'

interface Props { scope?: 'window' | 'tab'; busy: boolean; pendingImage: boolean; error: string; onSave(): void; onRetain(): void; onDiscard(): void; onCancel(): void }

export function CloseDialog({ scope = 'window', busy, pendingImage, error, onSave, onRetain, onDiscard, onCancel }: Props) {
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
      <p>{pendingImage ? '图片修改尚未应用。可以保留正文和图片草稿，下次继续；不保存将丢弃这些修改和恢复草稿。' : scope === 'tab' ? '此文档尚未保存。可以保存文件、保留恢复草稿，或不保存并丢弃此文档的修改和草稿。' : '打开的文档尚有未保存修改。可以保存所有修改、保留每个文档的恢复草稿，或不保存并丢弃修改和草稿。'}</p>
      {error && <p role="alert" className="image-error">{error}</p>}
      <div className="panel-actions">
        <button disabled={busy} onClick={onCancel}>返回编辑</button>
        <button className="discard-button" disabled={busy} onClick={onDiscard}>{scope === 'tab' ? '不保存关闭' : '不保存退出'}</button>
        <button disabled={busy} onClick={onRetain}>{scope === 'tab' ? '保留草稿并关闭' : '保留草稿并退出'}</button>
        <button className="apply-button" disabled={busy || pendingImage} onClick={onSave}>{scope === 'tab' ? '保存并关闭' : '保存并退出'}</button>
      </div>
    </div>
  </div>
}
