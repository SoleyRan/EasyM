import { describe, expect, it } from 'vitest'
import { linkAt, linkCommand, unlinkCommand, safeLink, headingAnchorOffset } from './links'
import { applyPatches } from './document'
import { relativeDocumentTarget } from '../platform/links'

describe('safe source-local link tools', () => {
  it('edits only current reference, retains nested label/title and shared definitions', () => {
    const text = 'before [**中文** and `code`][id] after\n\n[other][id]\n\n[id]: https://example.com "title"'
    const selection = { anchor: 15, head: 10 }, current = linkAt(text, selection)!
    expect(current.label).toBe('**中文** and `code`')
    expect(current.reference).toBe(true)
    const result = linkCommand(4, text, selection, current.label, 'docs/a%20b.md')
    expect(applyPatches(text, result.patches)).toBe(text.replace('[**中文** and `code`][id]', '[**中文** and `code`](<docs/a%20b.md> "title")'))
    expect(result.selection!.anchor).toBeGreaterThan(result.selection!.head)
    expect(applyPatches(text, unlinkCommand(4, text, selection).patches)).toBe(text.replace('[**中文** and `code`][id]', '**中文** and `code`'))
  })
  it('uses first definition and handles escaped labels and autolinks', () => {
    const text = '[a\\]b][id]\n\n[id]: https://first.example\n[id]: https://second.example'
    expect(linkAt(text, { anchor: 2, head: 2 })).toMatchObject({ label: 'a\\]b', url: 'https://first.example' })
    expect(linkAt('<https://example.com>', { anchor: 5, head: 5 })?.label).toBe('https://example.com')
  })
  it('inserts no placeholder and rejects malformed labels/addresses', () => {
    expect(applyPatches('中文', linkCommand(0, '中文', { anchor: 0, head: 2 }, '中文', '#标题').patches)).toBe('[中文](<#标题>)')
    for (const label of ['', 'bad\nline', '[nested](https://example.com)', '<b>HTML</b>', '![image](a.png)', '**![image](a.png)**', '*<b>HTML</b>*']) expect(() => linkCommand(0, '', { anchor: 0, head: 0 }, label, 'https://example.com')).toThrow()
  })
  it('allows only safe URL schemes, anchors and relative paths', () => {
    for (const url of ['https://example.com', 'http://localhost', 'mailto:a@example.com', '#中文', '../docs/a%20b.md']) expect(safeLink(url)).toBe(url)
    for (const url of ['javascript:alert(1)', 'data:text/html,x', '//evil.com', '%2f%2fevil.com', 'file:///tmp/a', '/root.md', 'C:/a.md', 'https://user:pass@example.com', 'https://example.com/%0a', 'a\\b.md', 'bad%xx', '']) expect(safeLink(url)).toBeNull()
  })
  it('resolves relative documents within the authorized root only and maps duplicate heading anchors', () => {
    expect(relativeDocumentTarget('docs/current.md', '../中文%20file.md')).toBe('中文 file.md')
    expect(relativeDocumentTarget('docs/current.md', 'next.md#heading')).toBe('docs/next.md')
    for (const url of ['../../outside.md', '%2e%2e/%2e%2e/outside.md', 'https://example.com/x.md', 'x.png', 'C%3a/a.md']) expect(relativeDocumentTarget('docs/current.md', url)).toBeNull()
    expect(relativeDocumentTarget(null, 'next.md')).toBeNull()
    expect(headingAnchorOffset('# **Hello 中文**\n\n# Hello 中文', '#hello-中文-1')).toBe(16)
  })
})
