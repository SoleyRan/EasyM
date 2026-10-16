import assert from 'node:assert/strict'
import { createContext, runInContext } from 'node:vm'
import { productionWorkers, workerKind } from './production-workers.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'

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
let diffResult
const diffSelf = { postMessage: message => { diffResult = message } }
runInContext(workerSources.find(source => workerKind(source) === 'history'), createContext({ self: diffSelf, TextEncoder, TextDecoder, Date }), { timeout: 5000 })
diffSelf.onmessage({ data: { before: 'one\r\ntwo', after: 'one\nchanged' } })
assert.equal(diffResult?.fallback, undefined)
assert.equal(diffResult?.additions, 1); assert.equal(diffResult?.deletions, 1)
diffSelf.onmessage({ data: { type: 'references', texts: ['![local](assets/a.png) ![outside](../a.png) ![remote](https://example.com/a.png)'] } })
assert.equal(diffResult.references[0].references.join(','), 'assets/a.png')
assert.equal(diffResult.references[0].unarchivedReferences.join(','), '../a.png')
diffSelf.onmessage({ data: { type: 'merge', base: 'a\nb\nc', local: 'A\nb\nc', disk: 'a\nb\nC' } })
assert.equal(diffResult.status, 'clean'); assert.equal(diffResult.text, 'A\nb\nC')
diffSelf.onmessage({ data: { type: 'merge', base: 'a', local: 'L', disk: 'R' } })
assert.equal(diffResult.status, 'conflicts'); assert.equal(diffResult.conflicts, 1)
assert.equal(diffResult.text, undefined)
assert.equal(diffResult.chunks.find(chunk => chunk.kind === 'conflict').base.join('\n'), 'a')
diffSelf.onmessage({ data: { type: 'merge', base: null, local: 'L', disk: 'R' } })
assert.equal(diffResult.status, 'unavailable')
const base = Array.from({ length: 80000 }, (_, i) => String(i).padStart(6, '0') + ' ' + 'x'.repeat(56)).join('\n')
const samples = [
  { name: '5MiB-near-limit-small-edit', before: base, after: base.replace('000040 ', 'edited ') },
  { name: '100KiB-single-line', before: 'a'.repeat(100 * 1024), after: 'b'.repeat(100 * 1024) },
  { name: 'unrelated-10000-lines', before: Array.from({ length: 10000 }, (_, i) => 'a' + i).join('\n'), after: Array.from({ length: 10000 }, (_, i) => 'b' + i).join('\n') },
  { name: 'over-5MiB-fallback', before: 'a'.repeat(5 * 1024 * 1024 + 1), after: '' },
]
const measurements = []
for (const sample of samples) {
  const memory = process.memoryUsage(), start = performance.now()
  diffSelf.onmessage({ data: sample })
  const end = process.memoryUsage()
  measurements.push({ name: sample.name, bytesBefore: Buffer.byteLength(sample.before), bytesAfter: Buffer.byteLength(sample.after), durationMs: Math.round((performance.now() - start) * 100) / 100, heapDeltaBytes: end.heapUsed - memory.heapUsed, rssAfterBytes: end.rss, additions: diffResult.additions, deletions: diffResult.deletions, fallback: diffResult.fallback ?? null })
}
assert.equal(measurements[0].additions, 1); assert.equal(measurements[0].deletions, 1)
assert.match(measurements[2].fallback, /限制/); assert.match(measurements[3].fallback, /5 MiB/)
await mkdir('test-results', { recursive: true })
await writeFile('test-results/history-diff-performance.json', JSON.stringify({ verifiedAt: new Date().toISOString(), platform: os.platform(), release: os.release(), cpu: os.cpus()[0]?.model, node: process.version, scope: 'Actual shipped worker in Node VM. Endpoint process heap/RSS samples, not browser/WebView peak memory; GC may produce negative deltas.', measurements }, null, 2) + '\n')
console.log('All five production workers initialise without a DOM; Markdown, DOCX, history diff, three-way merge analysis, search counting and sanitisation pass.')
