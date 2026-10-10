import assert from 'node:assert/strict'
import { createContext, runInContext } from 'node:vm'
import { productionWorkers } from './production-workers.mjs'

// Exercise the worker code shipped inside the production bundle, without a DOM.
const workerSources = await productionWorkers()
let parsed
for (const source of workerSources) {
  const self = { postMessage: (message) => { parsed = message } }
  const context = createContext({ self, URL, Blob, Uint8Array, DataView })
  runInContext(source, context, { timeout: 5000 })
  assert.equal(typeof self.onmessage, 'function', 'Worker must initialise without document/window')
  if (!source.includes('headings:')) continue
  self.onmessage({ data: { text: '# 中文 &amp; worker\n\n![图片](assets/example.png)\n\n<script>alert(1)</script>', revision: 7 } })
}
assert.equal(parsed?.revision, 7)
assert.equal(parsed?.error, undefined)
assert.equal(parsed?.parsed.headings[0].title, '中文 & worker')
assert.equal(parsed?.parsed.images[0].url, 'assets/example.png')
assert.ok(!parsed.parsed.html.includes('<script>'))
console.log('Production workers initialise without a DOM; Markdown, entities, source positions and sanitisation pass.')
