import { expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { printDocument, saveHtml } from './export'
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }))
vi.mock('./markdown-worker?worker&inline', () => ({ default: class {} }))

it('keeps HTML output separate from Markdown save identity, handles cancellation and invokes native printing', async () => {
  vi.mocked(invoke).mockResolvedValueOnce(false).mockResolvedValueOnce(true).mockResolvedValueOnce(undefined)
  expect(await saveHtml('note.html', '<p>note</p>')).toBe(false)
  expect(await saveHtml('note.html', '<p>note</p>')).toBe(true)
  await printDocument()
  expect(invoke).toHaveBeenNthCalledWith(1, 'export_html', { name: 'note.html', html: '<p>note</p>' })
  expect(invoke).toHaveBeenLastCalledWith('print_document')
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'save_document')).toBe(false)
})
