import type { EditCommandResult, Selection } from './document'

export interface FencedBlock { from: number; to: number; language: string }

export function codeBlockCommand(revision: number, text: string, selection: Selection, language: string, block: FencedBlock | null): EditCommandResult {
  if (!/^[\w+#.-]*$/.test(language)) throw new Error('代码语言标记无效')
  if (block) {
    const end = text.indexOf('\n', block.from)
    const lineEnd = end < 0 ? text.length : end
    const line = text.slice(block.from, lineEnd)
    const opening = /^([`~]{3,})(\s*)(\S*)/.exec(line)
    if (!opening) throw new Error('请将光标放在围栏代码块中')
    const from = block.from + opening[1].length
    // CommonMark treats the first info token as a language. Clear the whole
    // info string for "no language", so metadata cannot become a language.
    const to = language ? from + opening[2].length + opening[3].length : lineEnd
    const insert = language
    const adjust = (pos: number) => pos <= from ? pos : pos >= to ? pos + insert.length - (to - from) : from + insert.length
    return { baseTextRevision: revision, patches: [{ from, to, insert }], selection: { anchor: adjust(selection.anchor), head: adjust(selection.head) } }
  }
  const from = Math.min(selection.anchor, selection.head), to = Math.max(selection.anchor, selection.head)
  const body = text.slice(from, to)
  let longest = 2
  for (const match of body.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  const fence = '`'.repeat(longest + 1)
  const prefix = `${from > 0 && text[from - 1] !== '\n' ? '\n' : ''}${fence}${language}\n`
  const insert = `${prefix}${body}\n${fence}${text[to] === '\n' ? '' : '\n'}`
  return { baseTextRevision: revision, patches: [{ from, to, insert }], selection: { anchor: from + prefix.length, head: from + prefix.length + body.length } }
}
