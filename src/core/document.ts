export type LineEnding = 'lf' | 'crlf' | 'mixed'

export interface TextPatch {
  from: number
  to: number
  insert: string
}

export interface Selection {
  anchor: number
  head: number
}

export interface EditCommandResult {
  baseTextRevision: number
  patches: TextPatch[]
  selection?: Selection
}

export interface DocumentState {
  id: string
  uri: string | null
  text: string
  textRevision: number
  baseRevision: string | null
  encoding: 'utf-8' | 'utf-8-bom' | 'unknown'
  lineEnding: LineEnding
  dirty: boolean
  draftAvailable: boolean
}

export function detectLineEnding(text: string): LineEnding {
  const hasLf = /(^|[^\r])\n/.test(text)
  const hasCrlf = /\r\n/.test(text)
  if (hasLf && hasCrlf) return 'mixed'
  return hasCrlf ? 'crlf' : 'lf'
}

export function applyPatches(text: string, patches: readonly TextPatch[]): string {
  const ordered = [...patches].sort((a, b) => b.from - a.from)
  let result = text
  let lastFrom = text.length + 1
  for (const patch of ordered) {
    if (!Number.isInteger(patch.from) || !Number.isInteger(patch.to) || patch.from < 0 || patch.to < patch.from || patch.to > text.length) {
      throw new RangeError('Patch range is outside the current document')
    }
    if (patch.to > lastFrom) throw new RangeError('Patches must not overlap')
    result = result.slice(0, patch.from) + patch.insert + result.slice(patch.to)
    lastFrom = patch.from
  }
  return result
}

export function replaceSelection(textRevision: number, selection: Selection, insert: string): EditCommandResult {
  const from = Math.min(selection.anchor, selection.head)
  const to = Math.max(selection.anchor, selection.head)
  const next = from + insert.length
  return { baseTextRevision: textRevision, patches: [{ from, to, insert }], selection: { anchor: next, head: next } }
}

export function wrapSelection(textRevision: number, text: string, selection: Selection, marker: string): EditCommandResult {
  const from = Math.min(selection.anchor, selection.head)
  const to = Math.max(selection.anchor, selection.head)
  const selected = text.slice(from, to) || '文本'
  const insert = `${marker}${selected}${marker}`
  return { baseTextRevision: textRevision, patches: [{ from, to, insert }], selection: { anchor: from + marker.length, head: from + marker.length + selected.length } }
}

export function prefixLines(textRevision: number, text: string, selection: Selection, prefix: string): EditCommandResult {
  const from = Math.min(selection.anchor, selection.head)
  const to = Math.max(selection.anchor, selection.head)
  const lineStart = from === 0 ? 0 : text.lastIndexOf('\n', from - 1) + 1
  const selected = text.slice(lineStart, to)
  const insert = selected.split('\n').map((line) => `${prefix}${line}`).join('\n')
  return { baseTextRevision: textRevision, patches: [{ from: lineStart, to, insert }], selection: { anchor: lineStart, head: lineStart + insert.length } }
}

export function imageMarkdown(alt = '图片', path = 'assets/image.png'): string {
  return `![${alt.replace(/[\\\[\]]/g, '\\$&')}](${encodeURI(path).replace(/[()]/g, (char) => encodeURIComponent(char))})`
}

export function insertImage(text: string, selection: Selection, markdown: string, replaceImage = false): EditCommandResult {
  const from = Math.min(selection.anchor, selection.head)
  const to = Math.max(selection.anchor, selection.head)
  const insert = replaceImage ? markdown : `${from > 0 && text[from - 1] !== '\n' ? '\n' : ''}${markdown}${text[to] !== '\n' ? '\n' : ''}`
  return replaceSelection(0, selection, insert)
}
