import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { OverlayPortal, useOverlays } from './Overlay'
import type { OverlayLease } from '../core/overlays'
import { positionOverlay } from '../core/overlays'

export interface ContextAction { label: string; disabled?: boolean; checked?: boolean | 'mixed'; run(): void | Promise<void> }
type OpenMenu = (event: { preventDefault(): void; stopPropagation(): void; clientX: number; clientY: number }, actions: ContextAction[]) => void
const MenuContext = createContext<OpenMenu>(() => undefined)
export const useContextMenu = () => useContext(MenuContext)

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const { manager } = useOverlays()
  const lease = useRef<OverlayLease | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; actions: ContextAction[] } | null>(null)
  const [error, setError] = useState('')
  const element = useRef<HTMLDivElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const restore = () => {
    if (manager.top() && manager.top()?.id !== lease.current?.id) return
    const target = returnFocus.current
    if (target?.isConnected && !target.closest('[inert], [hidden]')) target.focus({ preventScroll: true })
  }
  const open = useCallback<OpenMenu>((event, actions) => {
    event.preventDefault(); event.stopPropagation(); setError('')
    const modal = (event as unknown as { target?: HTMLElement }).target?.closest?.('[role=dialog]')
    const parent = modal ? Number(modal.getAttribute('data-overlay-id')) : undefined
    lease.current?.release()
    lease.current = manager.open('menu', () => { setMenu(null); restore() }, parent)
    if (!lease.current) { setMenu(null); return }
    returnFocus.current = document.activeElement as HTMLElement | null
    setMenu(actions.length ? { x: event.clientX, y: event.clientY, actions } : null)
  }, [manager])
  useLayoutEffect(() => { if (!menu) { lease.current?.release(); lease.current = null } }, [menu])
  useEffect(() => () => { lease.current?.release() }, [])
  // Suppress WebView/browser menus everywhere. Text fields retain useful edit
  // actions, even inside dialogs or the CodeMirror search panel.
  useEffect(() => {
    const composing = new WeakSet<EventTarget>()
    const startComposition = (event: CompositionEvent) => { if (event.target) composing.add(event.target) }
    const endComposition = (event: CompositionEvent) => { if (event.target) composing.delete(event.target) }
    const context = (event: MouseEvent) => {
      if (event.defaultPrevented) return
      event.preventDefault()
      const target = event.target
      if (target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && ['text', 'search', 'url', 'tel'].includes(target.type))) {
        if (target.disabled || target.closest('[inert]') || composing.has(target)) { setMenu(null); return }
        const value = target.value, start = target.selectionStart ?? 0, end = target.selectionEnd ?? 0
        const selected = value.slice(start, end)
        const select = () => { target.focus(); target.setSelectionRange(start, end) }
        const replace = (text: string) => {
          if (!target.isConnected || target.value !== value || target.selectionStart !== start || target.selectionEnd !== end || target.disabled || target.readOnly || target.closest('[inert]') || composing.has(target)) throw new Error('文本或选区已变化，请重新选择后操作。')
          select()
          const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
          Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(target, value.slice(0, start) + text + value.slice(end))
          target.setSelectionRange(start + text.length, start + text.length)
          target.dispatchEvent(new Event('input', { bubbles: true }))
        }
        const writable = !target.readOnly
        open(event, [
          { label: '复制', disabled: !selected, run: () => navigator.clipboard.writeText(selected) },
          ...(writable ? [
            { label: '剪切', disabled: !selected, run: async () => { await navigator.clipboard.writeText(selected); replace('') } },
            { label: '粘贴文本', run: async () => replace(await navigator.clipboard.readText()) },
          ] : []),
          { label: '全选', disabled: !value, run: () => { target.focus(); target.select() } },
        ])
      } else setMenu(null)
    }
    document.addEventListener('contextmenu', context)
    document.addEventListener('compositionstart', startComposition, true)
    document.addEventListener('compositionend', endComposition, true)
    return () => {
      document.removeEventListener('contextmenu', context)
      document.removeEventListener('compositionstart', startComposition, true)
      document.removeEventListener('compositionend', endComposition, true)
    }
  }, [])
  useLayoutEffect(() => {
    const node = element.current
    if (!menu || !node) return
    const position = positionOverlay({ left: menu.x, right: menu.x, top: menu.y, bottom: menu.y }, node.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight })
    node.style.left = `${position.left}px`
    node.style.top = `${position.top}px`
    ;(node.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? node).focus({ preventScroll: true })
  }, [menu])
  useEffect(() => {
    if (!menu) return
    const outside = (event: PointerEvent) => { if (!element.current?.contains(event.target as Node)) setMenu(null) }
    const dismiss = (event: Event) => { if (event.type === 'scroll' && element.current?.contains(event.target as Node)) return; setMenu(null); restore() }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      document.removeEventListener('pointerdown', outside); document.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss); window.removeEventListener('blur', dismiss)
    }
  }, [menu])
  return <MenuContext.Provider value={open}>{children}
    {menu && <OverlayPortal><div ref={element} className="context-menu" role="menu" aria-label="右键菜单" tabIndex={-1} style={{ left: menu.x, top: menu.y }} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
      if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); event.stopPropagation(); setMenu(null); restore(); return }
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
      event.preventDefault(); event.stopPropagation()
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      const index = items.indexOf(document.activeElement as HTMLButtonElement)
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
    }}>{menu.actions.map(action => <button key={action.label} role={action.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={action.checked} disabled={action.disabled} onClick={() => {
      setMenu(null); restore()
      void Promise.resolve().then(action.run).catch(err => setError(`右键操作失败：${String(err)}`))
    }}>{action.checked && <span aria-hidden="true">{action.checked === "mixed" ? "− " : "✓ "}</span>}{action.label}</button>)}</div></OverlayPortal>}
    {error && <OverlayPortal><div className="context-error" role="alert">{error}<button aria-label="关闭右键操作提示" onClick={() => setError('')}>×</button></div></OverlayPortal>}
  </MenuContext.Provider>
}
