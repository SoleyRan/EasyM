import { describe, expect, it, vi } from 'vitest'
import { applyPatches, imageMarkdown, insertImage } from '../core/document'
import { defaultRecipe } from '../core/images'
import { commitImageChange } from './image-transaction'

const recipe = defaultRecipe()
const source = new Blob(['source'], { type: 'image/png' })
const result = { blob: new Blob(['display'], { type: 'image/png' }), width: 1, height: 1, mime: 'image/png' as const }
const instance = { instanceId: 'img-one', documentId: null, sourcePath: 'assets/.originals/img-one-source.png', displayPath: 'assets/img-one-v1.png', sourceHash: 'sha256:source', recipe, referenceRevision: 1 }
const old = imageMarkdown('old', instance.displayPath)
const base = { text: old + '\n' + old, baseText: old + '\n' + old, selection: { anchor: 0, head: old.length }, replaceImage: true, resources: { assets: { [instance.sourcePath]: source }, instances: [instance] }, instance, source, result, recipe, alt: 'new', displayPath: 'assets/img-one-v2.png' }

describe('image application transaction', () => {
  it('inserts at document start without swallowing a heading, and normalizes reverse selections', () => {
    expect(applyPatches('# title', insertImage('# title', { anchor: 0, head: 0 }, '![](img.png)').patches)).toBe('![](img.png)\n# title')
    const text = 'before selected after'
    const forward = insertImage(text, { anchor: 7, head: 15 }, '![](img.png)')
    const reverse = insertImage(text, { anchor: 15, head: 7 }, '![](img.png)')
    expect(reverse.patches).toEqual(forward.patches)
    expect(applyPatches(text, reverse.patches)).toBe('before \n![](img.png)\n after')
  })

  it('changes only the selected occurrence and retains the immutable source and old display recipe', async () => {
    let body = base.text
    const persist = vi.fn(async () => undefined)
    const resources = await commitImageChange(base, persist, (patch) => { body = applyPatches(body, [patch]); return true })
    expect(body).toBe(imageMarkdown('new', base.displayPath) + '\n' + old)
    expect(resources.assets[instance.sourcePath]).toBe(source)
    expect(resources.instances.map((item) => item.displayPath)).toEqual([instance.displayPath, base.displayPath])
    expect(persist).toHaveBeenCalledWith(body, resources)
  })

  it('leaves editor text and resources untouched when persistence fails', async () => {
    const patch = vi.fn(() => true)
    await expect(commitImageChange(base, async () => { throw new Error('disk full') }, patch)).rejects.toThrow('disk full')
    expect(patch).not.toHaveBeenCalled()
    expect(Object.keys(base.resources.assets)).toEqual([instance.sourcePath])
    expect(base.resources.instances).toEqual([instance])
  })

  it('rejects stale text before writing any resources', async () => {
    const persist = vi.fn(async () => undefined)
    await expect(commitImageChange({ ...base, text: 'changed' }, persist, () => true)).rejects.toThrow('正文已变化')
    expect(persist).not.toHaveBeenCalled()
  })
})
