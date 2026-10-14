import { describe, expect, it } from 'vitest'
import { applyPatches } from './document'
import { filterCommands, filterTabs, insertStructure, slashTrigger } from './quick-entry'
import { commandDefinitions } from './commands'

const caret = (head: number) => ({ anchor: head, head })
describe('quick entry contracts', () => {
  it('recognises ordinary blank-line triggers, Unicode keywords and BOM/CRLF positions', () => {
    for (const text of ['/h1', '  /任务', '\uFEFF/quote', '# 标题\r\n\r\n/无序列表']) {
      const target = slashTrigger(text, caret(text.length))!
      expect(target).not.toBeNull(); expect(text.slice(target.from, target.to)).toBe('/' + target.query)
    }
    expect(slashTrigger('/h1', { anchor: 0, head: 3 })).toBeNull()
  })
  it('never triggers inside prose, URLs, paths, code, tables, front matter or nested blocks', () => {
    for (const text of ['some /h1', 'https://a', '/notes/a.md', '/C:\\path', '    /h1', '```\n/h1', '> /h1', '- /h1', '---\n/h1\n---', '| a | b |\n| --- | --- |\n| /h1 | b |']) {
      const pos = text.indexOf('/h1') >= 0 ? text.indexOf('/h1') + 3 : text.length
      expect(slashTrigger(text, caret(pos)), text).toBeNull()
    }
    expect(slashTrigger('/h1 trailing', caret(3))).toBeNull()
  })
  it('replaces only the captured trigger and preserves all other bytes; one transaction has a useful caret', () => {
    const text = '\uFEFF# 标题\r\n\r\n/h2\r\n\r\nend', pos = text.indexOf('/h2') + 3
    const trigger = slashTrigger(text, caret(pos))!
    const result = insertStructure(7, text, caret(pos), 'h2', trigger)
    expect(result.baseTextRevision).toBe(7); expect(result.patches).toHaveLength(1)
    expect(applyPatches(text, result.patches)).toBe(text.replace('/h2', '## '))
    expect(() => insertStructure(7, text.replace('/h2', '/h3'), caret(pos), 'h2', trigger)).toThrow()
    const code = insertStructure(0, '/code', caret(5), 'code', slashTrigger('/code', caret(5))!)
    expect(applyPatches('/code', code.patches)).toBe('```\n\n```'); expect(code.selection).toEqual(caret(4))
  })
  it('filters commands and opened tabs by Chinese, English, group and relative path', () => {
    expect(filterCommands(commandDefinitions, 'h6').some(command => command.id === 'insert.h6')).toBe(true)
    expect(filterCommands(commandDefinitions, 'table').map(command => command.id)).toContain('insert.table')
    expect(filterCommands(commandDefinitions, '加粗').map(command => command.id)).toEqual(['format.bold'])
    expect(filterCommands(commandDefinitions, 'no matches')).toEqual([])
    const tabs = [{ id: 'a', name: '同名.md', path: '中文 notes/同名.md' }, { id: 'b', name: '同名.md', path: 'other/同名.md' }]
    expect(filterTabs(tabs, '中文 NOTES').map(tab => tab.id)).toEqual(['a']); expect(filterTabs(tabs, '同名')).toHaveLength(2)
  })
})
