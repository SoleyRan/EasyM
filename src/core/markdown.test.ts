import { expect, it } from 'vitest'
import { parseDocument } from './markdown'

it('uses the chosen language grammar and safely preserves code text', () => {
  const code = 'const x = 1; // comment'
  const js = parseDocument('```javascript\n' + code + '\n```').html
  const py = parseDocument('```python\n' + code + '\n```').html
  expect(js).toContain('class="hljs-keyword">const')
  expect(py).not.toContain('class="hljs-keyword">const')
  expect(js).toContain('hljs-comment')
  expect(parseDocument('```\n' + code + '\n```').html).not.toContain('hljs-')
  expect(parseDocument('```unknown\n' + code + '\n```').html).not.toContain('hljs-')
  const unsafe = parseDocument('```html\n<script>alert(1)</script><img src=x onerror=alert(1)>\n```').html
  expect(unsafe).not.toContain('<script>'); expect(unsafe).not.toContain('<img ')
  expect(unsafe).toContain('&#x3C;')
})

it('retains source ranges for two separate instances of the same image', () => {
  const parsed = parseDocument('![one](assets/a.png)\n\n![two](assets/a.png)')
  expect(parsed.images).toHaveLength(2)
  expect(parsed.images[0].url).toBe(parsed.images[1].url)
  expect(parsed.images[0].from).not.toBe(parsed.images[1].from)
  expect(parsed.html).toContain('data-resource="assets/a.png"')
  expect(parsed.html).not.toContain('src="assets/a.png"')
})

it('removes executable HTML and dangerous URLs', () => {
  const parsed = parseDocument('<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n![track](https://remote.example/pixel)')
  expect(parsed.html).not.toContain('<script')
  expect(parsed.html).not.toContain('href="javascript:')
  expect(parsed.html).not.toContain('src="https:')
})

it('renders GFM without serializing original text', () => {
  const parsed = parseDocument('- [x] 完成\n\n~~删除~~\n\n| A | B |\n| - | - |\n| 1 | 2 |')
  expect(parsed.html).toContain('type="checkbox"')
  expect(parsed.html).toContain('<del')
  expect(parsed.html).toContain('<table')
})

it('resolves reference-style images without requesting their external URL', () => {
  const text = '![one][photo]\n\n![two][photo]\n\n[photo]: https://remote.example/pixel.png'
  const parsed = parseDocument(text)
  expect(parsed.images.map((image) => text.slice(image.from, image.to))).toEqual(['![one][photo]', '![two][photo]'])
  expect(parsed.images.every((image) => image.url === 'https://remote.example/pixel.png')).toBe(true)
  expect(parsed.html).toContain('data-resource="https://remote.example/pixel.png"')
  expect(parsed.html).not.toContain('src="https:')
})
