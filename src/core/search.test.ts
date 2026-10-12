import { EditorState, Transaction, type TransactionSpec } from '@codemirror/state'
import { history, undo, redo, isolateHistory } from '@codemirror/commands'
import { getSearchQuery, replaceAll, search, SearchQuery, setSearchQuery } from '@codemirror/search'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { countSearchMatches, currentSearchMatch, MAX_SEARCH_MATCHES } from './search'

const options = (query: string, caseSensitive = false, wholeWord = false) => ({ search: query, caseSensitive, wholeWord })
describe('document search contracts', () => {
  it('matches Chinese substrings, emoji, cross-line text and preserves UTF-16 source positions', () => {
    expect(countSearchMatches('中文🙂中文\n中文', options('中文')).matches).toEqual([{ from: 0, to: 2 }, { from: 4, to: 6 }, { from: 7, to: 9 }])
    expect(countSearchMatches('中文🙂中文', options('🙂')).matches).toEqual([{ from: 2, to: 4 }])
    expect(countSearchMatches('中文\nnext', options('文\nn')).matches).toEqual([{ from: 1, to: 4 }])
  })
  it('shares literal, case and Unicode boundary semantics with the editor', () => {
    expect(countSearchMatches('Word WORD words', options('word')).matches).toHaveLength(3)
    expect(countSearchMatches('Word WORD words', options('word', true)).matches).toHaveLength(1)
    expect(countSearchMatches('Word WORD words', options('word', false, true)).matches).toHaveLength(2)
    expect(countSearchMatches('中文 中文字', options('中文', false, true)).matches).toHaveLength(1)
    expect(countSearchMatches('\\n\n$1 .*', options('\\n')).matches).toEqual([{ from: 0, to: 2 }])
    expect(countSearchMatches('\\n\n$1 .*', options('.*')).matches).toEqual([{ from: 6, to: 8 }])
    expect(countSearchMatches('é e\u0301', options('é')).matches).toHaveLength(2)
  })
  it('counts non-overlapping matches and bounds worker response size', () => {
    expect(countSearchMatches('aaaa', options('aa')).matches).toEqual([{ from: 0, to: 2 }, { from: 2, to: 4 }])
    expect(countSearchMatches('text', options(''))).toEqual({ matches: [], limited: false })
    expect(countSearchMatches('a'.repeat(MAX_SEARCH_MATCHES), options('a')).limited).toBe(false)
    const limited = countSearchMatches('a'.repeat(MAX_SEARCH_MATCHES + 1), options('a'))
    expect(limited.matches).toHaveLength(MAX_SEARCH_MATCHES)
    expect(limited.limited).toBe(true)
  })
  it('reports a current index only for an exact match selection', () => {
    const { matches } = countSearchMatches('word word word', options('word'))
    expect(currentSearchMatch(matches, 5, 9)).toBe(2)
    expect(currentSearchMatch(matches, 5, 5)).toBe(0)
    expect(currentSearchMatch(matches, 0, 3)).toBe(0)
    expect(currentSearchMatch([], 0, 0)).toBe(0)
  })
  it('replaces the command-time document with literal values and isolates undo/redo', () => {
    let state = EditorState.create({ doc: '中文 word\nWORD', extensions: [search({ literal: true }), history()] })
    const dispatch = (transaction: Transaction | TransactionSpec) => { state = transaction instanceof Transaction ? transaction.state : state.update(transaction).state }
    const view = { get state() { return state }, dispatch } as unknown as EditorView
    dispatch({ effects: setSearchQuery.of(new SearchQuery({ ...options('word'), literal: true, replace: '$1\\n' })) })
    expect(state.doc.toString()).toBe('中文 word\nWORD')
    expect(getSearchQuery(state).literal).toBe(true)
    // An earlier unrelated edit must not be swallowed by replacement undo.
    dispatch({ changes: { from: 0, insert: '前' }, userEvent: 'input.type' })
    dispatch({ annotations: isolateHistory.of('full') })
    expect(replaceAll(view)).toBe(true)
    dispatch({ annotations: isolateHistory.of('full') })
    expect(state.doc.toString()).toBe('前中文 $1\\n\n$1\\n')
    expect(undo(view)).toBe(true)
    expect(state.doc.toString()).toBe('前中文 word\nWORD')
    expect(redo(view)).toBe(true)
    expect(state.doc.toString()).toBe('前中文 $1\\n\n$1\\n')
  })
})
