import { beforeEach, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { decodeFile } from '../core/codec'
import { mergeBytes, prepareMerge, commitMerge, restoreMergeCopy, mergeError } from './merge-transaction'
import { defaultRecipe } from '../core/images'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const snapshot = (text: string) => decodeFile(new TextEncoder().encode(text))
beforeEach(() => vi.mocked(invoke).mockReset())

it('encodes explicit BOM/CRLF/mixed policies including unchanged mixed text', () => {
  expect([...mergeBytes('a\nb\n', snapshot('\uFEFFa\r\nb\r\n'))]).toEqual([...new TextEncoder().encode('\uFEFFa\r\nb\r\n')])
  const mixed = snapshot('a\r\nb\n')
  expect(new TextDecoder().decode(mergeBytes(mixed.text, mixed))).toBe('a\nb\n')
  expect(() => mergeBytes('bad\0', mixed)).toThrow('规范化')
  expect(() => mergeBytes('x'.repeat(10 * 1024 * 1024 + 1), mixed)).toThrow('10 MiB')
})
it('preserves exact base/disk bytes and uses separate prepare and immutable commit requests', async () => {
  const base = snapshot('\uFEFFbase\r\n'), disk = snapshot('disk\n'), result = mergeBytes('merged\n', disk)
  vi.mocked(invoke).mockResolvedValue({ operationId: 'op' })
  await prepareMerge('id', 'base-r', 'disk-r', base, 'local\n', disk, result, { assets: {}, instances: [] })
  expect(invoke).toHaveBeenCalledWith('prepare_merge', expect.objectContaining({ id: 'id', input: expect.objectContaining({ baseRevision: 'base-r', diskRevision: 'disk-r', base: [...base.originalBytes], disk: [...disk.originalBytes], result: [...result] }) }))
  await commitMerge('id', 'op')
  expect(invoke).toHaveBeenLastCalledWith('commit_merge', { id: 'id', operationId: 'op' })
  await restoreMergeCopy('id', 'op', 'local')
  expect(invoke).toHaveBeenLastCalledWith('merge_recovery', { id: 'id', operationId: 'op', side: 'local' })
})
it('blocks existing baseline/disk images and unarchived resources before native prepare', async () => {
  for (const [base, local, disk] of [
    ['![a](assets/img-a.png)', 'local', 'disk'], ['base', 'local', '![a](assets/img-a.png)'], ['base', '![a](../a.png)', 'disk'],
  ]) await expect(prepareMerge('id', 'b', 'r', snapshot(base), local, snapshot(disk), mergeBytes(local, snapshot(base)), { assets: {}, instances: [] })).rejects.toThrow('merge_resources_unverified')
  expect(invoke).not.toHaveBeenCalled()
})
it('archives only self-contained local image source and display bytes', async () => {
  const instance = { instanceId: 'a', documentId: null, sourcePath: 'assets/.originals/img-a.png', displayPath: 'assets/img-a.png', sourceHash: 'hash', referenceRevision: 1, recipe: defaultRecipe() }
  const local = '![a](assets/img-a.png)', base = snapshot('base'), disk = snapshot('disk')
  await expect(prepareMerge('id', 'b', 'r', base, local, disk, mergeBytes(local, base), { assets: {}, instances: [instance] })).rejects.toThrow('merge_resources_unverified')
  await prepareMerge('id', 'b', 'r', base, local, disk, mergeBytes(local, base), { assets: { [instance.sourcePath]: new Blob(['source']), [instance.displayPath]: new Blob(['display']), 'assets/img-unused.png': new Blob(['unused']) }, instances: [instance] })
  const input = (vi.mocked(invoke).mock.calls[0][1] as { input: { assets: { path: string }[] } }).input
  expect(input.assets.map(a => a.path).sort()).toEqual([instance.sourcePath, instance.displayPath].sort())
  expect(mergeError('revision_conflict')).toContain('再次变化')
  expect(mergeError('merge_archive_quota')).toContain('512 MiB')
})
