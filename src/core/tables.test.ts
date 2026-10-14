import { describe, expect, it } from 'vitest'
import { applyPatches } from './document'
import { changeTable, escapeCell, insertTable, serializeTable, sourceTable, tableCellAt, tableSize } from './tables'
import { parseMarkdownAst } from './markdown-ast'
import { decodeFile, encodeFile } from './codec'

const original = 'before\n\n| 标题😀 | `a\\|b` |\n| :--- | ---: |\n| **中文** | [链接][id] |\n|  | x\\\\ |\n\nafter\n\n[id]: https://example.com'
describe('visual GFM table source contract', () => {
  it('maps UTF-16 offsets, optional outer pipes, code escapes, references and empty cells', () => {
    const table = sourceTable(original, original.indexOf('中文'))
    expect(table.rows.map(row => row.map(cell => cell.value))).toEqual([['标题😀', '`a\\|b`'], ['**中文**', '[链接][id]'], ['', 'x\\\\']])
    for (const row of table.rows) for (const cell of row) expect(original.slice(cell.from, cell.to)).toBe(cell.value)
    expect(table.align).toEqual(['left', 'right'])
    expect(tableCellAt(table, original.indexOf('[链接]'))).toEqual({ row: 1, column: 1 })
    expect(sourceTable('a | b\n--- | ---\nx | y', 16).rows[1].map(cell => cell.value)).toEqual(['x', 'y'])
  })
  it('only edits the selected cell and preserves surrounding bytes, BOM and CRLF', () => {
    const bytes = new TextEncoder().encode('\uFEFF' + original.replaceAll('\n', '\r\n'))
    const snapshot = decodeFile(bytes), table = sourceTable(snapshot.text, snapshot.text.indexOf('中文'))
    const patches = changeTable(table, 1, 0, '**修改😀**')
    expect(patches).toEqual([{ from: table.rows[1][0].from, to: table.rows[1][0].to, insert: '**修改😀**' }])
    const next = applyPatches(snapshot.text, patches)
    expect(next).toBe(snapshot.text.replace('**中文**', '**修改😀**'))
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(encodeFile(snapshot, next))).toBe('\uFEFF' + next.replaceAll('\n', '\r\n'))
    expect(changeTable(table, 1, 0, '**中文**')).toEqual([])
  })
  it('uses actual mixed newline offsets for cell-only patches', () => {
    const text = '| a | b |\r\n| --- | --- |\n| x | y |'
    const table = sourceTable(text, text.indexOf('x'))
    expect(applyPatches(text, changeTable(table, 1, 1, 'z'))).toBe(text.replace('y', 'z'))
  })
  it('escapes unescaped pipes even in code, respecting backslash parity; refuses newlines and oversized drafts', () => {
    expect(escapeCell('a|b `x|y` c\\|d e\\\\|f')).toBe('a\\|b `x\\|y` c\\|d e\\\\\\|f')
    expect(() => escapeCell('a\nb')).toThrow(/换行/)
    expect(() => escapeCell('x'.repeat(10001))).toThrow(/10,000/)
    const table = sourceTable(original, 9)
    const next = applyPatches(original, changeTable(table, 1, 0, '`x|y`'))
    const ast = parseMarkdownAst(next).children.find(node => node.type === 'table')!
    expect(ast.type === 'table' && ast.children[1].children[0].children[0]).toMatchObject({ type: 'inlineCode', value: 'x|y' })
  })
  it('creates blank canonical tables with explicit body rows and preserves surrounding source', () => {
    const patch = insertTable('start\n\nend', 7, 7, 2, 3)
    const next = applyPatches('start\n\nend', [patch]), table = sourceTable(next, patch.firstCell)
    expect(table.rows.length).toBe(3); expect(table.align.length).toBe(3)
    expect(table.rows.flat().every(cell => cell.value === '')).toBe(true)
    expect(next.startsWith('start\n\n')).toBe(true); expect(next.endsWith('\n\nend')).toBe(true)
  })
  it('combines final-cell edit and Tab-added row in one patch, retaining escapes and alignments', () => {
    const table = sourceTable(original, 9)
    const patches = changeTable(table, 2, 1, 'last|cell', undefined, undefined, true)
    expect(patches).toHaveLength(1)
    const next = sourceTable(applyPatches(original, patches), table.from)
    expect(next.rows.map(row => row.map(cell => cell.value))).toEqual([['标题😀', '`a\\|b`'], ['**中文**', '[链接][id]'], ['', 'last\\|cell'], ['', '']])
    expect(next.align).toEqual(table.align)
  })
  it('inserts/deletes rows and columns and changes only the selected column alignment', () => {
    const table = sourceTable(original, 9)
    const apply = (op: Parameters<typeof changeTable>[4], alignment?: Parameters<typeof changeTable>[5]) => sourceTable(applyPatches(original, changeTable(table, 1, 0, '**中文**', op, alignment)), table.from)
    expect(apply('rowAbove').rows[1].map(cell => cell.value)).toEqual(['', ''])
    expect(apply('rowBelow').rows[2].map(cell => cell.value)).toEqual(['', ''])
    expect(apply('deleteRow').rows[1].map(cell => cell.value)).toEqual(['', 'x\\\\'])
    expect(apply('columnRight').align).toEqual(['left', null, 'right'])
    expect(apply('columnLeft').rows[1].map(cell => cell.value)).toEqual(['', '**中文**', '[链接][id]'])
    expect(apply('deleteColumn').rows[1].map(cell => cell.value)).toEqual(['[链接][id]'])
    expect(apply('align', 'center').align).toEqual(['center', 'right'])
  })
  it('rejects nested, nonrectangular, header-only and ambiguous tables without normalizing', () => {
    for (const text of ['> | a | b |\n> | --- | --- |\n> | x | y |', '| a | b |\n| --- | --- |\n| x |', '| a | b |\n| --- | --- |\n| x | y | z |', '| a |\n| --- |', '| `a|b` | c |\n| --- | --- |\n| x | y |']) expect(() => sourceTable(text, 2)).toThrow()
    const single = sourceTable('| a |\n| --- |\n| x |', 2)
    expect(() => changeTable(single, 0, 0, 'a', 'deleteRow')).toThrow(/表头/)
    expect(() => changeTable(single, 1, 0, 'x', 'deleteRow')).toThrow(/最后/)
    expect(() => changeTable(single, 1, 0, 'x', 'deleteColumn')).toThrow(/最后/)
  })
  it('enforces every frozen limit before insertion or growth', () => {
    expect(() => tableSize(201, 9)).not.toThrow()
    for (const [rows, columns] of [[202, 1], [2, 21], [201, 10], [1, 3], [3, 0], [3.5, 2]]) expect(() => tableSize(rows, columns)).toThrow()
    expect(() => serializeTable([['x'.repeat(100001)], ['']], [null])).toThrow(/100,000/)
    const full = serializeTable(Array.from({ length: 201 }, () => ['']), [null]), table = sourceTable(full, 0)
    expect(() => changeTable(table, 200, 0, '', undefined, undefined, true)).toThrow()
  })
})
