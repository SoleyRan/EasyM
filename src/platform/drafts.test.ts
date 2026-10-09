import 'fake-indexeddb/auto'
import { beforeEach, expect, it } from 'vitest'
import { drafts, type Draft } from './drafts'
import { blankSnapshot } from '../core/codec'
import { defaultRecipe } from '../core/images'

beforeEach(async () => { for (const key of await drafts.keys()) await drafts.clear(key) })

it('isolates legacy and multiple document drafts when saving or clearing one', async () => {
  const draft: Draft = { version: 1, name: 'note.md', text: 'legacy', snapshot: blankSnapshot(), updatedAt: 1 }
  await drafts.save(draft)
  await drafts.save({ ...draft, text: 'one' }, 'document:one')
  await drafts.save({ ...draft, text: 'two' }, 'document:two')
  await drafts.clear('document:one')
  expect(await drafts.keys()).toEqual(['current', 'document:two'])
  expect((await drafts.load())?.text).toBe('legacy')
  expect((await drafts.load('document:two'))?.text).toBe('two')
})

it('persists unapplied image pixels, crop, rotation, alt and source selection for restart', async () => {
  const source = new Blob(['immutable source'], { type: 'image/png' })
  const recipe = { ...defaultRecipe(), rotateDegrees: 90 as const, crop: { unit: 'sourcePixel' as const, x: 1, y: 2, width: 4, height: 3 } }
  const draft: Draft = {
    version: 1, name: 'note.md', text: '# original', snapshot: blankSnapshot(), updatedAt: 1,
    resources: { assets: { 'assets/.originals/img-one-source.png': source }, instances: [] },
    imageSession: {
      source, width: 10, height: 10, alt: '恢复图片', recipe, target: null,
      selection: { anchor: 0, head: 0 }, baseText: '# original', operationId: 'operation', displayToken: 'token',
      instance: { instanceId: 'img-one', documentId: null, sourcePath: 'assets/.originals/img-one-source.png', sourceHash: 'sha256:source', displayPath: '', recipe, referenceRevision: 0 },
    },
  }
  await drafts.save(draft)
  const restored = await drafts.load()
  expect(restored?.text).toBe('# original')
  expect(restored?.imageSession?.recipe).toEqual(recipe)
  expect(restored?.imageSession?.alt).toBe('恢复图片')
  expect(await restored?.imageSession?.source.text()).toBe('immutable source')
  expect(restored?.imageSession?.selection).toEqual({ anchor: 0, head: 0 })
})

it('discarding a recovery draft clears it without mutating the original snapshot', async () => {
  const snapshot = blankSnapshot()
  await drafts.save({ version: 1, name: 'note.md', text: 'local', snapshot, updatedAt: 1 })
  await drafts.clear()
  expect(await drafts.load()).toBeUndefined()
  expect(snapshot.originalBytes).toHaveLength(0)
})

it('refuses unknown draft versions while retaining the stored data', async () => {
  await drafts.save({ version: 2, name: 'future', text: '', snapshot: blankSnapshot(), updatedAt: 1 } as unknown as Draft)
  await expect(drafts.load()).rejects.toThrow('不兼容')
  await expect(drafts.load()).rejects.toThrow('不兼容')
})
