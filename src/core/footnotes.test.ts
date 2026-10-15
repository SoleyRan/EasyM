import { expect, it } from 'vitest'
import { indexFootnotes } from './footnotes'
import { parseMarkdownAst } from './markdown-ast'

it('numbers by references, retains unused/duplicate definitions and terminates cycles', () => {
  const text = 'B[^B] A[^a] B again[^b]\n\n[^a]: first A[^b]\n\n[^b]: B[^a] C[^c]\n\n[^c]: C[^c]\n\n[^a]: duplicate A\n\n[^unused]: unused'
  const tree = parseMarkdownAst(text), before = structuredClone(tree), notes = indexFootnotes(tree)
  expect(notes.order.map(note => note.identifier)).toEqual(['b', 'a', 'c'])
  expect(notes.number('B')).toBe(1)
  expect(notes.number('a')).toBe(2)
  expect(notes.number('missing')).toBeUndefined()
  expect(notes.retained.map(note => text.slice(note.position!.start.offset, note.position!.end.offset))).toEqual(['[^a]: duplicate A', '[^unused]: unused'])
  expect(tree).toEqual(before)
})

it('does not activate notes referenced only by an unused definition', () => {
  const notes = indexFootnotes(parseMarkdownAst('plain[^missing]\n\n[^a]: A[^b]\n\n[^b]: B'))
  expect(notes.order).toEqual([])
  expect(notes.retained).toHaveLength(2)
})
