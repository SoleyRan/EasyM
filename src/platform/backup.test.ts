import { beforeEach, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { decodeFile, encodeFile } from '../core/codec'
import { backupError, createBackup, validateBackup, inspectBackup, releaseBackup, restoreBackup, type BackupDraft, type BackupInspection } from './backup'
import { defaultRecipe } from '../core/images'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const draft = (text = '当前正文\n'): BackupDraft => ({ id: 'id', name: '中文.md', bytes: new TextEncoder().encode(text), revision: 'revision', error: '', resources: { assets: {}, instances: [] } })
const inspection = (text: string, availableReferences: string[] = []): BackupInspection => ({ token: 'token', summary: { documentName: '中文.md', createdAt: 1, files: 3, bytes: 42, includesHistory: false, packageHash: 'sha256:hash' }, reviews: [{ text, availableReferences }] })
beforeEach(() => vi.mocked(invoke).mockReset())
it('creates from exact bytes, frozen revision and explicit opt-in without saving the document', async () => {
  const d = draft(); const snapshot = decodeFile(new TextEncoder().encode('\uFEFF旧正文\r\n'))
  d.bytes = encodeFile(snapshot, '未保存正文\n')
  await createBackup(d, false)
  expect(invoke).toHaveBeenCalledExactlyOnceWith('create_document_backup', { input: expect.objectContaining({ id: 'id', name: '中文.md', bytes: [...new TextEncoder().encode('\uFEFF未保存正文\r\n')], expectedRevision: 'revision', includeHistory: false }) })
  await createBackup(d, true); expect(invoke).toHaveBeenLastCalledWith('create_document_backup', { input: expect.objectContaining({ includeHistory: true }) })
})
it('supports new documents while refusing history and mixed-line-ending edits before IPC', async () => {
  const d = { ...draft(''), id: null, revision: null }; await createBackup(d, false)
  expect(invoke).toHaveBeenLastCalledWith('create_document_backup', { input: expect.objectContaining({ id: null, expectedRevision: null }) })
  await expect(createBackup(d, true)).rejects.toThrow('history_disabled')
  await expect(createBackup({ ...d, bytes: null, error: 'mixed_line_endings' }, false)).rejects.toThrow('mixed_line_endings')
  expect(invoke).toHaveBeenCalledTimes(1)
})
it('collects referenced source/display instances and excludes unrelated memory resources', async () => {
  const d = draft('![a](assets/img-a.png)\n![remote](https://example.com/a.png)')
  const instance = { instanceId: 'a', documentId: null, sourcePath: 'assets/.originals/img-a.png', displayPath: 'assets/img-a.png', sourceHash: 'hash', referenceRevision: 1, recipe: defaultRecipe() }
  d.resources = { assets: { [instance.sourcePath]: new Blob(['source']), [instance.displayPath]: new Blob(['display']), 'unused.png': new Blob(['unused']) }, instances: [instance] }
  await createBackup(d, false)
  expect(invoke).toHaveBeenCalledWith('create_document_backup', { input: expect.objectContaining({ references: ['assets/img-a.png'], unarchivedReferences: [], assets: [{ path: instance.displayPath, bytes: [...new TextEncoder().encode('display')] }, { path: instance.sourcePath, bytes: [...new TextEncoder().encode('source')] }], metadata: { schemaVersion: 1, instances: [instance] } }) })
})
it('refuses unsafe image URLs before creation but leaves absent local bytes for native authorized lookup', async () => {
  for (const url of ['../outside.png', 'file:///private.png', 'data:image/png;base64,AAAA']) await expect(createBackup(draft(`![a](${url})`), false)).rejects.toThrow('backup_resource_missing')
  expect(invoke).not.toHaveBeenCalled()
  await createBackup(draft('![a](images/a.png)'), false)
  expect(invoke).toHaveBeenCalledWith('create_document_backup', { input: expect.objectContaining({ assets: [], references: ['images/a.png'] }) })
})
it('AST review scans image references only and requires exact current resource set', async () => {
  const value = inspection('![a][id]\n\n[id]: images/a.png\n\n`![fake](fake.png)`\n\n![remote](https://example.com/a.png)', ['images/a.png'])
  expect(await validateBackup(value)).toEqual([['images/a.png']])
  await expect(validateBackup(inspection('![a](a.png)'))).rejects.toThrow('backup_resource_missing')
  await expect(validateBackup(inspection('plain', ['extra.png']))).rejects.toThrow('backup_resource_missing')
  await expect(validateBackup(inspection('![a](../a.png)'))).rejects.toThrow('backup_resource_missing')
  await expect(validateBackup({ ...value, reviews: [] })).rejects.toThrow('backup_corrupt')
})
it('history review allows original resources but refuses any missing image and duplicate inventory', async () => {
  const value = inspection('plain'); value.reviews.push({ text: '![a](display.png)', availableReferences: ['source.png', 'display.png'] })
  expect(await validateBackup(value)).toEqual([[], ['display.png']])
  value.reviews[1].availableReferences = ['source.png']; await expect(validateBackup(value)).rejects.toThrow('backup_resource_missing')
  value.reviews[1].availableReferences = ['display.png', 'display.png']; await expect(validateBackup(value)).rejects.toThrow('backup_resource_missing')
})
it('bounds per-body UTF-8 bytes and aggregate review work before AST analysis', async () => {
  await expect(validateBackup(inspection('x'.repeat(10 * 1024 * 1024 + 1)))).rejects.toThrow('quota_exceeded')
  await expect(validateBackup(inspection('中'.repeat(4 * 1024 * 1024)))).rejects.toThrow('quota_exceeded')
  const value = inspection('x'.repeat(10 * 1024 * 1024))
  value.reviews = Array(8).fill(value.reviews[0])
  await expect(validateBackup(value)).rejects.toThrow('quota_exceeded')
  await expect(validateBackup(inspection('', Array(65536 + 4097).fill('a.png')))).rejects.toThrow('quota_exceeded')
})
it('uses native-selected inspection tokens for restore/release and explains actionable errors', async () => {
  await inspectBackup(); await restoreBackup('token', [['a.png']]); await releaseBackup('token')
  expect(vi.mocked(invoke).mock.calls).toEqual([['inspect_document_backup'], ['restore_document_backup', { token: 'token', references: [['a.png']] }], ['release_document_backup', { token: 'token' }]])
  expect(backupError('backup_changed')).toContain('重新选择'); expect(backupError('mixed_line_endings')).toContain('换行'); expect(backupError('history_corrupt')).toContain('哈希')
})
