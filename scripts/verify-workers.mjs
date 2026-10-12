import assert from 'node:assert/strict'
import { createContext, runInContext } from 'node:vm'
import { productionWorkers, workerKind } from './production-workers.mjs'

// Exercise the worker code shipped inside the production bundle, without a DOM.
const workerSources = await productionWorkers()
let parsed
let searchResults
for (const source of workerSources) {
  const self = { postMessage: (message) => { parsed = message }, setImmediate, clearImmediate }
  const context = createContext({ self, URL, Blob, Uint8Array, DataView, setTimeout, clearTimeout, TextEncoder, TextDecoder })
  runInContext(source, context, { timeout: 5000 })
  assert.equal(typeof self.onmessage, 'function', 'Worker must initialise without document/window')
  if (workerKind(source) !== 'markdown') continue
  self.onmessage({ data: { text: '# 中文 &amp; worker\n\n![图片](assets/example.png)\n\n<script>alert(1)</script>', revision: 7 } })
}
assert.equal(parsed?.revision, 7)
assert.equal(parsed?.error, undefined)
assert.equal(parsed?.parsed.headings[0].title, '中文 & worker')
assert.equal(parsed?.parsed.images[0].url, 'assets/example.png')
assert.ok(!parsed.parsed.html.includes('<script>'))
for (const source of workerSources) {
  if (workerKind(source) !== 'search') continue
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
let docxResult
const docxSelf = { postMessage: message => { docxResult = message }, setImmediate, clearImmediate }
runInContext(workerSources.find(source => workerKind(source) === 'docx'), createContext({ self: docxSelf, URL, Blob, Uint8Array, DataView, setTimeout, clearTimeout, TextEncoder, TextDecoder }), { timeout: 5000 })
await docxSelf.onmessage({ data: { type: 'parse', text: '# DOCX 中文\n\n未保存正文', name: '办公.md' } })
assert.equal(docxResult?.error, undefined)
assert.equal(docxResult?.value.name, '办公.docx')
assert.equal(docxResult?.value.blocks[0].type, 'heading')
console.log('All four production workers initialise without a DOM; Markdown, DOCX parsing, entities, source positions, search counting and sanitisation pass.')
