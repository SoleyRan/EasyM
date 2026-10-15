// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { parseDocument } from './markdown'
import { createExport, localImagePath } from './export'

const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), char => char.charCodeAt(0))

it('keeps complete inert metadata and valid footnote/backreference anchors after export', async () => {
  const text = '---\ntitle: "<script>danger</script>"\n---\n\n正文[^中文] again[^中文] missing[^none]\n\n[^中文]: **说明**\n\n    第二段\n\n[^中文]: 重复\n\n[^unused]: 未引用'
  const parsed = parseDocument(text), preview = new DOMParser().parseFromString(parsed.html, 'text/html')
  const refs = [...preview.querySelectorAll('a[data-footnote-ref]')]
  expect(refs.map(node => node.textContent)).toEqual(['1', '1'])
  const links = [...refs, ...preview.querySelectorAll('a[data-footnote-backref]')]
  expect(links).toHaveLength(4)
  for (const link of links) {
    const target = preview.getElementById(link.getAttribute('href')!.slice(1))
    expect(target).not.toBeNull()
    expect(target!.id).toMatch(/^user-content-/)
    expect(Number(target!.getAttribute('data-source-from'))).toBeGreaterThan(0)
  }
  expect(preview.querySelector('.footnotes strong')?.textContent).toBe('说明')
  expect(preview.querySelector('.footnotes')?.textContent).toContain('第二段')
  expect(preview.body.textContent).toContain('missing[^none]')
  expect(preview.querySelectorAll('.markdown-metadata')).toHaveLength(3)
  expect(preview.querySelector('.markdown-metadata code')?.textContent).toBe(text.slice(0, text.indexOf('\n\n')))
  const output = await createExport(parsed, '脚注.md', async () => { throw new Error('no image') })
  const exported = new DOMParser().parseFromString(output.html, 'text/html')
  for (const link of exported.querySelectorAll('a[href^="#"]')) expect(exported.getElementById(link.getAttribute('href')!.slice(1))).not.toBeNull()
  expect(exported.querySelector('script')).toBeNull()
  expect(exported.querySelector('[data-source-from]')).toBeNull()
  expect(exported.querySelector('.markdown-metadata code')?.textContent).toBe(preview.querySelector('.markdown-metadata code')?.textContent)
})

it('recognizes initial TOML metadata without interpreting unfinished or mid-document fences', () => {
  const doc = new DOMParser().parseFromString(parseDocument('+++\ntitle = "中文"\n+++\n\n# 标题').html, 'text/html')
  expect(doc.querySelector('.markdown-metadata > p')?.textContent).toContain('TOML')
  expect(doc.querySelector('.markdown-metadata code')?.textContent).toBe('+++\ntitle = "中文"\n+++')
  expect(parseDocument('---\ntitle: unfinished').html).not.toContain('markdown-metadata')
  expect(parseDocument('正文\n\n---\n\ntitle: middle\n\n---').html).not.toContain('markdown-metadata')
})

it('keeps note headings out of the main outline and anchors early/cyclic definitions safely', () => {
  const text = '[^a]: ## Note heading\n\n    [^b]\n\n[^b]: B[^a]\n\n# Document heading\n\ntext[^a] special[^a/b]\n\n[^a/b]: special'
  const parsed = parseDocument(text), doc = new DOMParser().parseFromString(parsed.html, 'text/html')
  expect(parsed.headings.map(heading => heading.title)).toEqual(['Document heading'])
  expect(doc.querySelectorAll('.footnotes ol > li')).toHaveLength(3)
  for (const link of doc.querySelectorAll('a[data-footnote-ref],a[data-footnote-backref]')) expect(doc.getElementById(link.getAttribute('href')!.slice(1))).not.toBeNull()
})

it('exports sanitized static HTML, escaped titles, code, Chinese and bordered tables without active content', async () => {
  const load = vi.fn()
  const output = await createExport(parseDocument('# 中文\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert%281%29)\n\n|甲|乙|\n|---|---|\n|一|二|\n\n```js\nconst n = 1\n```'), '</title><script>alert(2)</script>.md', load)
  const doc = new DOMParser().parseFromString(output.html, 'text/html')
  expect(doc.querySelector('script')).toBeNull()
  expect(doc.querySelector('a')?.hasAttribute('href')).toBe(false)
  expect(doc.querySelector('title')?.textContent).toBe('</title><script>alert(2)</script>')
  expect(doc.querySelector('h1')?.textContent).toBe('中文')
  expect(doc.querySelector('td')?.textContent).toBe('一')
  expect(doc.querySelector('code .hljs-keyword')?.textContent).toBe('const')
  expect(doc.querySelector('[data-source-from]')).toBeNull()
  expect(doc.querySelector('meta[http-equiv]')?.getAttribute('content')).toContain("default-src 'none'")
  expect(load).not.toHaveBeenCalled()
})

it('inlines unique local resources and gives missing/remote images inert text placeholders', async () => {
  const load = vi.fn(async (path: string) => { if (path !== '图片/a.png') throw new Error('missing'); return new Blob([png], { type: 'image/png' }) })
  const parsed = parseDocument('![本地](图片/a.png)\n\n![重复](%E5%9B%BE%E7%89%87/a.png)\n\n![缺失](gone.png)\n\n![远程](https://evil.example/img.png)\n\n![data](data:image/svg+xml,x)\n\n![越界](../out.png)')
  const output = await createExport(parsed, '中文.md', load)
  const doc = new DOMParser().parseFromString(output.html, 'text/html')
  expect(doc.querySelectorAll('img')).toHaveLength(2)
  expect(doc.querySelector('img')?.src).toMatch(/^data:image\/png;base64,/)
  expect(doc.querySelectorAll('.missing-image')).toHaveLength(4)
  expect(load.mock.calls.map(([path]) => path)).toEqual(['图片/a.png', 'gone.png'])
  expect(output.warnings).toHaveLength(4)
  expect(output.name).toBe('中文.html')
  expect(parsed.images[0].url).toBe('图片/a.png')
})

it('rejects ambiguous or untrusted paths before any local read', () => {
  for (const path of ['//server/a', '/etc/a', 'C:/a', 'file:///a', 'https://a', 'data:x', '..%2Fa', '%2e%2e/a', 'a\\b', 'a%00b', '%invalid', 'a?x', 'a#x']) expect(localImagePath(path)).toBeNull()
  expect(localImagePath('./图片/a.png')).toBe('图片/a.png')
})

it('does not inline SVG or a falsely labelled image', async () => {
  const output = await createExport(parseDocument('![bad](a.png)'), 'note.md', async () => new Blob(['<svg onload="alert(1)"></svg>'], { type: 'image/png' }))
  expect(output.body).not.toContain('<img')
  expect(output.body).not.toContain('<svg')
  expect(output.warnings).toHaveLength(1)
})
