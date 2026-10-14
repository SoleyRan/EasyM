export interface DiffLine { kind: 'context' | 'add' | 'delete'; text: string; before?: number; after?: number }
export interface HistoryDiff { lines: DiffLine[]; fallback?: string; additions: number; deletions: number }
const MAX_BYTES = 5 * 1024 * 1024, MAX_LINES = 100000

/** Myers with a bounded trace. Unrelated huge inputs fall back before quadratic allocation. */
export function historyDiff(before: string, after: string, deadline = Date.now() + 9500): HistoryDiff {
  const fallback = (reason: string): HistoryDiff => ({ lines: [], additions: 0, deletions: 0, fallback: reason })
  if (new TextEncoder().encode(before).length > MAX_BYTES || new TextEncoder().encode(after).length > MAX_BYTES) return fallback('输入超过 5 MiB，未生成逐行差异；请查看双方全文。')
  const a = before.replace(/\r\n/g, '\n').split('\n'), b = after.replace(/\r\n/g, '\n').split('\n')
  if (a.length > MAX_LINES || b.length > MAX_LINES) return fallback('输入超过 100,000 行，未生成逐行差异；请查看双方全文。')
  let start = 0, end = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
  const n = a.length - start - end, m = b.length - start - end, max = n + m
  const trace: Map<number, number>[] = [], v = new Map<number, number>([[1, 0]])
  let distance = -1, cells = 0
  outer: for (let d = 0; d <= max; d++) {
    cells += v.size
    if (cells > 2000000 || Date.now() > deadline) return fallback('差异计算达到时间或内存限制，未生成逐行差异；请查看双方全文。')
    trace.push(new Map(v))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1
      let y = x - k
      while (x < n && y < m && a[start + x] === b[start + y]) { x++; y++ }
      v.set(k, x)
      if (x >= n && y >= m) { distance = d; break outer }
    }
  }
  if (distance < 0) return fallback('未生成逐行差异；请查看双方全文。')
  let x = n, y = m
  const middle: DiffLine[] = []
  for (let d = distance; d >= 0; d--) {
    const previous = trace[d], k = x - y
    const previousK = k === -d || (k !== d && (previous.get(k - 1) ?? -1) < (previous.get(k + 1) ?? -1)) ? k + 1 : k - 1
    const previousX = previous.get(previousK) ?? 0, previousY = previousX - previousK
    while (x > previousX && y > previousY) { middle.push({ kind: 'context', text: a[start + x - 1], before: start + x, after: start + y }); x--; y-- }
    if (!d) break
    if (x === previousX) { middle.push({ kind: 'add', text: b[start + y - 1], after: start + y }); y-- }
    else { middle.push({ kind: 'delete', text: a[start + x - 1], before: start + x }); x-- }
  }
  middle.reverse()
  const lines: DiffLine[] = [...a.slice(0, start).map((text, i): DiffLine => ({ kind: 'context', text, before: i + 1, after: i + 1 })), ...middle,
    ...a.slice(a.length - end).map((text, i): DiffLine => ({ kind: 'context', text, before: a.length - end + i + 1, after: b.length - end + i + 1 }))]
  return { lines, additions: middle.filter(l => l.kind === 'add').length, deletions: middle.filter(l => l.kind === 'delete').length }
}
