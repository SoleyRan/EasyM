import { describe, expect, it } from 'vitest'
import { addResources } from '../platform/images'
import { defaultRecipe, imageGeometry, inspectImage, validateRecipe } from './images'

const png1x1 = Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,31,21,196,137])

describe('image contract', () => {
  it('inspects supported PNG dimensions and rejects oversized geometry', () => {
    expect(inspectImage(png1x1)).toMatchObject({ mime: 'image/png', width: 1, height: 1 })
    expect(() => imageGeometry(100, 100, { ...defaultRecipe(), crop: { unit: 'sourcePixel', x: 50, y: 0, width: 60, height: 50 } })).toThrow()
  })

  it('computes quarter-turn output and validates recipe fields', () => {
    const geometry = imageGeometry(1200, 800, { ...defaultRecipe(), rotateDegrees: 90, resize: { width: 400, height: 600 } })
    expect(geometry.rotated).toEqual({ width: 800, height: 1200 })
    expect(geometry.output).toEqual({ width: 400, height: 600 })
    expect(() => validateRecipe({ ...defaultRecipe(), rotateDegrees: 45 as never })).toThrow()
  })

  it('keeps two inserted instances isolated when one display path changes', () => {
    const recipe = { ...defaultRecipe() }
    const first = { instanceId: 'img-one', documentId: null, sourcePath: 'assets/.originals/img-one-source.png', sourceHash: 'sha256:1', displayPath: 'assets/img-one-v1.png', recipe, referenceRevision: 1 }
    const second = { instanceId: 'img-two', documentId: null, sourcePath: 'assets/.originals/img-two-source.png', sourceHash: 'sha256:2', displayPath: 'assets/img-two-v1.png', recipe, referenceRevision: 1 }
    const initial = addResources({ assets: {}, instances: [] }, {
      [first.sourcePath]: new Blob([png1x1]), [first.displayPath]: new Blob([png1x1]),
      [second.sourcePath]: new Blob([png1x1]), [second.displayPath]: new Blob([png1x1]),
    }, first)
    const current = addResources(initial, {}, second)
    const next = addResources(current, { 'assets/img-one-v2.png': new Blob([png1x1]) }, { ...first, displayPath: 'assets/img-one-v2.png', referenceRevision: 2 })
    expect(next.instances.map((item) => item.instanceId)).toEqual(['img-one', 'img-two', 'img-one'])
    expect(next.assets[first.sourcePath]).toBe(current.assets[first.sourcePath])
    expect(next.instances[0].displayPath).toBe(first.displayPath)
    expect(next.instances.find((item) => item.instanceId === 'img-two')?.displayPath).toBe(second.displayPath)
  })
})
