import { describe, expect, it } from 'vitest'
import { htmlImageTags, rewriteHtmlImage } from './html-images'
import { parseDocument } from './markdown'
import { historyResourceSets } from './history-resources'
import { linkUrls, rewriteOutgoing } from './link-rewrite'

const sample = '<p align="center">\n  <a">\n    <img src="./images/vscode.png" alt="ros"  width="600" height="auto">\n  </a>\n</p>'

describe('raw HTML images', () => {
  it('finds src and alt value spans in quoted, single-quoted and unquoted forms', () => {
    const source = `<img src="a.png" alt="一"><IMG ALT='二' SRC='b c.png' width=1/><img src=c.png><!-- <img src="x.png"> --><img alt=x>`
    const tags = htmlImageTags(source)
    expect(tags.map(tag => [tag.src?.value ?? null, tag.alt?.value ?? null])).toEqual([['a.png', '一'], ['b c.png', '二'], ['c.png', null], [null, 'x']])
    for (const tag of tags) if (tag.src) expect(source.slice(tag.src.from, tag.src.to)).toMatch(/^["']?[^"']+["']?$/)
    expect(htmlImageTags('<img src="a&amp;b.png" alt="&quot;x&quot;">')[0]).toMatchObject({ src: { value: 'a&b.png' }, alt: { value: '"x"' } })
    expect(htmlImageTags('<img src="never closed')).toEqual([])
  })

  it('lists HTML images as editable references covering the whole tag', () => {
    const parsed = parseDocument(sample)
    const image = parsed.images.find(item => item.html)!
    expect(image).toMatchObject({ url: './images/vscode.png', alt: 'ros' })
    expect(sample.slice(image.from, image.to)).toBe('<img src="./images/vscode.png" alt="ros"  width="600" height="auto">')
    expect(parsed.html).toContain(`data-source-from="${image.from}"`)
  })

  it('rewrites only src and alt, keeping width, align and spacing byte-exact', () => {
    const image = parseDocument(sample).images.find(item => item.html)!
    const tag = rewriteHtmlImage(sample, image.html!, 'assets/img-1-v-2.png', '新"说明"')
    expect(tag).toBe('<img src="assets/img-1-v-2.png" alt="新&quot;说明&quot;"  width="600" height="auto">')
    const bare = htmlImageTags('<img width="10" src=x.png>')[0]
    expect(rewriteHtmlImage('<img width="10" src=x.png>', bare, 'y.png', '图')).toBe('<img alt="图" width="10" src="y.png">')
  })

  it('edits single-line container HTML in place, but not multi-line container HTML whose text differs from the source', () => {
    const single = '> <img src="assets/a.png" alt="引用">'
    const image = parseDocument(single).images.find(item => item.html)!
    expect(single.slice(image.from, image.to)).toBe('<img src="assets/a.png" alt="引用">')
    // Later lines carry `> ` prefixes, so node.value no longer matches the source slice.
    const multi = '> <p align="center">\n> <img src="assets/b.png" alt="多行">\n> </p>'
    const parsed = parseDocument(multi)
    expect(parsed.images.some(item => item.html)).toBe(false)
    expect(parsed.html).toContain('data-resource="assets/b.png"')
    expect(historyResourceSets(multi).references).toEqual(['assets/b.png'])
  })

  it('counts HTML images for history, backup and sync, and rewrites them on move', () => {
    const text = 'Intro\n\n<p align="center"><img src="assets/img-a-v1.png" width="200"></p>\n'
    expect(historyResourceSets(text).references).toEqual(['assets/img-a-v1.png'])
    expect(linkUrls(text)).toContain('assets/img-a-v1.png')
    const moved = rewriteOutgoing('<img src="images/a b.png" alt="x">', 'note.md', 'sub/note.md')
    expect(moved.text).toBe('<img src="../images/a%20b.png" alt="x">')
    const single = rewriteOutgoing("<img src='images/a.png'>", 'note.md', 'sub/note.md')
    expect(single.text).toBe("<img src='../images/a.png'>")
  })
})
