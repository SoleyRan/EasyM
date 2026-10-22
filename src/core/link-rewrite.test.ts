import { describe, expect, it } from 'vitest'
import { relativeTo, resolveRelative, rewriteIncoming, rewriteOutgoing } from './link-rewrite'

describe('relative path helpers', () => {
  it('resolves and builds relative paths inside the workspace', () => {
    expect(resolveRelative('a/b/doc.md', '../c/x.md')).toBe('a/c/x.md')
    expect(resolveRelative('doc.md', '../x.md')).toBeNull()
    expect(resolveRelative('a/doc.md', '%E4%B8%AD%E6%96%87.md')).toBe('a/中文.md')
    expect(relativeTo('a/b/doc.md', 'a/c/x.md')).toBe('../c/x.md')
    expect(relativeTo('doc.md', 'notes/a b.md')).toBe('notes/a%20b.md')
    expect(relativeTo('x/doc.md', 'x/(1).md')).toBe('%281%29.md')
  })
})

describe('outgoing links of a moved document', () => {
  it('rewrites relative document and image links but keeps every other byte', () => {
    const text = '﻿# 标题\r\n[同级](other.md#节) ![图](img/a.png "t")\r\n[外链](https://x.test/a.md) [锚](#top) [邮件](mailto:a@b.c)\r\n'
    const result = rewriteOutgoing(text, 'notes/doc.md', 'archive/2026/doc.md')
    expect(result.text).toBe('﻿# 标题\r\n[同级](../../notes/other.md#节) ![图](../../notes/img/a.png "t")\r\n[外链](https://x.test/a.md) [锚](#top) [邮件](mailto:a@b.c)\r\n')
    expect(result.changed).toBe(2)
  })

  it('handles angle-bracket, reference definitions and paths with spaces', () => {
    const text = '[a](<my notes/x.md>)\n[ref][r]\n\n[r]: ../shared/y.md "title"\n'
    const result = rewriteOutgoing(text, 'dir/doc.md', 'doc.md')
    expect(result.text).toBe('[a](<dir/my%20notes/x.md>)\n[ref][r]\n\n[r]: shared/y.md "title"\n')
  })

  it('leaves code, unchanged targets and escaping links alone', () => {
    const text = '`[x](a.md)`\n\n    [y](a.md)\n\n[z](../../outside.md)\n'
    const result = rewriteOutgoing(text, 'a/doc.md', 'b/doc.md')
    expect(result.text).toBe(text)
    expect(result.skipped).toBe(1)
    expect(rewriteOutgoing('[s](a.md)', 'x/doc.md', 'x/renamed.md').changed).toBe(0)
  })

  it('redirects targets that moved with the document', () => {
    const moved = new Map([['old/assets/img-1.png', 'new/assets/img-1.png']])
    expect(rewriteOutgoing('![](assets/img-1.png)', 'old/doc.md', 'new/doc.md', moved).text).toBe('![](assets/img-1.png)')
  })
})

describe('incoming links from other documents', () => {
  it('updates only links that resolved to the moved document', () => {
    const text = '[a](doc.md) [b](./doc.md#h) [c](other.md) [d](sub/doc.md)\n'
    const result = rewriteIncoming(text, 'notes/index.md', 'notes/doc.md', 'archive/doc.md')
    expect(result.text).toBe('[a](../archive/doc.md) [b](../archive/doc.md#h) [c](other.md) [d](sub/doc.md)\n')
    expect(result.changed).toBe(2)
  })

  it('handles a pure rename in the same directory and percent-encoded names', () => {
    const text = '[x](%E6%97%A7.md)'
    expect(rewriteIncoming(text, 'a.md', '旧.md', '新 名.md').text).toBe('[x](%E6%96%B0%20%E5%90%8D.md)')
  })
})
