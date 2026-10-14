// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, expect, it, vi } from 'vitest'
import { OverlayHost, OverlayProvider } from './Overlay'
import { TablePanel } from './TablePanel'
import { sourceTable } from '../core/tables'

beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true })

it('retains a single-column/body table and never submits during composition', async () => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), commit = vi.fn(), composing = vi.fn(), draft = vi.fn()
  const table = sourceTable('| a |\n| --- |\n| x |', 0)
  await act(async () => root.render(createElement(OverlayProvider, null, createElement(OverlayHost), createElement(TablePanel, {
    session: { table, row: 1, column: 0, draft: 'x', version: 0 }, error: '', decision: false,
    onComposing: composing, onDraft: draft, onCommit: commit, onNavigate: vi.fn(), onDismiss: vi.fn(),
  }))))
  try {
    const buttons = [...host.querySelectorAll('button')]
    expect(buttons.find(button => button.textContent === '删除当前行')!.disabled).toBe(true)
    expect(buttons.find(button => button.textContent === '删除当前列')!.disabled).toBe(true)
    const input = host.querySelector('textarea')!
    await act(async () => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中' })))
    await act(async () => buttons.find(button => button.textContent === '确认')!.click())
    await act(async () => buttons.find(button => button.textContent === '取消输入')!.click())
    expect(commit).not.toHaveBeenCalled(); expect(draft).not.toHaveBeenCalled(); expect(composing).toHaveBeenLastCalledWith(true)
    await act(async () => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' })))
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })))
    expect(commit).toHaveBeenCalledWith('next'); expect(composing).toHaveBeenLastCalledWith(false)
  } finally { await act(async () => root.unmount()); host.remove() }
})

it('requires confirmation before deleting nonempty rows and columns', async () => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), commit = vi.fn(), confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  const table = sourceTable('| a | b |\n| --- | --- |\n| x | y |\n| z | q |', 0)
  await act(async () => root.render(createElement(OverlayProvider, null, createElement(OverlayHost), createElement(TablePanel, {
    session: { table, row: 1, column: 0, draft: 'x', version: 0 }, error: '', decision: false,
    onComposing: vi.fn(), onDraft: vi.fn(), onCommit: commit, onNavigate: vi.fn(), onDismiss: vi.fn(),
  }))))
  try {
    const buttons = [...host.querySelectorAll('button')]
    for (const [label, operation] of [['删除当前行', 'deleteRow'], ['删除当前列', 'deleteColumn']]) {
      const button = buttons.find(button => button.textContent === label)!
      confirm.mockReturnValue(false); commit.mockClear()
      await act(async () => button.click()); expect(commit).not.toHaveBeenCalled()
      confirm.mockReturnValue(true)
      await act(async () => button.click()); expect(commit).toHaveBeenCalledWith('stay', operation)
    }
  } finally { await act(async () => root.unmount()); host.remove(); confirm.mockRestore() }
})
