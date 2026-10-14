import { StateField, type Text } from '@codemirror/state'

export const MAX_HIGHLIGHT_LINE = 20_000

function countLines(doc: Text, from: number, to: number, seen: Set<number>) {
  let count = 0
  const first = doc.lineAt(from).number, last = doc.lineAt(to).number
  for (let number = first; number <= last; number++) {
    if (seen.has(number)) continue
    seen.add(number)
    if (doc.line(number).length > MAX_HIGHLIGHT_LINE) count++
  }
  return count
}

// Recount only changed physical lines. Joining, splitting and multiple edits
// must also include the lines touching either end of each changed range.
export const largeLines = StateField.define<number>({
  create: (state) => countLines(state.doc, 0, state.doc.length, new Set()),
  update: (count, transaction) => {
    if (!transaction.docChanged) return count
    const before = new Set<number>(), after = new Set<number>()
    transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
      count -= countLines(transaction.startState.doc, fromA, toA, before)
      count += countLines(transaction.newDoc, fromB, toB, after)
    })
    return count
  },
})
