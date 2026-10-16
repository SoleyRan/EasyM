import { expect, it } from 'vitest'
import { planMerge, type MergePlan } from './merge'

function clean(base: string, local: string, disk: string, expected: string) {
  const result = planMerge(base, local, disk)
  expect(result.status).toBe('clean')
  if (result.status !== 'clean') throw new Error(JSON.stringify(result))
  expect(result.text).toBe(expected)
  expect(result.conflicts).toBe(0)
  const reverse = planMerge(base, disk, local)
  expect(reverse.status).toBe('clean')
  if (reverse.status === 'clean') expect(reverse.text).toBe(expected)
}
function conflicts(result: MergePlan) {
  expect(result.status).toBe('conflicts')
  if (result.status === 'unavailable') throw new Error(result.reason)
  expect(result.text).toBeUndefined()
  return result.chunks.filter(chunk => chunk.kind === 'conflict')
}

it('combines independent and adjacent line edits without rewriting Markdown or Unicode', () => {
  clean('# 标题\n\n第一段 😀\n\n第二段\n', '# 新标题\n\n第一段 😀\n\n第二段\n', '# 标题\n\n第一段 😀\n\n**第二段**\n', '# 新标题\n\n第一段 😀\n\n**第二段**\n')
  clean('a\nb\nc', 'A\nb\nc', 'a\nB\nc', 'A\nB\nc')
  clean('a\nb\nc\nd', 'a\nc\nd', 'a\nb\nc\nD', 'a\nc\nD')
})
it('retains unchanged content, empty bodies, blank lines and exact terminal newline state', () => {
  for (const text of ['', '\n', 'a', 'a\n', '\n\na\n\n', '😀中文\n\n']) {
    clean(text, text, text, text)
    clean('', text, '', text)
    clean(text, '', text, '')
    clean(text, text, '', '')
    clean('', text, text, text)
  }
  clean('a\nb\nc', 'a\nb\nc\n', 'A\nb\nc', 'A\nb\nc\n')
  clean('a\nb\nc\n', 'a\nb\nc', 'A\nb\nc\n', 'A\nb\nc')
  clean('a\r\nb\r\n', 'A\r\nb\r\n', 'a\r\nB\r\n', 'A\nB\n')
})
it('coalesces identical replacements, insertions and deletions once', () => {
  clean('a\nb\nc', 'a\nB\nc', 'a\nB\nc', 'a\nB\nc')
  clean('a\nb\nc', 'a\nnew\nb\nc', 'a\nnew\nb\nc', 'a\nnew\nb\nc')
  clean('a\nb\nc', 'a\nc', 'a\nc', 'a\nc')
})
it('requires explicit resolution for overlapping replacement/deletion and different same-position inserts', () => {
  for (const [base, local, disk] of [
    ['a\nb\nc', 'a\nL\nc', 'a\nR\nc'],
    ['a\nb\nc', 'a\nc', 'a\nR\nc'],
    ['a\nb', 'a\nL\nb', 'a\nR\nb'],
    ['', 'local', 'disk'],
    ['a\nb\nc\nd', 'a\nL\nd', 'a\nb\nR'],
    ['one line', 'local line', 'one disk'],
  ]) {
    const result = planMerge(base, local, disk), reverse = planMerge(base, disk, local)
    const regions = conflicts(result), reversed = conflicts(reverse)
    expect(regions).toHaveLength(1)
    expect(reversed.map(c => [c.base, c.disk, c.local])).toEqual(regions.map(c => [c.base, c.local, c.disk]))
  }
})
it('treats insertion at deletion boundaries conservatively and groups transitive overlaps', () => {
  conflicts(planMerge('a\nb\nc', 'a\nc', 'a\nnew\nb\nc'))
  conflicts(planMerge('a\nb\nc', 'a\nc', 'a\nb\nnew\nc'))
  const chunks = conflicts(planMerge('a\nb\nc\nd\ne', 'a\nL1\nc\nL2\ne', 'a\nR\ne'))
  expect(chunks).toHaveLength(1)
  expect(chunks[0]).toMatchObject({ base: ['b', 'c', 'd'], local: ['L1', 'c', 'L2'], disk: ['R'] })
})
it('preserves both sides in every region, even with repeated blank and duplicate lines', () => {
  let seed = 61
  const random = (n: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n }
  const values = ['', '重复', '😀', '```', 'same']
  for (let i = 0; i < 250; i++) {
    const base = Array.from({ length: 12 }, () => values[random(values.length)]).join('\n')
    const local = base.split('\n'), disk = base.split('\n')
    local.splice(random(local.length), random(3), 'local', values[random(values.length)])
    disk.splice(random(disk.length), random(3), 'disk', values[random(values.length)])
    const plan = planMerge(base, local.join('\n'), disk.join('\n'))
    expect(plan.status).not.toBe('unavailable')
    if (plan.status === 'unavailable') continue
    // Reconstruct each input using its own side's changed regions and the base for the other side.
    for (const side of ['local', 'disk'] as const) {
      const rebuilt = plan.chunks.flatMap(chunk => chunk.kind === 'conflict' ? chunk[side] : chunk.kind === 'common' || chunk.kind === side ? chunk.lines : base.split('\n').slice(chunk.from, chunk.to)).join('\n')
      // Common changed chunks arise only for identical edits; this sample uses distinct edit labels.
      expect(rebuilt).toBe((side === 'local' ? local : disk).join('\n'))
    }
    const reverse = planMerge(base, disk.join('\n'), local.join('\n'))
    expect(reverse.status).toBe(plan.status)
    if (reverse.status !== 'unavailable') expect(reverse.conflicts).toBe(plan.conflicts)
  }
})
it('refuses missing ancestors, oversized inputs, excessive regions and expired deadlines', () => {
  expect(planMerge(null, 'a', 'b')).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('共同祖先') })
  expect(planMerge('', '中'.repeat(2 * 1024 * 1024), '')).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('5 MiB') })
  expect(planMerge('\n'.repeat(100000), '', '')).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('100,000') })
  expect(planMerge('a', 'b', 'c', Date.now() - 1)).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('限制') })
  const base = Array.from({ length: 2202 }, (_, i) => `line-${i}`)
  const local = base.flatMap((line, i) => i % 2 === 0 ? ['local', line] : [line])
  const disk = base.flatMap((line, i) => i % 2 === 1 ? ['disk', line] : [line])
  expect(planMerge(base.join('\n'), local.join('\n'), disk.join('\n'))).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('2,000') })
})
