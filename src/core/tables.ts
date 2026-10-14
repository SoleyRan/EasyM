import type { Table } from 'mdast'
import { parseMarkdownAst } from './markdown-ast'
import type { TextPatch } from './document'

export type Alignment = 'left' | 'center' | 'right' | null
export interface TableCell { from: number; to: number; value: string; boundaryFrom: number; boundaryTo: number }
export interface SourceTable { from: number; to: number; rows: TableCell[][]; align: Alignment[]; newline: string }
export const TABLE_LIMITS = { columns: 20, rows: 201, cells: 2000, source: 100000, cell: 10000 }
export function tableSize(rows: number, columns: number) {
  if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 2 || columns < 1 || rows > TABLE_LIMITS.rows || columns > TABLE_LIMITS.columns || rows * columns > TABLE_LIMITS.cells) throw new Error('表格限 20 列、200 行正文、2,000 单元格，且至少保留一行正文和一列。')
}

// GFM treats even code-span pipes as delimiters unless escaped. Count the
// preceding backslash run, rather than splitting on every pipe or skipping code.
function cells(line: string, offset: number): TableCell[] {
  const cuts: number[] = []
  let slashes = 0
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '|' && slashes % 2 === 0) cuts.push(i)
    slashes = line[i] === '\\' ? slashes + 1 : 0
  }
  let start = 0, end = line.length
  if (cuts.length && !line.slice(0, cuts[0]).trim()) start = cuts.shift()! + 1
  if (cuts.length && !line.slice(cuts.at(-1)! + 1).trim()) end = cuts.pop()!
  return [...cuts, end].map(cut => {
    const raw = line.slice(start, cut), left = raw.length - raw.trimStart().length
    const from = offset + start + left, value = raw.trim()
    const result = { from, to: from + value.length, value, boundaryFrom: offset + Math.max(0, start - 1), boundaryTo: offset + cut }
    start = cut + 1
    return result
  })
}
export function sourceTable(text: string, offset: number): SourceTable {
  const ast = parseMarkdownAst(text)
  const node = ast.children.find((item): item is Table => item.type === 'table' && item.position!.start.offset! <= offset && item.position!.end.offset! >= offset)
  if (!node) throw new Error('当前位置不是可编辑的顶层 GFM 表格；嵌套或不明确的表格请使用源码。')
  const from = node.position!.start.offset!, to = node.position!.end.offset!
  if (to - from > TABLE_LIMITS.source) throw new Error('表格源码超过 100,000 字符，请使用源码编辑。')
  const lines = text.slice(from, to).split(/\r\n|\n|\r/)
  const newline = text.slice(from, to).match(/\r\n|\n|\r/)?.[0] ?? '\n'
  let cursor = from
  const mapped = lines.map(line => { const result = cells(line, cursor); cursor += line.length; cursor += text.slice(cursor, cursor + 2).startsWith('\r\n') ? 2 : 1; return result })
  const separator = mapped.splice(1, 1)[0]
  const columns = node.align?.length ?? 0
  tableSize(mapped.length, columns)
  if (mapped.length !== node.children.length || mapped.some(row => row.length !== columns) || separator.length !== columns || separator.some(cell => !/^:?-+:?$/.test(cell.value))) throw new Error('表格列数不一致或分隔行不明确，请使用源码编辑。')
  // Confirm every scanned row against the shared parser, including inline code,
  // references and escapes. This rejects accidental source/semantic mismatches.
  const canonical = serializeTable(mapped.map(row => row.map(cell => cell.value)), node.align ?? [], newline)
  const reparsed = parseMarkdownAst(text.slice(0, from) + canonical + text.slice(to)).children.find(item => item.type === 'table' && item.position?.start.offset === from)
  const semantic = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, child) => key === 'position' ? undefined : child))
  if (reparsed?.type !== 'table' || JSON.stringify(semantic(node)) !== JSON.stringify(semantic(reparsed))) throw new Error('无法可靠映射此表格，请使用源码编辑。')
  return { from, to, rows: mapped, align: node.align ?? [], newline }
}
export function tableCellAt(table: SourceTable, offset: number) {
  let row = 0, column = 0
  table.rows.forEach((cells, r) => cells.forEach((cell, c) => { if (cell.boundaryFrom <= offset) { row = r; column = c } }))
  return { row, column }
}
export function escapeCell(value: string): string {
  if (value.length > TABLE_LIMITS.cell) throw new Error('单元格输入限 10,000 字符。')
  if (/[\r\n]/.test(value)) throw new Error('GFM 单元格不能包含换行；请移除换行后重试。')
  let result = '', slashes = 0
  for (const char of value) {
    if (char === '|' && slashes % 2 === 0) result += '\\'
    result += char
    slashes = char === '\\' ? slashes + 1 : 0
  }
  return result
}
export function serializeTable(rows: string[][], align: Alignment[], newline = '\n') {
  tableSize(rows.length, align.length)
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`
  const output = [line(rows[0]), line(align.map(a => a === 'left' ? ':---' : a === 'right' ? '---:' : a === 'center' ? ':---:' : '---')), ...rows.slice(1).map(line)].join(newline)
  if (output.length > TABLE_LIMITS.source) throw new Error('表格源码超过 100,000 字符，请使用源码编辑。')
  return output
}
export function insertTable(text: string, from: number, to: number, bodyRows: number, columns: number): TextPatch & { firstCell: number } {
  const newline = text.match(/\r\n|\n|\r/)?.[0] ?? '\n'
  tableSize(bodyRows + 1, columns)
  const prefix = from > 0 ? (text.slice(0, from).endsWith(newline + newline) ? '' : text.slice(0, from).endsWith(newline) ? newline : newline + newline) : ''
  const suffix = to < text.length ? (text.slice(to).startsWith(newline + newline) ? '' : text.slice(to).startsWith(newline) ? newline : newline + newline) : newline
  const insert = prefix + serializeTable(Array.from({ length: bodyRows + 1 }, () => Array(columns).fill('')), Array(columns).fill(null), newline) + suffix
  return { from, to, insert, firstCell: from + prefix.length + 2 }
}
export type TableOperation = 'rowAbove' | 'rowBelow' | 'deleteRow' | 'columnLeft' | 'columnRight' | 'deleteColumn' | 'align'
export function changeTable(table: SourceTable, row: number, column: number, value: string, operation?: TableOperation, alignment?: Alignment, addLastRow = false): TextPatch[] {
  if (!table.rows[row]?.[column]) throw new Error('单元格已失效，请重新打开表格。')
  const encoded = escapeCell(value), cell = table.rows[row][column]
  if (!operation && !addLastRow) return encoded === cell.value ? [] : [{ from: cell.from, to: cell.to, insert: encoded }]
  const rows = table.rows.map(cells => cells.map(cell => cell.value)), align = [...table.align]
  rows[row][column] = encoded
  if (operation === 'rowAbove' || operation === 'rowBelow') rows.splice(Math.max(1, row + (operation === 'rowBelow' ? 1 : 0)), 0, Array(align.length).fill(''))
  if (operation === 'deleteRow') { if (row === 0 || rows.length <= 2) throw new Error('不能删除表头或最后一行正文。'); rows.splice(row, 1) }
  if (operation === 'columnLeft' || operation === 'columnRight') { const at = column + (operation === 'columnRight' ? 1 : 0); rows.forEach(cells => cells.splice(at, 0, '')); align.splice(at, 0, null) }
  if (operation === 'deleteColumn') { if (align.length <= 1) throw new Error('不能删除最后一列。'); rows.forEach(cells => cells.splice(column, 1)); align.splice(column, 1) }
  if (operation === 'align') align[column] = alignment ?? null
  if (addLastRow) rows.push(Array(align.length).fill(''))
  const insert = serializeTable(rows, align, table.newline)
  return [{ from: table.from, to: table.to, insert }]
}
