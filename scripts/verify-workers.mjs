import assert from 'node:assert/strict'
import { createContext, runInContext } from 'node:vm'
import { productionWorkers } from './production-workers.mjs'

// Exercise the worker code shipped inside the production bundle, without a DOM.
const workerSources = await productionWorkers()
let parsed
let searchResults
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
for (const source of workerSources) {
  if (!source.includes('SEARCH_COUNT_FAILED')) continue
  const self = { postMessage: (message) => { searchResults = message } }
  const context = createContext({ self, URL, Blob, Uint8Array, DataView })
  runInContext(source, context, { timeout: 5000 })
  self.onmessage({ data: { text: '中文 WORD 中文', options: { search: '中文', caseSensitive: false, wholeWord: false }, revision: 11 } })
  assert.equal(searchResults?.revision, 11)
  assert.equal(searchResults?.results.matches.length, 2)
  self.onmessage({ data: { text: 'word WORD words', options: { search: 'word', caseSensitive: true, wholeWord: true }, revision: 12 } })
}
assert.equal(searchResults?.revision, 12)
assert.equal(searchResults?.results.matches.length, 1)
console.log('Production workers initialise without a DOM; Markdown, entities, source positions, search counting and sanitisation pass.')
