import { expect, it } from 'vitest'
import { historyDiff } from './history-diff'

it('compares insertions, deletions and replacements with source line numbers', () => {
  const diff = historyDiff('a\nb\nc', 'a\nB\nc\nd')
  expect(diff.additions).toBe(2); expect(diff.deletions).toBe(1)
  expect(diff.lines.filter(l => l.kind !== 'add').map(l => l.text)).toEqual(['a', 'b', 'c'])
  expect(diff.lines.filter(l => l.kind !== 'delete').map(l => l.text)).toEqual(['a', 'B', 'c', 'd'])
  expect(diff.lines.find(l => l.text === 'B')).toMatchObject({ kind: 'add', after: 2 })
})
it('ignores CRLF display differences and handles empty, identical and unrelated documents', () => {
  expect(historyDiff('中文\r\n正文', '中文\n正文').additions).toBe(0)
  for (const [before, after] of [['', ''], ['', 'added'], ['removed', ''], ['one\ntwo', 'other\nvalue'], ['a\na\nb', 'a\nb\nb']]) {
    const diff = historyDiff(before, after)
    expect(diff.fallback).toBeUndefined()
    expect(diff.lines.filter(l => l.kind !== 'add').map(l => l.text).join('\n')).toBe(before)
    expect(diff.lines.filter(l => l.kind !== 'delete').map(l => l.text).join('\n')).toBe(after)
  }
})
it('bounds bytes, lines, trace memory and deadline', () => {
  expect(historyDiff('x'.repeat(5 * 1024 * 1024 + 1), '').fallback).toContain('5 MiB')
  expect(historyDiff('\n'.repeat(100000), '').fallback).toContain('100,000')
  expect(historyDiff('a', 'b', Date.now() - 1).fallback).toContain('限制')
  expect(historyDiff(Array.from({ length: 2500 }, (_, i) => `a${i}`).join('\n'), Array.from({ length: 2500 }, (_, i) => `b${i}`).join('\n')).fallback).toContain('限制')
})
it('preserves both inputs across repeat-heavy edits', () => {
  let seed = 42
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % 4 }
  for (let i = 0; i < 200; i++) {
    const a = Array.from({ length: 12 }, () => String(random())).join('\n'), b = Array.from({ length: 15 }, () => String(random())).join('\n')
    const diff = historyDiff(a, b)
    expect(diff.lines.filter(l => l.kind !== 'add').map(l => l.text).join('\n')).toBe(a)
    expect(diff.lines.filter(l => l.kind !== 'delete').map(l => l.text).join('\n')).toBe(b)
  }
})
