import { useState, type ReactNode } from 'react'

export function ResizableSidebar({ side, children }: { side: 'left' | 'right'; children: ReactNode }) {
  const label = side === 'left' ? '文件栏' : '大纲栏'
  const [width, setWidth] = useState(() => {
    try { const saved = Number(localStorage.getItem(`easym-sidebar-${side}`)); return saved >= 160 && saved <= 420 ? saved : 220 } catch { return 220 }
  })
  const [drag, setDrag] = useState<{ x: number; width: number } | null>(null)
  function resize(next: number, element: HTMLElement) {
    const workspace = element.closest('.workspace')!
    const other = workspace.querySelector<HTMLElement>(side === 'left' ? '.right-sidebar' : '.left-sidebar')
    const max = Math.max(160, Math.min(420, workspace.clientWidth - (other?.offsetWidth ?? 0) - 480))
    const value = Math.round(Math.max(160, Math.min(max, next)))
    setWidth(value)
    try { localStorage.setItem(`easym-sidebar-${side}`, String(value)) } catch { /* Resizing works without persistence. */ }
  }
  return <aside className={`sidebar ${side}-sidebar`} style={{ width, flexBasis: width }}>
    <div className="sidebar-content">{children}</div>
    <div role="separator" aria-label={`调整${label}宽度`} aria-orientation="vertical" aria-valuemin={160} aria-valuemax={420} aria-valuenow={width} tabIndex={0}
      className={`sidebar-resizer ${drag ? 'dragging' : ''}`} onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
        setDrag({ x: event.clientX, width: event.currentTarget.parentElement!.offsetWidth })
      }} onPointerMove={(event) => {
        if (drag) resize(drag.width + (event.clientX - drag.x) * (side === 'left' ? 1 : -1), event.currentTarget)
      }} onPointerUp={(event) => { setDrag(null); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
      onPointerCancel={() => setDrag(null)} onLostPointerCapture={() => setDrag(null)} onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        resize(event.key === 'Home' ? 160 : event.key === 'End' ? 420 : width + (event.key === 'ArrowRight' ? 20 : -20) * (side === 'left' ? 1 : -1), event.currentTarget)
      }} />
  </aside>
}
