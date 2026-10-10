// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { WorkspaceTree } from './WorkspaceTree'
import { listWorkspace } from '../platform/workspace'
import { navigateButtons } from './navigation'

vi.mock('../platform/workspace', async original => ({ ...await original<object>(), listWorkspace: vi.fn() }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('loads tree directories on demand and supports directional navigation and activation', async () => {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const open = vi.fn()
  vi.mocked(listWorkspace).mockResolvedValue([{ name: '中文.md', path: 'notes/中文.md', kind: 'document' }])
  const key = async (value: string) => { await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))) }
  try {
    await act(async () => root.render(createElement(WorkspaceTree, { workspace: { id: 'workspace', name: 'test', entries: [{ name: 'notes', path: 'notes', kind: 'directory' }, { name: 'root.md', path: 'root.md', kind: 'document' }] }, disabled: false, selected: null, onOpen: open, onImage: vi.fn(), onError: vi.fn() })))
    const directory = container.querySelector<HTMLButtonElement>('button')!; directory.focus()
    expect(listWorkspace).not.toHaveBeenCalled()
    await key('ArrowRight')
    expect(listWorkspace).toHaveBeenCalledOnce()
    expect(directory.getAttribute('aria-expanded')).toBe('true')
    await key('ArrowRight')
    expect(document.activeElement?.textContent).toContain('中文.md')
    await act(async () => (document.activeElement as HTMLButtonElement).click())
    expect(open).toHaveBeenCalledWith('notes/中文.md')
    await key('ArrowLeft'); expect(document.activeElement).toBe(directory)
    await key('ArrowLeft'); expect(directory.getAttribute('aria-expanded')).toBe('false')
    await key('End'); expect(document.activeElement?.textContent).toContain('root.md')
    await key('Home'); expect(document.activeElement).toBe(directory)
    await key('ArrowRight'); expect(listWorkspace).toHaveBeenCalledOnce()
    await key('ArrowDown'); expect(document.activeElement?.textContent).toContain('中文.md')
    await key('ArrowUp'); expect(document.activeElement).toBe(directory)
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('navigates outline buttons without activating headings or disabled entries', async () => {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  const jump = vi.fn()
  try {
    await act(async () => root.render(createElement('nav', { onKeyDown: event => navigateButtons(event, 'button') },
      createElement('button', { onClick: jump }, 'first'), createElement('button', { disabled: true }, 'disabled'), createElement('button', { onClick: jump }, 'last'))))
    const buttons = container.querySelectorAll<HTMLButtonElement>('button'); buttons[0].focus()
    await act(async () => buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    expect(document.activeElement).toBe(buttons[2]); expect(jump).not.toHaveBeenCalled()
    await act(async () => buttons[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
    expect(document.activeElement).toBe(buttons[0])
  } finally { await act(async () => root.unmount()); container.remove() }
})
