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

it('renders block HTML images through the local loader with their layout attributes', () => {
  const text = '<p align="center">\n  <a">\n    <img src="./images/vscode_terminal.png" alt="ros"  width="600" height="auto">\n  </a>\n</p>\n\n后文'
  const parsed = parseDocument(text)
  expect(parsed.html).toContain('<p align="center">')
  expect(parsed.html).toMatch(/<img[^>]*data-resource="\.\/images\/vscode_terminal\.png"/)
  expect(parsed.html).toMatch(/<img[^>]*alt="ros"/)
  expect(parsed.html).toMatch(/<img[^>]*width="600"/)
  expect(parsed.html).not.toMatch(/<img[^>]*\ssrc=/)
  // Block HTML keeps its source range so live preview can render and reveal it.
  expect(parsed.blocks?.find(block => block.type === 'html')).toMatchObject({ from: 0, to: text.indexOf('\n\n后文') })
})

it('sanitizes embedded HTML and never requests remote HTML images', () => {
  const parsed = parseDocument('<div onclick="alert(1)" style="color:red"><img src="https://remote.example/p.png" onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">x</a><iframe src="https://evil.example"></iframe></div>')
  expect(parsed.html).not.toMatch(/onclick|onerror|style=|<script|javascript:|<iframe/)
  expect(parsed.html).toContain('data-resource="https://remote.example/p.png"')
  expect(parsed.html).not.toContain('src="https:')
  expect(parseDocument('文字 <span onmouseover="x()">内联</span> 文字').html).not.toContain('onmouseover')
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
