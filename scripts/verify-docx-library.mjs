import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { build } from 'vite'
import { chromium } from 'playwright'

const output = resolve('test-results/docx-library')
await mkdir(output, { recursive: true })
const report = { verifiedAt: new Date().toISOString(), library: 'docx', version: '9.10.0', node: process.version, browser: process.env.EASYM_TEST_BROWSER ?? 'chromium', passed: false }
let browser, server
try {
  // Reuse the application's worker export conditions, including remark's
  // DOM-free character-reference decoder; default browser conditions need DOM.
  await build({ configFile: resolve('vite.config.ts'), logLevel: 'warn', build: { outDir: output, emptyOutDir: false, lib: { entry: resolve('scripts/fixtures/docx-library-worker.ts'), formats: ['iife'], name: 'DocxProbe', fileName: () => 'probe.js' }, rollupOptions: { input: resolve('scripts/fixtures/docx-library-worker.ts'), plugins: [{ name: 'assert-no-external-imports', generateBundle(_, bundle) { for (const chunk of Object.values(bundle)) if (chunk.type === 'chunk') assert.equal(chunk.imports.length + chunk.dynamicImports.length, 0) } }] } } })
  const bundle = await readFile(resolve(output, 'probe.js'))
  const csp = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8')).app.security.csp
  server = createServer((req, res) => {
    res.setHeader('Content-Security-Policy', csp)
    if (req.url === '/probe.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle) }
    else { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>DOCX library verification</title>') }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await chromium.launch({ channel: process.env.EASYM_TEST_BROWSER || undefined })
  report.browserVersion = browser.version()
  const context = await browser.newContext(), page = await context.newPage(), errors = [], remote = []
  page.on('pageerror', error => errors.push(error.message))
  context.on('request', request => { if (!request.url().startsWith(`http://127.0.0.1:${server.address().port}/`)) remote.push(request.url()) })
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  const png = await readFile('Docs/samples/v0.3/assets/em.png')
  const started = Date.now()
  const result = await page.evaluate(({ bytes, text }) => new Promise((resolve, reject) => {
    const worker = new Worker('/probe.js'), timer = setTimeout(() => { worker.terminate(); reject(new Error('Worker timeout (60 s)')) }, 60_000)
    const finish = () => { clearTimeout(timer); worker.terminate() }
    worker.onerror = event => { finish(); reject(new Error(event.message)) }
    worker.onmessage = event => { finish(); event.data.error ? reject(new Error(event.data.error)) : resolve({ worker: event.data.worker, model: event.data.model, bytes: Array.from(new Uint8Array(event.data.bytes)) }) }
    const input = new Uint8Array(bytes).buffer
    worker.postMessage({ png: input, text }, [input])
  }), { bytes: Array.from(png), text: await readFile('Docs/samples/v0.3/办公导出.md', 'utf8') })
  report.generationMs = Date.now() - started
  assert.equal(result.worker, true)
  assert.deepEqual(result.model, { headings: [1, 2, 3, 4, 5, 6], images: 1, warnings: ['font_fallback'] })
  const bytes = Buffer.from(result.bytes)
  const require = createRequire(import.meta.url), docxRequire = createRequire(require.resolve('docx'))
  const JSZip = docxRequire('jszip'), zip = await JSZip.loadAsync(bytes, { checkCRC32: true })
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/_rels/document.xml.rels']) assert.ok(zip.file(name), `Missing ${name}`)
  const xmlEntries = await Promise.all(Object.keys(zip.files).filter(name => /\.(xml|rels)$/.test(name)).map(async name => ({ name, text: await zip.file(name).async('string') })))
  await page.evaluate(entries => {
    for (const { name, text } of entries) {
      const xml = new DOMParser().parseFromString(text, 'application/xml')
      if (xml.querySelector('parsererror')) throw new Error(`Invalid XML: ${name}`)
      for (const relation of xml.getElementsByTagName('Relationship')) {
        if (relation.getAttribute('Type')?.endsWith('/image') && relation.getAttribute('TargetMode') === 'External') throw new Error(`Remote image relationship: ${name}`)
      }
    }
  }, xmlEntries)
  const xml = await zip.file('word/document.xml').async('string'), numbering = await zip.file('word/numbering.xml').async('string'), rels = await zip.file('word/_rels/document.xml.rels').async('string')
  for (const text of ['中文办公🙂', '粗斜体', '单元格', 'Heading1', '<w:b', '<w:i', '<w:strike', '<w:tbl>', '<w:tblHeader', '<w:numPr>']) assert.ok(xml.includes(text), text)
  assert.match(numbering, /w:start w:val="3"/)
  assert.match(rels, /Target="https:\/\/example.com\/"/)
  const images = Object.keys(zip.files).filter(name => name.startsWith('word/media/') && !zip.files[name].dir)
  assert.equal(images.length, 1)
  assert.deepEqual(await zip.file(images[0]).async('nodebuffer'), png)
  assert.ok(!Object.keys(zip.files).some(name => /vba|oleObject|embeddings/i.test(name)))
  for (const entry of xmlEntries) assert.ok(!/javascript:|file:\/\/|Target="https?:[^"\n]+"[^>]+relationships\/image/i.test(entry.text))
  assert.deepEqual(errors, []); assert.deepEqual(remote, [])
  report.bundleBytes = bundle.length; report.outputBytes = bytes.length
  report.outputSha256 = createHash('sha256').update(bytes).digest('hex')
  report.bundleSha256 = createHash('sha256').update(bundle).digest('hex')
  report.zipEntries = Object.keys(zip.files).length
  report.checks = ['real Worker with application CSP', 'shared AST/model/resource preflight of frozen office fixture in Worker', 'no external bundle imports or network requests', 'UTF-8 Chinese/emoji', 'heading and inline styles', 'numbering start=3', 'native table/repeating header', 'embedded PNG exact bytes', 'safe hyperlink', 'CRC32 and valid XML', 'no macros/OLE/remote image relationships']
  await writeFile(resolve(output, 'probe.docx'), bytes)
  // The npm metadata understates the transitive development/runtime minimum.
  const nanoidPackage = JSON.parse(await readFile(resolve(dirname(docxRequire.resolve('nanoid')), 'package.json'), 'utf8'))
  report.transitiveNodeEngine = { package: 'nanoid', version: nanoidPackage.version, engine: nanoidPackage.engines.node }
  report.passed = true
  console.log(`DOCX ${report.version} browser Worker probe passed (${bytes.length} output bytes).`)
} catch (error) { report.error = error.stack; process.exitCode = 1 }
finally {
  await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
  await writeFile('test-results/docx-library-verification.json', JSON.stringify(report, null, 2) + '\n')
}
