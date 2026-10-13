import { expect, it } from 'vitest'
import { batchReferences, batchPatches, batchRecipe } from './batch-images'
import { applyPatches } from './document'
import { defaultRecipe, imageGeometry, type ImageInstance } from './images'
const options = { maxSide: 100, format: 'keep' as const, quality: 0.9, stripMetadata: true, background: null }
const instance: ImageInstance = { instanceId: 'img-test', documentId: null, sourcePath: 'assets/.originals/img-test-source.png', sourceHash: 'sha256:test', displayPath: 'assets/img-test-batch.png', recipe: defaultRecipe(), referenceRevision: 1 }
it('isolates one shared reference occurrence, preserves title and leaves definitions/code untouched', () => {
  const text = '😀 ![one][p] ![two][p]\n\n[p]: assets/img-old.png "caption"\n\n`![code](assets/img-old.png)`'
  const references = batchReferences(text)
  expect(references).toHaveLength(2)
  const result = applyPatches(text, batchPatches(text, [{ reference: references[1], instance }]))
  expect(result).toContain('![one][p] ![two](assets/img-test-batch.png "caption")')
  expect(result).toContain('[p]: assets/img-old.png "caption"')
  expect(result).toContain('`![code](assets/img-old.png)`')
})
it('scales current geometry without repeating old crop/rotation and never upscales', () => {
  const recipe = batchRecipe(400, 200, 'image/png', options)
  expect(imageGeometry(400, 200, recipe).output).toEqual({ width: 100, height: 50 })
  expect(recipe.crop).toBeUndefined(); expect(recipe.rotateDegrees).toBe(0)
  expect(imageGeometry(100, 50, { ...recipe, crop: { unit: 'sourcePixel', x: 0, y: 0, width: 50, height: 50 }, resize: undefined }).output).toEqual({ width: 50, height: 50 })
  expect(batchRecipe(20, 10, 'image/jpeg', options).resize).toEqual({ width: 20, height: 10 })
})
it('rejects changed/overlapping references, empty or oversized batches and invalid options', () => {
  const reference = batchReferences('![x](assets/img-x.png)')[0]
  expect(() => batchPatches('changed', [{ reference, instance }])).toThrow()
  expect(() => batchPatches('![x](assets/img-x.png)', [{ reference, instance }, { reference, instance }])).toThrow()
  expect(() => batchPatches('', [])).toThrow()
  expect(() => batchRecipe(20, 10, 'image/png', { ...options, quality: 2 })).toThrow()
})
