import { describe, expect, it, vi } from 'vitest'
import { applyPatches, imageMarkdown, insertImage } from '../core/document'
import { defaultRecipe } from '../core/images'
import { commitImageChange } from './image-transaction'
import { htmlImageTags } from '../core/html-images'

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

  it('writes an edited HTML image back into its <img> tag, keeping width and align', async () => {
    const html = '<p align="center"><img src="./images/a.png" alt="old" width="600"></p>'
    const text = 'Intro\n\n' + html
    const tag = htmlImageTags(text)[0]
    let body = text
    const persist = vi.fn(async () => undefined)
    await commitImageChange({ ...base, text, baseText: text, selection: { anchor: tag.from, head: tag.to }, html: tag }, persist, (patch) => { body = applyPatches(body, [patch]); return true })
    expect(body).toBe(`Intro\n\n<p align="center"><img src="${base.displayPath}" alt="new" width="600"></p>`)
    expect(persist).toHaveBeenCalledWith(body, expect.anything())
    // A tag that no longer starts with <img (text changed underneath) is refused before any write.
    const stale = { ...tag, from: tag.from - 3, to: tag.to - 3 }
    const refused = vi.fn(async () => undefined)
    await expect(commitImageChange({ ...base, text, baseText: text, selection: { anchor: 0, head: 0 }, html: stale }, refused, () => true)).rejects.toThrow('正文已变化')
    expect(refused).not.toHaveBeenCalled()
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
