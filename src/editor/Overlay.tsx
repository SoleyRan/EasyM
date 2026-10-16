import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { OverlayManager, positionOverlay, type OverlayLease } from '../core/overlays'

const OverlayContext = createContext<{ manager: OverlayManager; host: HTMLDivElement | null; setHost(node: HTMLDivElement | null): void } | null>(null)
export function OverlayProvider({ children }: { children: ReactNode }) {
  const [manager] = useState(() => new OverlayManager())
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    let composing = false
    const start = (event: Event) => {
      composing = true
      const target = event.target instanceof HTMLElement ? event.target : null
      // Source composition hides its own slash menu without treating the IME
      // interruption as Escape. Other source menus still dismiss normally.
      if (!target?.closest('.table-panel, .quick-entry-panel') && !(target?.closest('.cm-content') && manager.top()?.level === 'content') && manager.top()?.level !== 'modal') manager.dismissTop()
    }
    const end = () => { composing = false }
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || composing || manager.top()?.level === 'modal') return
      if (event.target instanceof HTMLElement && event.target.closest('.table-panel textarea')) return
      if (manager.dismissTop()) { event.preventDefault(); event.stopPropagation() }
    }
    window.addEventListener('keydown', keyboard, true)
    document.addEventListener('compositionstart', start, true); document.addEventListener('compositionend', end, true)
    return () => { window.removeEventListener('keydown', keyboard, true); document.removeEventListener('compositionstart', start, true); document.removeEventListener('compositionend', end, true) }
  }, [manager])
  return <OverlayContext.Provider value={{ manager, host, setHost }}>{children}</OverlayContext.Provider>
}
export function useOverlays() { const value = useContext(OverlayContext); if (!value) throw new Error('OverlayProvider missing'); return value }
export function OverlayHost() { const { setHost } = useOverlays(); return <div className="overlay-host" ref={setHost} /> }
export function OverlayPortal({ children }: { children: ReactNode }) {
  const { host } = useOverlays()
  return host ? createPortal(children, host) : null
}

// Existing modal components keep their busy/cancel rules and focus traps.
// Registration coordinates them with menus without changing their task semantics.
export function useModalOverlay(element: RefObject<HTMLElement | null>, returnFocus?: string) {
  const context = useContext(OverlayContext)
  useLayoutEffect(() => {
    if (!context) return
    // A close decision can temporarily sit above an unfinished image dialog.
    const parent = context.manager.modal()?.id
    const lease = context.manager.open('modal', () => undefined, parent)
    if (!lease) return
    const surface = element.current
    surface?.setAttribute('data-overlay-id', String(lease.id))
    const previous = document.activeElement as HTMLElement | null
    return () => {
      const owned = lease.current()
      lease.release()
      const version = context.manager.version()
      queueMicrotask(() => {
        if (!owned || version !== context.manager.version()) return
        const top = context.manager.top()
        if (top && top.id !== parent) return
        // A close must not take focus back after the user has already focused
        // another control. Restore in this commit's microtask, never a later frame.
        const focused = document.activeElement
        if (focused instanceof HTMLElement && focused !== document.body && focused.isConnected && !focused.closest('[inert], [hidden]') && !surface?.contains(focused)
          && (!top || focused.closest('[data-overlay-id]')?.getAttribute('data-overlay-id') === String(top.id))) return
        if (top && previous?.closest('[data-overlay-id]')?.getAttribute('data-overlay-id') !== String(top.id)) {
          document.querySelector<HTMLElement>(`[data-overlay-id="${top.id}"] button:not(:disabled), [data-overlay-id="${top.id}"]`)?.focus({ preventScroll: true })
          return
        }
        const target = !top && returnFocus ? document.querySelector<HTMLElement>(returnFocus) : previous
        if (target !== document.body && target?.isConnected && !target.closest('[inert], [hidden]')) target.focus({ preventScroll: true })
        else document.querySelector<HTMLElement>('.document-panel:not([hidden]) .cm-content, .app-menu-trigger')?.focus({ preventScroll: true })
      })
    }
  }, [context?.manager, element, returnFocus])
}

export function PositionedOverlay({ children, anchor, side = 'below', className, id, label, lease, element: externalElement, onKeyDown, role = 'menu', onMouseDown }: {
  children: ReactNode; anchor(): DOMRect | null; side?: 'below' | 'right'; className: string; id?: string; label: string;
  lease: RefObject<OverlayLease | null>; element?: RefObject<HTMLDivElement | null>; onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>; role?: 'menu' | 'toolbar'; onMouseDown?: React.MouseEventHandler<HTMLDivElement>
}) {
  const { host } = useOverlays()
  const ownElement = useRef<HTMLDivElement>(null), element = externalElement ?? ownElement
  const latestAnchor = useRef(anchor); latestAnchor.current = anchor
  useLayoutEffect(() => {
    const node = element.current
    if (!node) return
    let frame = 0, disposed = false
    const position = () => {
      const rect = latestAnchor.current()
      if (!rect) return
      const bounds = node.getBoundingClientRect()
      const point = positionOverlay(rect, bounds, { width: window.innerWidth, height: window.innerHeight }, side)
      Object.assign(node.style, { left: `${point.left}px`, top: `${point.top}px`, visibility: 'visible' })
    }
    // Position before paint so the owner's layout effect can focus menu items.
    position()
    const measure = () => {
      cancelAnimationFrame(frame)
      const identity = lease.current
      frame = requestAnimationFrame(() => {
        if (disposed || !identity?.current() || lease.current !== identity) return
        position()
      })
    }
    measure()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    observer?.observe(node)
    document.addEventListener('scroll', measure, true); window.addEventListener('resize', measure)
    // Sidebar drags also move an anchor without scrolling the document.
    document.addEventListener('pointermove', measure)
    return () => { disposed = true; cancelAnimationFrame(frame); observer?.disconnect(); document.removeEventListener('scroll', measure, true); window.removeEventListener('resize', measure); document.removeEventListener('pointermove', measure) }
  }, [element, lease, side, host])
  return <OverlayPortal><div ref={element} className={className} id={id} role={role} aria-label={label} style={{ position: 'fixed', visibility: 'hidden' } as CSSProperties} onKeyDown={onKeyDown} onMouseDown={onMouseDown}>{children}</div></OverlayPortal>
}
