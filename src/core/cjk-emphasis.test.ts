import { expect, it } from 'vitest'
import { markdownLanguage } from '@codemirror/lang-markdown'
import { parser as lezerMarkdown } from '@lezer/markdown'
import { cjkEmphasis } from './cjk-emphasis'
import { parseDocument } from './markdown'

const editor = markdownLanguage.parser.configure(cjkEmphasis)
const strongInPreview = (text: string) => (parseDocument(text).html.match(/<strong[\s>]/g) ?? []).length
const strongInEditor = (text: string) => { let count = 0; editor.parse(text).iterate({ enter: node => { if (node.name === 'StrongEmphasis') count++ } }); return count }
const emInEditor = (text: string) => { let count = 0; editor.parse(text).iterate({ enter: node => { if (node.name === 'Emphasis') count++ } }); return count }

const bold = ['**xxx**', '**xxx:**', '**xxx:** 后文', '**xxx:**后文', '**注意:**后文', '**注意：**后文', '前文**注意:**后文', '**(备注)**后文', '前文**xxx**后文', '**中文**后文', '说明：**重点。**继续', '**粗**体']
const plain = ['a**xxx:**b', '**Note:**text', '2*3*4', 'snake_case_name', '** 不是 **', 'a ** b']

it('closes bold after punctuation when CJK text follows, in preview and editor alike', () => {
  for (const text of bold) {
    expect(strongInPreview(text), `preview ${text}`).toBe(1)
    expect(strongInEditor(text), `editor ${text}`).toBe(1)
  }
})

it('keeps standard CommonMark behaviour without CJK neighbours', () => {
  for (const text of plain) {
    expect(strongInPreview(text), `preview ${text}`).toBe(0)
    expect(strongInEditor(text), `editor ${text}`).toBe(0)
  }
})

it('applies the same rule to single-marker emphasis and keeps underscores intraword-safe', () => {
  expect(emInEditor('*注意:*后文')).toBe(1)
  expect(parseDocument('*注意:*后文').html).toMatch(/<em[\s>]/)
  expect(emInEditor('中文_强调_中文')).toBe(parseDocument('中文_强调_中文').html.includes('<em') ? 1 : 0)
  expect(emInEditor('foo_bar_baz')).toBe(0)
})

it('still relies on the built-in lezer Emphasis parser it wraps', () => {
  // Guard for the pinned @lezer/markdown internals used by cjkEmphasis.
  const internal = lezerMarkdown as unknown as { inlineNames: string[]; inlineParsers: unknown[] }
  expect(internal.inlineNames).toContain('Emphasis')
  expect(typeof internal.inlineParsers[internal.inlineNames.indexOf('Emphasis')]).toBe('function')
  // Without the extension the editor parser shows the CommonMark limitation this module fixes.
  let count = 0; markdownLanguage.parser.parse('**注意:**后文').iterate({ enter: node => { if (node.name === 'StrongEmphasis') count++ } })
  expect(count).toBe(0)
})
