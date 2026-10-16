// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MergePreview } from './MergePreview'
import { analyzeMerge } from '../platform/merge'
import type { MergePlan } from '../core/merge'
vi.mock('../platform/merge', () => ({ analyzeMerge: vi.fn() }))
let node: HTMLDivElement, root: Root
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.mocked(analyzeMerge).mockReset()
  node = document.createElement('div'); document.body.append(node); root = createRoot(node)
})
afterEach(async () => { await act(async () => root.unmount()); node.remove() })
const render = async (base: string | null = 'base', local = 'local', disk = 'disk') => act(async () => root.render(createElement(MergePreview, { base, local, disk })))

it('shows a selectable read-only candidate with no apply/save controls', async () => {
  vi.mocked(analyzeMerge).mockResolvedValue({ status: 'clean', chunks: [], conflicts: 0, text: 'local + disk 😀' })
  await render()
  expect(node.textContent).toContain('没有文本冲突')
  expect(node.querySelector('textarea')?.value).toBe('local + disk 😀')
  expect(node.querySelector('textarea')?.readOnly).toBe(true)
  expect(node.querySelectorAll('button')).toHaveLength(0)
})
it('cancels on changed inputs/unmount and discards even a misbehaving cancelled result', async () => {
  let resolve!: (value: MergePlan) => void
  vi.mocked(analyzeMerge).mockReturnValueOnce(new Promise(r => { resolve = r })).mockResolvedValue({ status: 'unavailable', reason: 'new result' })
  await render()
  const firstSignal = vi.mocked(analyzeMerge).mock.calls[0][3]!
  await render('new base', 'new local', 'new disk')
  expect(firstSignal.aborted).toBe(true)
  await act(async () => resolve({ status: 'clean', chunks: [], conflicts: 0, text: 'obsolete' }))
  expect(node.textContent).toContain('new result'); expect(node.querySelector('textarea')).toBeNull()
  const nextSignal = vi.mocked(analyzeMerge).mock.calls[1][3]!
  await act(async () => root.render(null)); expect(nextSignal.aborted).toBe(true)
})
it('preserves missing-ancestor and failed-task explanations', async () => {
  vi.mocked(analyzeMerge).mockResolvedValueOnce({ status: 'unavailable', reason: '没有可验证的共同祖先' }).mockRejectedValueOnce(new Error('worker failed'))
  await render(null); expect(node.textContent).toContain('共同祖先')
  await render('base2'); expect(node.textContent).toContain('worker failed')
})
it('bounds candidate and conflict display without generating conflict marker text', async () => {
  vi.mocked(analyzeMerge).mockResolvedValueOnce({ status: 'clean', chunks: [], conflicts: 0, text: 'x'.repeat(200001) })
  await render(); expect(node.querySelector('textarea')?.value).toHaveLength(200000)
  expect(node.textContent).toContain('仅展示前')
  vi.mocked(analyzeMerge).mockResolvedValueOnce({ status: 'conflicts', conflicts: 21, chunks: Array.from({ length: 21 }, () => ({ kind: 'conflict', from: 1, to: 2, base: ['base'], local: ['l'.repeat(20001)], disk: ['disk'] })) })
  await render('different')
  expect(node.querySelectorAll('.merge-conflict')).toHaveLength(20)
  expect(node.querySelectorAll('textarea')).toHaveLength(60)
  expect(node.querySelectorAll('textarea')[1].value).toHaveLength(20000)
  expect(node.textContent).toContain('有 21 处文本冲突')
  expect(node.textContent).toContain('仅展示前 20 处')
})
