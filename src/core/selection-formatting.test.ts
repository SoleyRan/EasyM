import { Text } from '@codemirror/state'
import { markdownLanguage } from '@codemirror/lang-markdown'
import { describe, expect, it } from 'vitest'
import { applyPatches } from './document'
import { toggleFormat, formatState, inlineFormatStatus } from './formatting'
const tree = (text: string) => markdownLanguage.parser.parse(text)
const toggle = (text: string, anchor: number, head: number, kind: 'strike' | 'inlineCode') => {
  const result = toggleFormat(1, Text.of(text.split('\n')), { anchor, head }, tree(text), kind)
  return { text: applyPatches(text, result.patches), selection: result.selection! }
}
describe('selection strike/code formats', () => {
  it('toggles both formats atomically, preserves reverse selection and does not stack', () => {
    for (const kind of ['strike', 'inlineCode'] as const) {
      const first = toggle('中文😀 test', 9, 0, kind)
      expect(formatState(Text.of([first.text]), first.selection, tree(first.text))[kind]).toBe(true)
      const second = toggle(first.text, first.selection.anchor, first.selection.head, kind)
      expect(second.text).toBe('中文😀 test')
      expect(second.selection.anchor).toBeGreaterThan(second.selection.head)
    }
  })
  it('normalizes mixed strike ranges and retains nested inline formatting', () => {
    const text = '~~one~~ plain ~~two~~', first = toggle(text, 0, text.length, 'strike')
    expect(first.text).toBe('~~one plain two~~')
    expect(toggle(first.text, first.selection.anchor, first.selection.head, 'strike').text).toBe('one plain two')
    expect(toggle('~~**hello**~~', 4, 9, 'strike').text).toBe('**hello**')
  })
  it('uses enough code delimiters and removes padding with the delimiters', () => {
    const first = toggle('`a``b', 0, 5, 'inlineCode')
    expect(first.text).toBe('``` `a``b ```')
    expect(toggle(first.text, first.selection.anchor, first.selection.head, 'inlineCode').text).toBe('`a``b')
  })
  it('disables multiline, structural syntax, inline code partials, code, table and frontmatter', () => {
    for (const [text, anchor, head] of [['a\nb', 0, 3], ['```js\na\n```', 6, 7], ['---\na: b\n---', 5, 6], ['| a |\n| --- |\n| b |', 2, 3], ['# heading', 0, 9], ['`hello`', 2, 4]] as const) {
      expect(inlineFormatStatus(Text.of(text.split('\n')), { anchor, head }, tree(text), 'bold').enabled, text).toBe(false)
    }
    for (const text of ['# heading', '- list', '> quote', '- [ ] task']) expect(inlineFormatStatus(Text.of([text]), { anchor: 0, head: text.length }, tree(text), 'link').enabled, text).toBe(false)
  })
})
