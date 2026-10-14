import { EditorState } from '@codemirror/state'
import { expect, it } from 'vitest'
import { largeLines, MAX_HIGHLIGHT_LINE } from './large-lines'

it('tracks long lines across joins, splits, undo-like replacements and multiple edits', () => {
  const long = 'x'.repeat(MAX_HIGHLIGHT_LINE + 1)
  let state = EditorState.create({ doc: long + '\n' + long, extensions: [largeLines] })
  expect(state.field(largeLines)).toBe(2)
  state = state.update({ changes: { from: long.length, to: long.length + 1 } }).state
  expect(state.field(largeLines)).toBe(1)
  state = state.update({ changes: { from: long.length, insert: '\n' } }).state
  expect(state.field(largeLines)).toBe(2)
  state = state.update({ changes: [{ from: 0, to: 1 }, { from: 3, to: 4 }, { from: long.length + 1, to: long.length + 2 }] }).state
  expect(state.field(largeLines)).toBe(0)
  state = state.update({ changes: { from: 0, to: state.doc.length, insert: long } }).state
  expect(state.field(largeLines)).toBe(1)
  expect(state.update({ selection: { anchor: 2 } }).state.field(largeLines)).toBe(1)
})

it('keeps the exact threshold and ordinary multiline documents highlighted', () => {
  const state = EditorState.create({ doc: ('x'.repeat(MAX_HIGHLIGHT_LINE) + '\n').repeat(4), extensions: [largeLines] })
  expect(state.field(largeLines)).toBe(0)
  expect(state.update({ changes: { from: 0, insert: 'x' } }).state.field(largeLines)).toBe(1)
})
