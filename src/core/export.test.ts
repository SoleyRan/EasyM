// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { parseDocument } from './markdown'
import { createExport, localImagePath } from './export'

const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), char => char.charCodeAt(0))

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
