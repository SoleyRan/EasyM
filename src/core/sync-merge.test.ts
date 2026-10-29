import { describe, expect, it } from 'vitest'
import { MAX_SYNC_MERGE_BYTES, mergeSyncMetadata, mergeSyncResources, mergeSyncText } from './sync-merge'

const enc = (text: string) => new TextEncoder().encode(text)
const merge = (base: string, left: string, right: string) => {
  const result = mergeSyncText(enc(base), enc(left), enc(right))
  return result && new TextDecoder().decode(result)
}

describe('deterministic sync text merge', () => {
  it('combines edits of different lines in either order', () => {
    const base = '# 标题\n\n第一段\n\n第二段\n'
    const left = '# 新标题\n\n第一段\n\n第二段\n', right = '# 标题\n\n第一段\n\n第二段 😀\n'
    expect(merge(base, left, right)).toBe('# 新标题\n\n第一段\n\n第二段 😀\n')
    expect(merge(base, right, left)).toBe('# 新标题\n\n第一段\n\n第二段 😀\n')
  })
  it('returns null for overlapping edits so a conflict copy is kept', () => {
    expect(merge('a\nb\nc', 'a\nL\nc', 'a\nR\nc')).toBeNull()
    expect(merge('', 'left', 'right')).toBeNull()
  })
  it('keeps CRLF bodies CRLF and refuses mixed or bare CR line endings', () => {
    expect(merge('a\r\nb\r\nc\r\n', 'A\r\nb\r\nc\r\n', 'a\r\nb\r\nC\r\n')).toBe('A\r\nb\r\nC\r\n')
    expect(merge('a\nb\nc\n', 'A\r\nb\r\nc\r\n', 'a\nb\nC\n')).toBeNull()
    expect(merge('a\nb\n', 'A\rb\n', 'a\nB\n')).toBeNull()
  })
  it('refuses invalid UTF-8, a BOM, NUL bytes and bodies over the limit', () => {
    const bad = new Uint8Array([0xff, 0xfe, 0x41])
    expect(mergeSyncText(enc('a\nb'), bad, enc('a\nB'))).toBeNull()
    expect(merge('a\nb', '﻿A\nb', 'a\nB')).toBeNull()
    expect(merge('a\nb', 'A\0\nb', 'a\nB')).toBeNull()
    const big = 'x\n'.repeat(MAX_SYNC_MERGE_BYTES / 2 + 1)
    expect(merge(big, 'y\n' + big, big + 'z\n')).toBeNull()
  })
  it('does not depend on wall-clock time', () => {
    const base = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n')
    const left = base.replace('line 10\n', 'line ten\n'), right = base.replace('line 2990\n', 'line 2990!\n')
    const now = Date.now
    try {
      Date.now = () => Number.MAX_SAFE_INTEGER - 1
      expect(merge(base, left, right)).toBe(left.replace('line 2990\n', 'line 2990!\n'))
    } finally { Date.now = now }
  })
})

describe('sync resource and metadata merge', () => {
  const ref = (path: string, object: string) => ({ path, object, bytes: 1 })
  it('takes the changed side per image path and drops images the merged body no longer needs', () => {
    const base = [ref('a.png', 'o1'), ref('b.png', 'o2')]
    const left = [ref('a.png', 'L1'), ref('b.png', 'o2')]
    const right = [ref('a.png', 'o1'), ref('b.png', 'o2'), ref('c.png', 'R3')]
    expect(mergeSyncResources(base, left, right, new Set(['a.png', 'c.png']))).toEqual([ref('a.png', 'L1'), ref('c.png', 'R3')])
  })
  it('reports a conflict when both sides changed one image differently', () => {
    expect(mergeSyncResources([ref('a.png', 'o')], [ref('a.png', 'L')], [ref('a.png', 'R')], new Set(['a.png']))).toBeNull()
    expect(mergeSyncResources([], [ref('a.png', 'L')], [ref('a.png', 'R')], new Set(['a.png']))).toBeNull()
  })
  it('merges image instances per display path and rejects unreadable metadata', () => {
    const meta = (...instances: object[]) => enc(JSON.stringify({ schemaVersion: 1, instances }))
    const crop = (path: string, recipe: number) => ({ displayPath: path, sourcePath: `src-${path}`, recipe })
    const base = meta(crop('a.png', 0), crop('b.png', 0))
    expect(mergeSyncMetadata(base, meta(crop('a.png', 1), crop('b.png', 0)), meta(crop('a.png', 0), crop('b.png', 2)), new Set(['a.png', 'b.png']))).toEqual([crop('a.png', 1), crop('b.png', 2)])
    expect(mergeSyncMetadata(base, meta(crop('a.png', 1)), meta(crop('a.png', 2)), new Set(['a.png']))).toBeNull()
    expect(mergeSyncMetadata(enc('not json'), null, null, new Set())).toBeNull()
    expect(mergeSyncMetadata(null, null, null, new Set())).toEqual([])
  })
})
