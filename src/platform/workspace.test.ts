import { beforeEach, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { listWorkspace, openWorkspaceDocument, readWorkspaceImage, workspaceImageData, searchWorkspace, cancelWorkspaceSearch } from './workspace'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
beforeEach(() => vi.mocked(invoke).mockReset())

it('passes search authorization and request identity and preserves partial report metadata', async () => {
  const report = { results: [{ path: '中文.md', line: 2, preview: 'needle', revision: 'hash' }], scanned: 3, skipped: 1, limited: true, cancelled: false }
  vi.mocked(invoke).mockResolvedValue(report)
  expect(await searchWorkspace('workspace', 'needle', 'request')).toEqual(report)
  expect(invoke).toHaveBeenCalledWith('search_workspace', { id: 'workspace', query: 'needle', requestId: 'request' })
  await cancelWorkspaceSearch('request')
  expect(invoke).toHaveBeenLastCalledWith('cancel_workspace_search', { requestId: 'request' })
})

it('uses opaque workspace authorization and preserves document bytes', async () => {
  vi.mocked(invoke).mockResolvedValue({ id: 'file', name: '中文.md', bytes: [239, 187, 191, 65, 13, 10], revision: 'hash' })
  const opened = await openWorkspaceDocument('workspace', 'notes/中文.md')
  expect(invoke).toHaveBeenCalledWith('open_workspace_document', { id: 'workspace', relativePath: 'notes/中文.md' })
  expect(opened.bytes).toEqual(Uint8Array.from([239, 187, 191, 65, 13, 10]))
  await listWorkspace('workspace', 'notes')
  expect(invoke).toHaveBeenLastCalledWith('list_workspace', { id: 'workspace', relativePath: 'notes' })
})

it('passes selected image bytes through the existing immutable import path', async () => {
  vi.mocked(invoke).mockResolvedValue({ bytes: [1, 2, 3], mime: 'image/png' })
  const file = await readWorkspaceImage({ id: 'workspace', path: 'images/测试.png' })
  expect(file.name).toBe('测试.png')
  expect(file.type).toBe('image/png')
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(Uint8Array.from([1, 2, 3]))
  expect(invoke).toHaveBeenCalledWith('read_workspace_image', { id: 'workspace', relativePath: 'images/测试.png' })
  expect(workspaceImageData('{"id":"workspace","path":"images/测试.png"}')).toEqual({ id: 'workspace', path: 'images/测试.png' })
  for (const invalid of ['', 'null', '{}', '{"id":1,"path":"a"}']) expect(workspaceImageData(invalid)).toBeNull()
})
