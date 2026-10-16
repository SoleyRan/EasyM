import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'vite'
import { chromium } from 'playwright'

const output = resolve('test-results/docx'), report = { verifiedAt: new Date().toISOString(), passed: false, checks: [] }
await mkdir(output, { recursive: true })
let browser, server
try {
  // Override the app's multi-page input as well as the library entry. Otherwise
  // Vite builds index.html/mermaid.html and a stale entry.js can hide the error.
  const entry = resolve('scripts/fixtures/docx-export.ts')
  await build({ configFile: resolve('vite.config.ts'), logLevel: 'warn', build: { outDir: output, emptyOutDir: true, lib: { entry, formats: ['es'], fileName: () => 'entry.js' }, rollupOptions: { input: entry } } })
  assert.ok((await readFile(resolve(output, 'entry.js'), 'utf8')).includes('docxAcceptance'), 'DOCX fixture entry was not built')
  const csp = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8')).app.security.csp
  server = createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', csp)
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>DOCX pipeline acceptance</title><script type="module" src="/entry.js"></script>') }
    else if (/^\/[a-zA-Z0-9._-]+\.js$/.test(req.url)) { try { res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(resolve(output, req.url.slice(1)))) } catch { res.writeHead(404); res.end() } }
    else { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await chromium.launch({ channel: process.env.EASYM_TEST_BROWSER || undefined })
  report.browser = browser.version()
  const context = await browser.newContext({ acceptDownloads: true }), page = await context.newPage(), errors = [], remote = []
  report.diagnostics = { pageErrors: errors, consoleErrors: [], failedRequests: [], httpErrors: [] }
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', message => { if (message.type() === 'error') report.diagnostics.consoleErrors.push(message.text()) })
  page.on('requestfailed', request => report.diagnostics.failedRequests.push({ url: request.url(), error: request.failure()?.errorText }))
  page.on('response', response => { if (response.status() >= 400) report.diagnostics.httpErrors.push({ url: response.url(), status: response.status() }) })
  // Edge's built-in download hub can emit browser-internal requests after a
  // download. These are not application network traffic; keep rejecting every
  // external application request, including requests initiated by Workers.
  context.on('request', r => { if (!r.url().startsWith(`http://127.0.0.1:${server.address().port}/`) && !/^(?:blob:|edge:\/\/|chrome:\/\/)/.test(r.url())) remote.push(r.url()) })
  await page.addInitScript(() => {
    window.originalWorker = window.Worker
    window.workerStats = { started: 0, terminated: 0 }
    window.Worker = class extends window.originalWorker {
      constructor(...args) { super(...args); window.workerStats.started++ }
      terminate() { window.workerStats.terminated++; super.terminate() }
    }
  })
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.waitForFunction(() => window.docxAcceptance)
  const png = await readFile('Docs/samples/v0.3/assets/em.png'), text = await readFile('Docs/samples/v0.3/办公导出.md', 'utf8'), unsafe = await readFile('Docs/samples/v0.3/降级与安全.md', 'utf8')
  const started = Date.now()
  const result = await page.evaluate(async ({ bytes, text }) => {
    const api = window.docxAcceptance, source = { text, name: '办公.md', id: null, resources: { assets: { 'assets/em.png': new Blob([new Uint8Array(bytes)], { type: 'image/png' }) }, instances: [] } }
    const prepared = await api.preflightDocx(source), before = JSON.stringify(prepared)
    const output = await api.renderDocx(prepared)
    if (JSON.stringify(prepared) !== before || source.text !== text) throw new Error('Export mutated source or preflight')
    window.readyDocx = prepared
    window.docxBytes = output
    return { bytes: Array.from(new Uint8Array(output)), images: prepared.assets.length, warnings: prepared.model.warnings.items, stats: window.workerStats }
  }, { bytes: Array.from(png), text })
  report.generationMs = Date.now() - started
  assert.equal(result.images, 1); assert.equal(result.warnings.length, 1)
  assert.deepEqual(result.stats, { started: 3, terminated: 3 })
  const bytes = Buffer.from(result.bytes)
  await writeFile(resolve(output, 'office.docx'), bytes)
  const require = createRequire(import.meta.url), zip = await createRequire(require.resolve('docx'))('jszip').loadAsync(bytes, { checkCRC32: true })
  const entries = await Promise.all(Object.keys(zip.files).filter(name => /\.(xml|rels)$/.test(name)).map(async name => ({ name, text: await zip.file(name).async('string') })))
  await page.evaluate(entries => {
    for (const { name, text } of entries) {
      const xml = new DOMParser().parseFromString(text, 'application/xml')
      if (xml.querySelector('parsererror')) throw new Error(`Invalid XML: ${name}`)
    }
    const body = new DOMParser().parseFromString(entries.find(e => e.name === 'word/document.xml').text, 'application/xml')
    const allText = Array.from(body.getElementsByTagName('w:t'), n => n.textContent).join('\n')
    for (const t of ['EasyM 办公导出验收', '加粗中的 ', '词间不应意外合并', '嵌套引用。', '编号从三开始', 'console.log(title)', '保留前导空格', '之后的文字不能丢失', '结束段落']) if (!allText.includes(t)) throw new Error(`Content missing: ${t}`)
    if (body.getElementsByTagName('w:tbl').length !== 1 || body.getElementsByTagName('w:tr').length !== 4 || body.getElementsByTagName('w:tc').length !== 12) throw new Error('Incorrect editable table')
    if (body.getElementsByTagName('w:drawing').length !== 2) throw new Error('Images missing')
  }, entries)
  const media = Object.keys(zip.files).filter(name => name.startsWith('word/media/') && !zip.files[name].dir)
  assert.equal(media.length, 1); assert.deepEqual(await zip.file(media[0]).async('nodebuffer'), png)
  report.checks.push('actual platform API and inline Worker under app CSP', 'frozen office sample content/editable OOXML/CRC/XML', 'display PNG exact bytes and deduplication', 'input/model unchanged and workers terminated')
  const failureChecks = await page.evaluate(async ({ bytes, unsafe }) => {
    const api = window.docxAcceptance, source = text => ({ text, name: '测试.md', id: null, resources: { assets: {}, instances: [] } }), failures = []
    const expectError = async (call, name) => { try { await call(); throw new Error('Expected rejection') } catch (e) { if (name && e.name !== name) throw e; if (e.message === 'Expected rejection') throw e; failures.push(name || 'blocked') } }
    const missing = await api.preflightDocx(source(unsafe))
    if (missing.model.warnings.imageFailures !== 4) throw new Error('Missing restricted-image warnings')
    await expectError(() => api.renderDocx(missing))
    const degraded = await api.renderDocx(missing, { page: 'letter', style: 'compact', allowImagePlaceholders: true })
    window.degradedBytes = degraded
    // Valid PNG header/dimensions but no pixel data must fail complete decode.
    const invalid = source('![broken](assets/broken.png)')
    invalid.resources.assets['assets/broken.png'] = new Blob([new Uint8Array(bytes.slice(0, 24))])
    const broken = await api.preflightDocx(invalid)
    if (broken.model.images[0].status !== 'unavailable' || broken.model.warnings.imageFailures !== 1) throw new Error('Header-only corrupt image accepted')
    await expectError(() => api.renderDocx(broken))
    const quota = source('![huge](assets/huge.png)'), huge = new Uint8Array(bytes)
    new DataView(huge.buffer).setUint32(16, 9000)
    quota.resources.assets['assets/huge.png'] = new Blob([huge])
    await expectError(() => api.preflightDocx(quota), 'DocxQuotaError')
    await expectError(() => api.preflightDocx(source('界'.repeat(4 * 1024 * 1024))), 'DocxQuotaError')
    const early = new AbortController(); early.abort()
    await expectError(() => api.preflightDocx(source('cancel'), early.signal), 'AbortError')
    const parse = new AbortController(), parsing = api.preflightDocx(source('cancel'), parse.signal); parse.abort()
    await expectError(() => parsing, 'AbortError')
    const generation = new AbortController(), generating = api.renderDocx(window.readyDocx, undefined, generation.signal); generation.abort()
    await expectError(() => generating, 'AbortError')
    const decoding = new AbortController()
    const originalWorker = window.Worker
    window.Worker = class extends originalWorker { postMessage(request, ...rest) { super.postMessage(request, ...rest); if (request.type === 'decode') queueMicrotask(() => decoding.abort()) } }
    const image = source('![em](assets/em.png)'); image.resources.assets['assets/em.png'] = new Blob([new Uint8Array(bytes)])
    await expectError(() => api.preflightDocx(image, decoding.signal), 'AbortError')
    window.Worker = originalWorker
    // Exercise actual 60 s timeout branch quickly with an unresponsive Worker.
    const originalTimer = window.setTimeout
    window.setTimeout = (fn, ms, ...args) => originalTimer(fn, ms === 60000 ? 30 : ms, ...args)
    window.Worker = class extends originalWorker { postMessage() {} }
    try {
      await expectError(() => api.preflightDocx(source('timeout')), 'TimeoutError')
      await expectError(() => api.renderDocx(window.readyDocx), 'TimeoutError')
    } finally { window.Worker = originalWorker; window.setTimeout = originalTimer }
    if (window.workerStats.started !== window.workerStats.terminated) throw new Error('Worker leak on failure')
    if (window.easymDocxExecuted) throw new Error('Raw HTML executed')
    return { failures, stats: window.workerStats, degradedBytes: Array.from(new Uint8Array(degraded)) }
  }, { bytes: Array.from(png), unsafe })
  report.checks.push('restricted/missing/broken-image default block and explicit placeholders', 'hard UTF-8 and dimension quotas', 'cancel before/during parse, decode and generate', 'parse/generate timeout and termination on every path')
  await writeFile(resolve(output, 'degraded.docx'), Buffer.from(failureChecks.degradedBytes))
  const downloaded = page.waitForEvent('download')
  await page.evaluate(() => window.docxAcceptance.saveDocx('办公.docx', window.docxBytes))
  const download = await downloaded; assert.equal(download.suggestedFilename(), '办公.docx')
  assert.deepEqual(await readFile(await download.path()), bytes)
  report.checks.push('browser download MIME/name/bytes')
  assert.deepEqual(errors, []); assert.deepEqual(remote, [])
  report.checks.push('no remote requests or active raw HTML')
  report.outputBytes = bytes.length; report.outputSha256 = createHash('sha256').update(bytes).digest('hex'); report.workerStats = failureChecks.stats
  report.passed = true
  console.log(`DOCX pipeline passed: ${report.checks.length} checks; ${bytes.length} bytes; ${failureChecks.stats.terminated} workers terminated.`)
} catch (error) { report.error = error.stack; process.exitCode = 1 }
finally {
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve))
  await writeFile('test-results/docx-verification.json', JSON.stringify(report, null, 2) + '\n')
  if (!report.passed) console.error(report.error)
}
