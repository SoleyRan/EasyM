// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { parseDocument } from './markdown'
import { createExport } from './export'
import { cleanMath, MATH_LIMITS } from './math'
import { fromHtml } from 'hast-util-from-html'
import { unified } from 'unified'
import rehypeStringify from 'rehype-stringify'

const dom = (text: string, math = true) => new DOMParser().parseFromString(parseDocument(text, { math }).html, 'text/html')
it('renders fractions, roots, sums, matrices and inline math with source ranges', () => {
  const text = '# 公式\n\n中文 $E=mc^2$ 邻接。\n\n$$\n\\frac{1}{2}+\\sqrt{x}+\\sum_{i=1}^{n} i+\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}\n$$'
  const parsed = parseDocument(text), doc = new DOMParser().parseFromString(parsed.html, 'text/html')
  expect(doc.querySelectorAll('math')).toHaveLength(2)
  for (const tag of ['mfrac', 'msqrt', 'munderover', 'mtable']) expect(doc.querySelector(tag)).not.toBeNull()
  expect(doc.querySelector('.math-inline')?.getAttribute('data-source-from')).toBe(String(text.indexOf('$')))
  expect(doc.querySelector('math[display="block"]')).not.toBeNull()
  expect(doc.querySelector('annotation')?.textContent).toBe('E=mc^2')
  expect(parsed.blocks?.map(block => block.type)).toEqual(['mathInline', 'math'])
  expect(dom('$1+2=3$').querySelector('math')).not.toBeNull()
  expect(dom('> $$\n> x+y\n> $$').querySelector('math')).not.toBeNull()
})
it('keeps common prices, escaped dollars, code and metadata as text', () => {
  const doc = dom('---\nprice: $5\n---\n\n价格 $5 and $10；转义 \\$x\\$；空白 $ a $；多行 $a\nb$；`$code$`\n\n```tex\n$x$\n```')
  expect(doc.querySelector('math')).toBeNull()
  expect(doc.body.textContent).toContain('$5 and $10')
  expect(doc.body.textContent).toContain('$ a $')
})
it('bounds errors and rejects commands that could enable resources, HTML, macros or styling', () => {
  for (const command of ['\\href{https://evil.example}{x}', '\\includegraphics{file:///a}', '\\htmlStyle{color:red}{x}', '\\def\\a{a}\\a', '\\newcommand{\\a}{a}', '\\color{white}x', '\\unknown{x}', '\\frac{']) {
    const text = `$${command}$\n\n正常 $a+b$`, doc = dom(text)
    expect(doc.querySelectorAll('math')).toHaveLength(1)
    expect(doc.querySelector('.math-source code')?.textContent).toBe(`$${command}$`)
    expect(doc.querySelector('script,style,img,a,svg,[style],[href],[src]')).toBeNull()
  }
  expect(dom('$$\nx+y').querySelector('.math-source code')?.textContent).toBe('$$\nx+y')
})
it('keeps complete source when disabled or over the count, input and output budgets', () => {
  const disabled = dom('inline $x$\n\n$$\nx+y\n$$', false)
  expect(disabled.querySelector('math')).toBeNull()
  expect([...disabled.querySelectorAll('.math-source code')].map(node => node.textContent)).toEqual(['$x$', '$$\nx+y\n$$'])
  const oversized = `$${'x'.repeat(MATH_LIMITS.formula + 1)}$`
  expect(dom(oversized).querySelector('.math-source code')?.textContent).toBe(oversized)
  const many = dom(Array.from({length:201}, (_, i) => `$x_${i}$`).join(' '))
  expect(many.querySelectorAll('math')).toHaveLength(200)
  expect(many.querySelectorAll('.math-source')).toHaveLength(1)
  const total = dom(Array.from({length:10}, () => `$x${' '.repeat(15000)}x$`).join('\n\n'))
  expect(total.querySelector('.math-source')).not.toBeNull()
})
it('sanitizes MathML independently without granting raw Markdown new capabilities', () => {
  const html = String(unified().use(rehypeStringify).stringify(cleanMath(fromHtml('<math href="https://evil.example" id="location" onclick="bad()"><mi style="color:red">x</mi><annotation-xml encoding="text/html"><script>bad()</script></annotation-xml></math>', { fragment:true }))))
  expect(html).toContain('<mi>x</mi>')
  expect(html).not.toMatch(/href|id=|onclick|style|script|annotation-xml/)
  expect(dom('<math><mi>raw</mi></math>\n\n$x$').querySelectorAll('math')).toHaveLength(1)
})
it('renders note/table formulas and exports offline static MathML with TeX annotations', async () => {
  const parsed = parseDocument('| 公式 |\n| --- |\n| $a+b$ |\n\n正文[^x]\n\n[^x]: $x^2$')
  const output = await createExport(parsed, '公式.md', async () => { throw Error('no resources') })
  const doc = new DOMParser().parseFromString(output.html, 'text/html')
  expect(doc.querySelectorAll('math')).toHaveLength(2)
  expect(doc.querySelector('annotation')?.textContent).toBe('a+b')
  expect(doc.querySelector('script,link,img,[data-source-from]')).toBeNull()
})
