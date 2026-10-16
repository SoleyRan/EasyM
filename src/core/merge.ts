import { historyDiff, type HistoryDiff } from './history-diff'

export type MergeChunk =
  | { kind: 'common' | 'local' | 'disk'; from: number; to: number; lines: string[] }
  | { kind: 'conflict'; from: number; to: number; base: string[]; local: string[]; disk: string[] }
export type MergePlan =
  | { status: 'unavailable'; reason: string }
  | { status: 'clean' | 'conflicts'; chunks: MergeChunk[]; conflicts: number; text?: string }
interface Change { from: number; to: number; lines: string[]; side: 'local' | 'disk' }
const MAX_BYTES = 5 * 1024 * 1024, MAX_REGIONS = 2000
export const unavailableMerge = (reason: string): MergePlan => ({ status: 'unavailable', reason })

function changes(diff: HistoryDiff, side: Change['side']): Change[] {
  const result: Change[] = []
  let position = 0, current: Change | undefined
  for (const line of diff.lines) {
    if (line.kind === 'context') { current = undefined; position++; continue }
    if (!current) { current = { from: position, to: position, lines: [], side }; result.push(current) }
    if (line.kind === 'delete') current.to = ++position
    else current.lines.push(line.text)
  }
  return result
}

function render(base: string[], from: number, to: number, edits: Change[]): string[] {
  const lines: string[] = []
  let cursor = from
  for (const edit of edits) {
    for (; cursor < edit.from; cursor++) lines.push(base[cursor])
    for (const line of edit.lines) lines.push(line)
    cursor = edit.to
  }
  for (; cursor < to; cursor++) lines.push(base[cursor])
  return lines
}
const equal = (a: string[], b: string[]) => a.length === b.length && a.every((line, i) => line === b[i])

/** Pure, conservative line merge. Never guesses an ancestor or emits conflict markers. */
export function planMerge(base: string | null, local: string, disk: string, deadline = Date.now() + 9500): MergePlan {
  if (base === null) return unavailableMerge('没有可验证的共同祖先，请比较双方全文或另存本地副本。')
  for (const text of [base, local, disk]) {
    if (new TextEncoder().encode(text).length > MAX_BYTES) return unavailableMerge('单份正文超过 5 MiB，请比较双方全文或另存副本。')
  }
  const normalized = [base, local, disk].map(text => text.replace(/\r\n/g, '\n'))
  const lines = normalized[0].split('\n')
  const left = historyDiff(normalized[0], normalized[1], deadline)
  if (left.fallback) return unavailableMerge(left.fallback)
  const right = historyDiff(normalized[0], normalized[2], deadline)
  if (right.fallback) return unavailableMerge(right.fallback)
  const edits = [...changes(left, 'local'), ...changes(right, 'disk')].sort((a, b) => a.from - b.from || a.to - b.to)
  if (edits.length > MAX_REGIONS) return unavailableMerge('改动区域超过 2,000 个，请比较双方全文或另存副本。')
  const chunks: MergeChunk[] = []
  let cursor = 0, conflicts = 0
  for (let i = 0; i < edits.length;) {
    if (Date.now() > deadline) return unavailableMerge('合并分析达到时间限制，请比较双方全文或另存副本。')
    const from = edits[i].from, group: Change[] = [edits[i++]]
    let to = group[0].to, boundaryInsertion = group[0].from === to
    // Insertion at either edge of a deletion/replacement is deliberately a conflict.
    // Adjacent nonempty base ranges remain independent. Connected overlaps are one region.
    while (i < edits.length) {
      const next = edits[i], insertion = next.from === next.to
      if (next.from > to || (next.from === to && !insertion && !boundaryInsertion)) break
      group.push(next); i++
      if (next.to > to) { to = next.to; boundaryInsertion = false }
      if (insertion && next.to === to) boundaryInsertion = true
    }
    if (cursor < from) chunks.push({ kind: 'common', from: cursor, to: from, lines: lines.slice(cursor, from) })
    const localEdits = group.filter(edit => edit.side === 'local'), diskEdits = group.filter(edit => edit.side === 'disk')
    const l = render(lines, from, to, localEdits), r = render(lines, from, to, diskEdits)
    if (!localEdits.length || !diskEdits.length || equal(l, r)) {
      chunks.push({ kind: !localEdits.length ? 'disk' : !diskEdits.length ? 'local' : 'common', from, to, lines: localEdits.length ? l : r })
    } else {
      chunks.push({ kind: 'conflict', from, to, base: lines.slice(from, to), local: l, disk: r }); conflicts++
    }
    cursor = to
  }
  if (cursor < lines.length) chunks.push({ kind: 'common', from: cursor, to: lines.length, lines: lines.slice(cursor) })
  if (conflicts) return { status: 'conflicts', chunks, conflicts }
  const text = chunks.flatMap(chunk => chunk.kind === 'conflict' ? [] : chunk.lines).join('\n')
  if (new TextEncoder().encode(text).length > 2 * MAX_BYTES) return unavailableMerge('合并结果超过 10 MiB，请另存双方副本。')
  if (Date.now() > deadline) return unavailableMerge('合并分析达到时间限制，请比较双方全文或另存副本。')
  return { status: 'clean', chunks, conflicts: 0, text }
}
