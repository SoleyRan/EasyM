import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

export function workerKind(source) {
  if (source.includes('HISTORY_DIFF_FAILED')) return 'history'
  if (source.includes('DOCX 后台任务失败')) return 'docx'
  if (source.includes('OffscreenCanvas')) return 'image'
  if (source.includes('SEARCH_COUNT_FAILED')) return 'search'
  if (source.includes('headings:')) return 'markdown'
  return 'unknown'
}

export async function productionWorkers() {
  const files = (await readdir(new URL('../dist/assets/', import.meta.url))).filter((name) => name.endsWith('.js'))
  const workers = []
  for (const file of files) {
    const bundle = await readFile(new URL(`../dist/assets/${file}`, import.meta.url), 'utf8')
    for (const match of bundle.matchAll(/(['"`])\(function\(\)(?:\\[\s\S]|(?!\1)[^\\])*\1/g)) {
      if (!match[0].includes('self.onmessage')) continue
      const source = runInNewContext(match[0])
      if (typeof source === 'string' && source.startsWith('(function()')) workers.push(source)
    }
  }
  assert.deepEqual(workers.map(workerKind).sort(), ['docx', 'history', 'image', 'markdown', 'search'], 'Expected exactly one of each shipped worker')
  return workers
}
