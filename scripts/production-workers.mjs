import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

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
  assert.equal(workers.length, 3, 'Expected the shipped Markdown, image and search workers')
  return workers
}
