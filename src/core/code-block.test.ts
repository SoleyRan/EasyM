import { expect, it } from 'vitest'
import { codeBlockCommand } from './code-block'
import { applyPatches } from './document'

it('inserts a language fence with a body selection and fences longer than the content', () => {
  const text = 'before\n```example```\nafter'
  const result = codeBlockCommand(1, text, { anchor: 7, head: 20 }, 'python', null)
  expect(applyPatches(text, result.patches)).toBe('before\n````python\n```example```\n````\nafter')
  expect(result.selection).toEqual({ anchor: 18, head: 31 })
})

it('changes only the language token and preserves body, metadata, fence and selection', () => {
  const text = '~~~js title="demo"\nconst x = 1\n~~~'
  const result = codeBlockCommand(2, text, { anchor: 22, head: 22 }, 'typescript', { from: 0, to: text.length, language: 'js' })
  expect(applyPatches(text, result.patches)).toBe('~~~typescript title="demo"\nconst x = 1\n~~~')
  expect(result.selection).toEqual({ anchor: 30, head: 30 })
})

it('removes language without changing code and rejects invalid language markers', () => {
  const text = '```python\nprint(1)\n```'
  expect(applyPatches(text, codeBlockCommand(0, text, { anchor: 12, head: 12 }, '', { from: 0, to: text.length, language: 'python' }).patches)).toBe('```\nprint(1)\n```')
  expect(() => codeBlockCommand(0, '', { anchor: 0, head: 0 }, 'js\n```', null)).toThrow()
})

it('clears the info string when removing language so metadata is not promoted to language', () => {
  const text = '~~~js title="demo"\nconst x = 1\n~~~'
  const result = codeBlockCommand(0, text, { anchor: 22, head: 22 }, '', { from: 0, to: text.length, language: 'js' })
  expect(applyPatches(text, result.patches)).toBe('~~~\nconst x = 1\n~~~')
  expect(result.selection).toEqual({ anchor: 7, head: 7 })
})
