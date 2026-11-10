import { useEffect, useRef } from 'react'
import { OverlayPortal, useModalOverlay } from './Overlay'

/** Reading mode: double-clicking an image shows it fitted to the window. Read-only; any click or Esc closes. */
export function ImageZoom({ src, alt, onClose }: { src: string; alt: string; onClose(): void }) {
  const dialog = useRef<HTMLDivElement>(null)
  useModalOverlay(dialog)
  useEffect(() => { dialog.current?.querySelector<HTMLButtonElement>('button')?.focus() }, [])
  return <OverlayPortal><div className="modal-backdrop image-zoom" onClick={onClose} onKeyDown={event => {
    if (event.nativeEvent.isComposing) return
    // Handled here so Esc closes the image without also leaving reading mode.
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
    if (event.key === 'Tab') event.preventDefault()
  }}><div ref={dialog} className="image-zoom-surface" role="dialog" aria-modal="true" aria-label="查看图片">
    <button className="image-zoom-close" aria-label="关闭图片" title="关闭（Esc）">×</button>
    <img src={src} alt={alt} />
  </div></div></OverlayPortal>
}
