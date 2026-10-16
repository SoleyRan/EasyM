// @vitest-environment happy-dom
import { act, createElement, useRef, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OverlayProvider, useModalOverlay } from './Overlay'
import { ApplicationDialog } from './ApplicationDialogs'

let container: HTMLDivElement, root: Root
function Modal({ returnFocus }: { returnFocus?: string }) {
  const element = useRef<HTMLDivElement>(null)
  useModalOverlay(element, returnFocus)
  return createElement('div', { ref: element, role: 'dialog', tabIndex: -1 }, 'Modal')
}
const render = async (children?: ReactNode) => act(async () => root.render(createElement(OverlayProvider, null, children)))
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() })

it('restores an explicit menu target in the close commit without scheduling an animation frame', async () => {
  const menu = createElement('button', { className: 'menu', key: 'menu' }, 'Menu')
  await render([menu, createElement(Modal, { returnFocus: '.menu', key: 'modal' })])
  container.querySelector<HTMLElement>('[role=dialog]')!.focus()
  const frame = vi.spyOn(window, 'requestAnimationFrame')
  await render(menu)
  expect(document.activeElement).toBe(container.querySelector('.menu'))
  expect(frame).not.toHaveBeenCalled()
})

it('preserves a new focus target when the user moves focus before close cleanup runs', async () => {
  const menu = createElement('button', { className: 'menu', key: 'menu' }, 'Menu')
  const editor = createElement('textarea', { key: 'editor' })
  await render([menu, editor, createElement(Modal, { returnFocus: '.menu', key: 'modal' })])
  container.querySelector<HTMLElement>('[role=dialog]')!.focus()
  const pending: VoidFunction[] = []
  vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(callback => { pending.push(callback) })
  await render([menu, editor])
  container.querySelector('textarea')!.focus()
  for (const callback of pending) callback()
  expect(document.activeElement).toBe(container.querySelector('textarea'))
})

it('keeps the previous default opener behavior for dialogs without an explicit target', async () => {
  const opener = createElement('button', { key: 'opener' }, 'Open')
  await render(opener)
  container.querySelector('button')!.focus()
  await render([opener, createElement(Modal, { key: 'modal' })])
  container.querySelector<HTMLElement>('[role=dialog]')!.focus()
  await render(opener)
  expect(document.activeElement).toBe(container.querySelector('button'))
})

it('returns to a surviving parent modal before the explicit application menu target', async () => {
  const menu = createElement('button', { className: 'menu', key: 'menu' }, 'Menu')
  const parent = createElement(Modal, { key: 'parent' })
  await render([menu, parent])
  const parentNode = container.querySelector<HTMLElement>('[role=dialog]')!
  parentNode.focus()
  await render([menu, parent, createElement(Modal, { key: 'child', returnFocus: '.menu' })])
  container.querySelectorAll<HTMLElement>('[role=dialog]')[1].focus()
  await render([menu, parent])
  expect(document.activeElement).toBe(parentNode)
})
it('restores modal focus after a failed busy action loses its disabled button, so Escape works', async () => {
  const close = vi.fn()
  const modal = (busy: boolean) => createElement(ApplicationDialog, { title: 'task', busy, onClose: close, children: createElement('button', { disabled: busy }, 'Submit') })
  await render(modal(false)); container.querySelector<HTMLButtonElement>('button')!.focus()
  await render(modal(true)); document.body.tabIndex = -1; document.body.focus()
  expect(document.activeElement).toBe(document.body)
  await render(modal(false))
  expect(document.activeElement).toBe(container.querySelector('[role=dialog]'))
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(close).toHaveBeenCalledOnce()
  document.body.removeAttribute('tabindex')
})
