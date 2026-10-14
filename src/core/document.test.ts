import { describe, expect, it } from 'vitest'
import { applyPatches, detectLineEnding, prefixLines, wrapSelection } from './document'
import { parseDocument } from './markdown'

describe('document core', () => {
  it('applies non-overlapping patches from the end of the document', () => {
    expect(applyPatches('abcdef', [{ from: 1, to: 2, insert: 'B' }, { from: 4, to: 6, insert: 'EF!' }])).toBe('aBcdEF!')
  })

  it('rejects overlapping patches', () => {
    expect(() => applyPatches('abcdef', [{ from: 1, to: 4, insert: 'x' }, { from: 3, to: 5, insert: 'y' }])).toThrow()
  })

  it('preserves line ending detection', () => {
    expect(detectLineEnding('a\nb')).toBe('lf')
    expect(detectLineEnding('a\r\nb')).toBe('crlf')
    expect(detectLineEnding('a\r\nb\nc')).toBe('mixed')
  })

  it('creates targeted markdown commands', () => {
    const bold = wrapSelection(2, 'hello world', { anchor: 6, head: 11 }, '**')
    expect(applyPatches('hello world', bold.patches)).toBe('hello **world**')
    const quote = prefixLines(3, 'one\ntwo', { anchor: 0, head: 7 }, '> ')
    expect(applyPatches('one\ntwo', quote.patches)).toBe('> one\n> two')
  })

  it('extracts headings with source offsets', () => {
    expect(parseDocument('# One\n\n### Three').headings).toEqual([
      { level: 1, title: 'One', offset: 0 },
      { level: 3, title: 'Three', offset: 7 },
    ])
  })

  it('does not treat fenced code as outline headings', () => {
    const text = '```md\n# not a heading\n```\n\nReal\n===='
    expect(parseDocument(text).headings).toEqual([{ level: 1, title: 'Real', offset: text.indexOf('Real') }])
  })

  it('prefixes only the selected line after an empty first line', () => {
    expect(applyPatches('\nnext', prefixLines(0, '\nnext', { anchor: 0, head: 0 }, '> ').patches)).toBe('> \nnext')
  })
})
