import { describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { contentStatus } from './content-status'

const state = (doc: string, anchor = 0) => EditorState.create({ doc, selection: { anchor }, extensions: [markdown({ base: markdownLanguage })] })
describe('incremental content tool availability', () => {
  it('distinguishes a top-level table from plain text and a nested table', () => {
    expect(contentStatus(state('| a |\n| --- |\n| b |', 2), 'table').enabled).toBe(true)
    expect(contentStatus(state('a | b', 2), 'table').enabled).toBe(false)
    expect(contentStatus(state('> | a |\n> | --- |\n> | b |', 4), 'table').enabled).toBe(false)
  })
  it('offers paragraphs and rejects structural code/table selections', () => {
    expect(contentStatus(state('hello **world**', 3), 'paragraph').enabled).toBe(true)
    expect(contentStatus(state('```js\ncode\n```', 7), 'paragraph').enabled).toBe(false)
    expect(contentStatus(state('| a |\n| --- |\n| b |', 2), 'paragraph').enabled).toBe(false)
  })
  it('checks large documents and long-line limits without serializing the document', () => {
    for (const doc of ['ordinary paragraph\n\n'.repeat(270000), 'x'.repeat(102400)]) {
      const value = EditorState.create({ doc }), serialize = vi.spyOn(value.doc, 'toString')
      expect(contentStatus(value, 'table').enabled).toBe(false)
      expect(contentStatus(value, 'paragraph').enabled).toBe(false)
      expect(serialize).not.toHaveBeenCalled()
      serialize.mockRestore()
    }
  })
})
