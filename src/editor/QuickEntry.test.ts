// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { QuickOpen, SearchOverlay } from './QuickEntry'
import { OverlayHost, OverlayProvider } from './Overlay'
import { searchWorkspaceFilenames, cancelWorkspaceSearch } from '../platform/workspace'
import type { FilenameReport } from '../platform/workspace'

vi.mock('../platform/storage', () => ({ desktop: true }))
vi.mock('../platform/workspace', () => ({ searchWorkspaceFilenames: vi.fn(), cancelWorkspaceSearch: vi.fn() }))
let root: Root, container: HTMLDivElement
beforeEach(() => {
  vi.useFakeTimers()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.mocked(searchWorkspaceFilenames).mockReset()
  vi.mocked(cancelWorkspaceSearch).mockReset().mockResolvedValue(undefined)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers() })

it('cancels the old workspace search and rejects its late response after switching workspace', async () => {
  let finishOld!: (report: FilenameReport) => void
  vi.mocked(searchWorkspaceFilenames).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
    .mockResolvedValue({ paths: ['new/当前.md'], scanned: 1, skipped: 0, limited: false, cancelled: false })
  const render = async (id: string) => act(async () => root.render(createElement(OverlayProvider, null,
    createElement(OverlayHost), createElement(QuickOpen, { tabs: [], workspace: { id, name: id, entries: [] }, pending: false, error: '', choose: vi.fn(), close: vi.fn() }))))
  await render('old')
  await act(async () => vi.advanceTimersByTimeAsync(200))
  const oldRequest = vi.mocked(searchWorkspaceFilenames).mock.calls[0][2]
  await render('new')
  expect(cancelWorkspaceSearch).toHaveBeenCalledWith(oldRequest)
  await act(async () => vi.advanceTimersByTimeAsync(200))
  await act(async () => finishOld({ paths: ['old/过期.md'], scanned: 1, skipped: 0, limited: false, cancelled: false }))
  expect(container.textContent).toContain('new/当前.md')
  expect(container.textContent).not.toContain('过期.md')
  const newRequest = vi.mocked(searchWorkspaceFilenames).mock.calls[1][2]
  await act(async () => root.render(null))
  expect(cancelWorkspaceSearch).toHaveBeenCalledWith(newRequest)
})

it('blocks keyboard and pointer acceptance during a task lock and IME composition', async () => {
  const choose = vi.fn(), close = vi.fn()
  const render = async (pending: boolean) => act(async () => root.render(createElement(OverlayProvider, null,
    createElement(OverlayHost), createElement(SearchOverlay, { title: '任务入口', query: '', onQuery: vi.fn(), items: [{ id: 'file', label: '文件', detail: '工作区' }], pending, onChoose: choose, onClose: close }))))
  await render(true)
  const option = container.querySelector<HTMLElement>('[role=option]')!, input = container.querySelector('input')!
  await act(async () => { option.click(); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  expect(choose).not.toHaveBeenCalled()
  await render(false)
  await act(async () => { input.dispatchEvent(new Event('compositionstart', { bubbles: true })); option.click(); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  expect(choose).not.toHaveBeenCalled()
  await act(async () => input.dispatchEvent(new Event('compositionend', { bubbles: true })))
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(choose).toHaveBeenCalledWith('file')
})
