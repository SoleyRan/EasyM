import { expect, it, vi } from 'vitest'
import { OverlayManager, positionOverlay } from './overlays'

it('replaces equal/lower overlays and invalidates their asynchronous work', () => {
  const manager = new OverlayManager(), close = vi.fn()
  const selection = manager.open('selection', close)!
  const menu = manager.open('menu', vi.fn())!
  expect(close).toHaveBeenCalledOnce(); expect(selection.current()).toBe(false)
  expect(manager.open('content', vi.fn())).toBeNull()
  selection.release(); expect(menu.current()).toBe(true)
})
it('keeps submenu and modal-local menus scoped and dismisses only the top layer', () => {
  const manager = new OverlayManager(), close = vi.fn(), modalClose = vi.fn()
  const modal = manager.open('modal', modalClose)!
  expect(manager.open('menu', close)).toBeNull()
  const menu = manager.open('menu', close, modal.id)!
  expect(manager.dismissTop()).toBe(true)
  expect(close).toHaveBeenCalledOnce(); expect(menu.current()).toBe(false)
  expect(modal.current()).toBe(true); expect(modalClose).not.toHaveBeenCalled()
  modal.release(); expect(manager.top()).toBeUndefined()
})
it('releasing a parent cancels descendants but never an unrelated replacement', () => {
  const manager = new OverlayManager(), close = vi.fn()
  const parent = manager.open('menu', vi.fn())!
  const child = manager.open('menu', close, parent.id)!
  parent.release(); expect(close).toHaveBeenCalledOnce(); expect(child.current()).toBe(false)
  const next = manager.open('modal', vi.fn())!
  parent.release(); child.release(); expect(next.current()).toBe(true)
})
it('returns to the underlying dialog after a nested decision and dismisses its old input menu', () => {
  const manager = new OverlayManager(), closeMenu = vi.fn()
  const image = manager.open('modal', vi.fn())!
  const input = manager.open('menu', closeMenu, image.id)!
  const decision = manager.open('modal', vi.fn(), manager.modal()?.id)!
  expect(closeMenu).toHaveBeenCalledOnce(); expect(input.current()).toBe(false)
  decision.release(); expect(manager.top()?.id).toBe(image.id)
  expect(manager.open('menu', vi.fn())).toBeNull()
  expect(manager.open('menu', vi.fn(), input.id)).toBeNull()
})
it('flips right/bottom menus and clamps narrow viewports', () => {
  const anchor = { left: 270, right: 300, top: 350, bottom: 370 }
  expect(positionOverlay(anchor, { width: 100, height: 80 }, { width: 400, height: 400 }, 'right')).toEqual({ left: 164, top: 314 })
  expect(positionOverlay(anchor, { width: 100, height: 80 }, { width: 400, height: 400 })).toEqual({ left: 270, top: 264 })
  expect(positionOverlay(anchor, { width: 500, height: 500 }, { width: 320, height: 320 })).toEqual({ left: 6, top: 6 })
})
