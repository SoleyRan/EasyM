import type { CommandDefinition } from './commands'
import type { EditCommandResult, Selection } from './document'
import { contentTree } from './content-tools'

export const insertKinds = [
  ['h1', '一级标题', 'heading h1'], ['h2', '二级标题', 'heading h2'], ['h3', '三级标题', 'heading h3'],
  ['h4', '四级标题', 'heading h4'], ['h5', '五级标题', 'heading h5'], ['h6', '六级标题', 'heading h6'],
  ['bullet', '无序列表', 'bullet list'], ['ordered', '有序列表', 'ordered list'], ['task', '任务列表', 'task todo list'],
  ['quote', '引用', 'quote'], ['code', '围栏代码块', 'fenced code'], ['divider', '分隔线', 'divider horizontal rule'],
] as const
export type InsertKind = typeof insertKinds[number][0]
export const insertionDefinitions: CommandDefinition[] = insertKinds.map(([kind, label, alias]) => ({ id: `insert.${kind}`, label: `插入${label}`, group: '插入', aliases: [alias, kind] }))
export interface SlashTrigger { from: number; to: number; query: string }

// Parse only after the bounded current line has matched a possible trigger.
export function slashTrigger(text: string, selection: Selection): SlashTrigger | null {
  if (selection.anchor !== selection.head || selection.head < 0 || selection.head > text.length) return null
  const head = selection.head, start = head === 0 ? 0 : text.lastIndexOf('\n', head - 1) + 1
  const line = text.slice(start, head).replace(/^\uFEFF/, '')
  const match = /^ {0,3}\/([^/\\:\r\n]{0,64})$/.exec(line)
  if (!match || (head < text.length && !/^[\r\n]/.test(text.slice(head, head + 1)))) return null
  const from = head - match[1].length - 1
  try {
    const node = contentTree(text).children.find(node => (node.position?.start.offset ?? -1) <= from && (node.position?.end.offset ?? -1) >= head)
    if (!node || node.type !== 'paragraph') return null
    return { from, to: head, query: match[1] }
  } catch { return null }
}
export function validSlash(text: string, selection: Selection, trigger: SlashTrigger): boolean {
  const current = slashTrigger(text, selection)
  return !!current && current.from === trigger.from && current.to === trigger.to && current.query === trigger.query
}
export function matchesQuery(values: readonly string[], query: string): boolean {
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const haystack = values.join(' ').toLocaleLowerCase()
  return tokens.every(token => haystack.includes(token))
}
export function filterCommands(definitions: readonly CommandDefinition[], query: string): CommandDefinition[] {
  return definitions.filter(command => matchesQuery([command.label, command.group, command.id, ...command.aliases], query))
}
export function insertStructure(revision: number, text: string, selection: Selection, kind: InsertKind, trigger?: SlashTrigger): EditCommandResult {
  if (!insertKinds.some(([value]) => value === kind)) throw new Error('插入类型无效。')
  if (trigger && !validSlash(text, selection, trigger)) throw new Error('快捷插入位置已变化，请重新输入 /。')
  const from = trigger?.from ?? Math.min(selection.anchor, selection.head), to = trigger?.to ?? Math.max(selection.anchor, selection.head)
  const eol = text.match(/\r\n|\n/)?.[0] ?? '\n'
  const structure = kind.startsWith('h') ? '#'.repeat(Number(kind.slice(1))) + ' ' : {
    bullet: '- ', ordered: '1. ', task: '- [ ] ', quote: '> ', code: '```' + eol + eol + '```', divider: '---' + eol,
  }[kind as Exclude<InsertKind, `h${number}`>]
  const prefix = !trigger && from > 0 && text[from - 1] !== '\n' ? eol + eol : ''
  const suffix = !trigger && to < text.length && text[to] !== '\n' && text[to] !== '\r' ? eol + eol : ''
  const insert = prefix + structure + suffix
  const caret = from + prefix.length + (kind === 'code' ? 3 + eol.length : structure.length)
  return { baseTextRevision: revision, patches: [{ from, to, insert }], selection: { anchor: caret, head: caret } }
}

export interface QuickTab { id: string; name: string; path?: string | null }
export function filterTabs(tabs: readonly QuickTab[], query: string): QuickTab[] {
  return tabs.filter(tab => matchesQuery([tab.name, tab.path ?? ''], query))
}
