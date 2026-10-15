// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { mermaidIssue, MERMAID_LIMITS } from './mermaid'
import { cleanMermaidSvg } from './mermaid-svg'
import { parseDocument } from './markdown'
import { createDocxModel } from './docx-model'
import { renderMermaid } from '../platform/mermaid'
import { createExport } from './export'

const flow = 'flowchart TD\n A[开始] --> B{完成?}\n B -->|是| C[结束]'
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><defs><marker id="arrow"><path d="M0 0L5 5"/></marker></defs><style>.line{stroke:#123;marker-end:url(#arrow)}</style><path class="line" d="M10 10L20 20"/><text x="10" y="20">中文</text></svg>'
describe('Mermaid input and immutable source contract', () => {
  it('permits ordinary arrows and comments for flowcharts and sequences only', () => {
    for (const text of [flow, '%% comment\ngraph LR\n a-->b', 'sequenceDiagram\n Alice->>Bob: Hello\n Bob-->>Alice: Hi']) expect(mermaidIssue(text)).toBeNull()
    expect(mermaidIssue('pie\n "A": 4')).toContain('仅支持')
  })
  it('rejects configuration, interaction, resource and style escapes before loading', () => {
    for (const suffix of ['%%{init: {}}%%', 'click A "https://evil.test"', 'A[<img src=x>]', 'A@{img: "x"}', 'classDef x fill:red', 'linkStyle 0 stroke:red', '---\nconfig: x', 'A[![x](relative.png)]', 'A[\\u003cscript]']) expect(mermaidIssue(flow + '\n' + suffix)).not.toBeNull()
    expect(mermaidIssue('flowchart TD\n' + 'a'.repeat(MERMAID_LIMITS.source))).toContain('过大')
    expect(mermaidIssue('flowchart TD\n' + 'a-->b\n'.repeat(121))).toContain('过大')
  })
  it('keeps exact fences and positions including nested diagrams, without Worker DOM requirements', async () => {
    const text = '# 图\n\n```mermaid\n' + flow + '\n```\n\n```js\nalert(1)\n```'
    const parsed = parseDocument(text)
    expect(parsed.diagrams).toEqual([{ from: 5, to: text.indexOf('\n\n```js'), source: flow, raw: text.slice(5, text.indexOf('\n\n```js')) }])
    expect(parsed.html).not.toContain('<svg')
    const disabled = await renderMermaid(parsed, false)
    expect(disabled.html).toContain('Mermaid 渲染已关闭')
    expect(disabled.blocks?.find(block => block.type === 'mermaid')?.html).toContain('图表源码')
    expect(parsed.html).toContain('language-mermaid')
    const model = createDocxModel(text, 'test.md')
    expect(model.warnings.items.filter(item => item.code === 'mermaid_source')).toHaveLength(1)
    expect(model.blocks.find(block => block.type === 'raw')).toMatchObject({ text: parsed.diagrams![0].raw })
  })
})
describe('SVG capability boundary', () => {
  it('preserves geometry, Unicode and local marker references', () => {
    const clean = cleanMermaidSvg(svg)
    expect(clean).toContain('url(#arrow)')
    expect(clean).toContain('中文')
    expect(clean).toContain('width="200"')
  })
  it('removes scripts, HTML, event handlers, external URLs and dangerous CSS', () => {
    const clean = cleanMermaidSvg(svg.replace('</svg>', '<script>alert(1)</script><foreignObject><div>unsafe</div></foreignObject><image href="https://evil.test"/><a href="javascript:x"><text>x</text></a><rect onclick="x" style="fill:url(https://evil.test)"/><style>@import "https://evil.test";</style><g style="fill:u\\72l(x)"/></svg>'))
    expect(clean).not.toMatch(/script|foreignObject|https:|javascript:|onclick|\\72|<image|<a /)
    expect(() => cleanMermaidSvg('<!DOCTYPE svg>' + svg)).toThrow()
    expect(() => cleanMermaidSvg(svg.replace('200 100', '9000 100'))).toThrow('尺寸')
    expect(() => cleanMermaidSvg('x'.repeat(MERMAID_LIMITS.svg + 1))).toThrow('超限')
  })
  it('cleans generated export images again without trusting source Markdown data URLs', async () => {
    const encoded = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
    const parsed = parseDocument('![x](data:image/svg+xml,evil)')
    parsed.html += `<figure class="markdown-mermaid"><img data-mermaid-image="true" src="${encoded}"></figure>`
    const output = await createExport(parsed, '图.md', async () => { throw Error('no asset') })
    expect(output.warnings).toHaveLength(1)
    expect(output.body).toContain('data:image/svg+xml;charset=utf-8,')
    expect(output.body).not.toContain('data-mermaid-image')
  })
})
