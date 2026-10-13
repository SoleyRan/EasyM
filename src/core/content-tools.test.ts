import { describe, expect, it } from 'vitest'
import { paragraphCommand, paragraphTarget, codeAt } from './content-tools'
import { applyPatches } from './document'
import { codeBlockCommand } from './code-block'

const convert = (text: string, anchor: number, head: number, kind: Parameters<typeof paragraphCommand>[3]) => applyPatches(text, paragraphCommand(3, text, { anchor, head }, kind).patches)
describe('source-local paragraph conversion', () => {
  it('expands the caret to the whole paragraph and preserves inline Markdown and untouched bytes', () => {
    const text = 'before\n\n**中文😀**\nnext line\n\nafter'
    expect(convert(text, 12, 12, 'quote')).toBe('before\n\n> **中文😀**\n> next line\n\nafter')
    expect(convert('### **title** ###\n\nkeep', 8, 8, 'task')).toBe('- [ ] **title**\n\nkeep')
  })
  it('selects whole logical lines, excluding the next line at its start, and retains reverse direction', () => {
    const text = '- one\n- two\n- three'
    const result = paragraphCommand(3, text, { anchor: 12, head: 7 }, 'ordered')
    expect(applyPatches(text, result.patches)).toBe('- one\n1. two\n- three')
    expect(result.selection!.anchor).toBeGreaterThan(result.selection!.head)
    expect(convert('\nhello', 0, 0, 'h2')).toBe('\nhello')
  })
  it('removes setext underlines and preserves BOM/CRLF and following content', () => {
    expect(convert('\uFEFFTitle\r\n=====\r\n\r\nkeep', 2, 2, 'h2')).toBe('\uFEFF## Title\r\n\r\nkeep')
    expect(convert('Title\n---\n\nkeep', 0, 5, 'paragraph')).toBe('Title\n\nkeep')
  })
  it('refuses unsupported structures without making a patch', () => {
    for (const text of ['```js\na\n```', '    code', '| a |\n| --- |\n| b |', '---\na: b\n---', '<div>hi</div>', '- one\n  - nested', '> > nested']) {
      expect(() => paragraphTarget(text, { anchor: 1, head: 1 }), text).toThrow()
    }
  })
  it('changes only code info, keeps unknown tags and bounds the tool parser', () => {
    const text = 'before\n\n~~~~odd/lang meta\nconst x = 1\n~~~~\n\nafter', block = codeAt(text, 12)
    expect(applyPatches(text, codeBlockCommand(0, text, { anchor: 0, head: 0 }, 'python', block).patches)).toBe(text.replace('odd/lang', 'python'))
    expect(codeBlockCommand(0, text, { anchor: 0, head: 0 }, 'odd/lang', block).patches).toEqual([])
    expect(() => paragraphTarget('x'.repeat(1024 * 1024 + 1), { anchor: 0, head: 0 })).toThrow('1 Mi')
  })
})
