import { EditorState } from '@codemirror/state'
import { markdownLanguage } from '@codemirror/lang-markdown'
import { describe, expect, it } from 'vitest'
import { activeSourceRanges, frontmatterEnd, liveTokens, touches } from './live-preview'
import { parseDocument } from './markdown'

function decorations(text: string, anchor = 0, head = anchor) {
  const state = EditorState.create({ doc: text, selection: { anchor, head } })
  const tree = markdownLanguage.parser.parse(text)
  const active = activeSourceRanges(state, tree)
  const tokens = liveTokens(state, tree, [{ from: 0, to: text.length }], active, frontmatterEnd(state.doc))
  return { state, active, tokens, hidden: tokens.filter(token => token.kind === 'hide').map(token => text.slice(token.from, token.to)) }
}
describe('live presentation and source contracts', () => {
  it('styles inactive Markdown without changing text or selection', () => {
    const text = 'active\n\n# Heading\n\n**bold** *italic* ~~strike~~ `code` [link](https://example.com)'
    const result = decorations(text)
    expect(result.tokens.some(token => token.className === 'live-h1' || token.className === 'live-heading live-h1')).toBe(true)
    expect(result.hidden).toEqual(['# ', '**', '**', '*', '*', '~~', '~~', '`', '`', '[', '](https://example.com)'])
    expect(result.state.doc.toString()).toBe(text)
    expect(result.state.selection.main.anchor).toBe(0)
  })
  it('reveals the entire active paragraph and every intersected block for reverse selections', () => {
    const text = '# Header\n\n**bold** across\nparagraph *text*\n\nlast'
    expect(decorations(text, text.indexOf('across')).hidden).toEqual(['# '])
    const result = decorations(text, text.indexOf('last'), 0)
    expect(result.hidden).toEqual([])
    expect(result.state.selection.main.anchor).toBeGreaterThan(result.state.selection.main.head)
    expect(touches(result.active, 10, 30)).toBe(true)
  })
  it('preserves literal/image/unknown syntax and presents valid reference-link labels', () => {
    const text = 'active\n\n\\*literal\\*\n\n`**literal**`\n\n![alt](assets/a.png)\n\n[ref][id]\n\n[id]: url\n\n<!-- preserve -->\n\n<custom value="**x**">'
    const result = decorations(text)
    expect(result.hidden).toEqual(['`', '`', '[', '][id]'])
    expect(result.state.doc.toString()).toBe(text)
  })
  it('protects front matter and keeps unclosed headers and long headers as source', () => {
    for (const marker of ['---', '+++']) {
      const text = `${marker}\ntitle: **raw**\n${marker}\n\n# Heading`
      const result = decorations(text, text.length)
      expect(frontmatterEnd(result.state.doc)).toBe(text.indexOf('\n\n'))
      expect(result.hidden).toEqual([])
    }
    const state = EditorState.create({ doc: '---\nnot closed\n**raw**' })
    expect(frontmatterEnd(state.doc)).toBe(state.doc.length)
  })
  it('returns no inline replacements inside fences/tables, and keeps viewport work bounded', () => {
    const text = 'active\n\n```markdown\n**raw** [x](url)\n```\n\n| A | B |\n| - | - |\n| **x** | y |\n\n**visible**'
    const state = EditorState.create({ doc: text }), tree = markdownLanguage.parser.parse(text)
    expect(decorations(text).hidden).toEqual(['**', '**'])
    const tokens = liveTokens(state, tree, [{ from: 0, to: 6 }], [], 0)
    expect(tokens).toHaveLength(0)
  })
  it('carries safe full-document ranges and renders repeated image instances separately', () => {
    const text = 'intro\n\n```js\nconst a=1\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n![one](assets/a.png)\n\n![two](assets/a.png)\n\n---'
    const parsed = parseDocument(text)
    expect(parsed.blocks?.map(block => block.type)).toEqual(['code', 'table', 'image', 'image', 'thematicBreak'])
    expect(parsed.blocks?.[0].html).toContain('hljs-keyword')
    expect(parsed.blocks?.filter(block => block.type === 'image').map(block => text.slice(block.from, block.to))).toEqual(['![one](assets/a.png)', '![two](assets/a.png)'])
    expect(parsed.blocks?.every(block => block.html.includes('data-source-from=') && block.from < block.to)).toBe(true)
    const unsafe = parseDocument('![remote](https://remote.example/a.png)\n\n```html\n<script>evil()</script>\n```')
    expect(unsafe.blocks?.map(block => block.html).join('')).not.toContain('src="https:')
    expect(unsafe.blocks?.map(block => block.html).join('')).not.toContain('<script>')
  })
})
