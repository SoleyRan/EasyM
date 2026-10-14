import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cpus, totalmem, release } from 'node:os'
import { build } from 'vite'
import { chromium } from 'playwright'

const output = resolve('test-results/pdf-engines'), tools = resolve(output, 'tools')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const exec = promisify(execFile)
async function browserMemory(browser) {
  const session = await browser.newBrowserCDPSession()
  try {
    const { processInfo } = await session.send('SystemInfo.getProcessInfo')
    const ids = processInfo.map(item => Number(item.id)).filter(Number.isSafeInteger)
    if (process.platform === 'win32') {
      const { stdout } = await exec('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | Measure-Object -Property WorkingSet64 -Sum).Sum`], { windowsHide: true })
      return Number(stdout.trim())
    }
    const { stdout } = await exec('ps', ['-o', 'rss=', '-p', ids.join(',')])
    return stdout.trim().split(/\s+/).reduce((sum, value) => sum + Number(value) * 1024, 0)
  } finally { await session.detach() }
}
await mkdir(output, { recursive: true })
for (const [name, version] of [['pagedjs', '0.4.3'], ['pdfmake', '0.3.11']]) {
  assert.equal(JSON.parse(await readFile(resolve(tools, 'node_modules', name, 'package.json'), 'utf8')).version, version)
}
const office = await readFile('Docs/samples/v0.3/办公导出.md', 'utf8')
const safety = await readFile('Docs/samples/v0.3/降级与安全.md', 'utf8')
const stress = '# PDF 分页压力样例\n\n中文换行、English、emoji 🙂 🚀 ✅。\n\n' +
  Array.from({ length: 12 }, (_, i) => `## 标题-${i + 1}\n\n段落-${i + 1} ${'中文换行不能丢字，English words and wrapping。'.repeat(9)}`).join('\n\n') +
  '\n\n## 跨页表格\n\n|ROW-ID|中文表头|数量|\n|---|---|---:|\n' +
  Array.from({ length: 85 }, (_, i) => `|ROW-${String(i + 1).padStart(3, '0')}|表格内容中文 ${'换行测试'.repeat(4)}|${i + 1}|`).join('\n') +
  '\n\n## 长代码\n\n```text\n' + Array.from({ length: 60 }, (_, i) => `CODE-${String(i + 1).padStart(3, '0')} 中文代码保留缩进    const x = ${i};`).join('\n') +
  '\nLONG-BEGIN ' + '中文代码LongToken'.repeat(90) + ' LONG-END\n```\n\n## 大图片\n\n![整图上下边缘](assets/tall.png)\n\n## 结束标题\n\nFINAL-SENTINEL 中文结束。\n'
await writeFile(resolve(output, 'stress.md'), stress)
const report = { stage: 'v0.3-step6', verifiedAt: new Date().toISOString(), node: process.version, platform: process.platform, inputSha256: { office: hash(office), safety: hash(safety), stress: hash(stress) }, candidates: {}, runs: [], networkRequests: [], errors: [] }
report.machine = { release: release(), cpu: cpus()[0].model, logicalCpus: cpus().length, memoryGiB: +(totalmem() / 2 ** 30).toFixed(1) }
for (const [name, bundle] of [['pagedjs', 'dist/paged.min.js'], ['pdfmake', 'build/pdfmake.min.js']]) {
  const bytes = await readFile(resolve(tools, 'node_modules', name, bundle))
  const license = await readFile(resolve(tools, 'node_modules', name, name === 'pagedjs' ? 'LICENSE.md' : 'LICENSE'))
  report.candidates[name] = { version: name === 'pagedjs' ? '0.4.3' : '0.3.11', bundleBytes: bytes.length, bundleSha256: hash(bytes), gzipBytes: (await import('node:zlib')).gzipSync(bytes).length, licenseSha256: hash(license), license: 'MIT' }
}
const font = resolve(tools, 'NotoSansSC-Regular.otf')
report.font = { name: 'NotoSansSC-Regular', bytes: (await stat(font)).size, sha256: hash(await readFile(font)), license: 'SIL OFL 1.1', licenseSha256: hash(await readFile(resolve(tools, 'Noto-LICENSE.txt'))) }
await build({ configFile: resolve('vite.config.ts'), logLevel: 'warn', build: { outDir: output, emptyOutDir: false, lib: { entry: resolve('scripts/fixtures/pdf-engine-probe.ts'), formats: ['iife'], name: 'PDFProbe', fileName: () => 'probe.js' } } })
const bundle = await readFile(resolve(output, 'probe.js'))
const paged = await readFile(resolve(tools, 'node_modules/pagedjs/dist/paged.min.js'))
const pdfmakeBrowser = await readFile(resolve(tools, 'node_modules/pdfmake/build/pdfmake.min.js'))
const csp = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8')).app.security.csp
const server = createServer((req, res) => {
  res.setHeader('Content-Security-Policy', csp)
  if (['/probe.js', '/paged.js', '/pdfmake.js'].includes(req.url)) { res.setHeader('Content-Type', 'text/javascript'); res.end(req.url === '/probe.js' ? bundle : req.url === '/paged.js' ? paged : pdfmakeBrowser) }
  else res.end('<!doctype html><meta charset="utf-8"><script src="/probe.js"></script>')
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`
const started = performance.now()
let browser
const structured = (data, cancel = false) => new Promise((done, reject) => {
  const worker = new Worker(new URL('./pdfmake-evaluation-worker.mjs', import.meta.url), { workerData: { ...data, font: data.font ?? font, packageJson: resolve(tools, 'package.json') } })
  let startupMs, definition
  const timer = setTimeout(() => { void worker.terminate(); reject(new Error('PDF worker timeout')) }, 60_000)
  worker.on('error', error => { clearTimeout(timer); reject(error) })
  worker.on('message', async message => {
    if (message.ready) {
      startupMs = message.startupMs
      definition = message.definition
      if (cancel) { const time = performance.now(); await worker.terminate(); clearTimeout(timer); done({ cancelled: true, cancellationMs: performance.now() - time }); }
    } else { clearTimeout(timer); await worker.terminate(); done({ ...message, startupMs, definition }); }
  })
})
try {
  browser = await chromium.launch({ channel: process.env.EASYM_TEST_BROWSER || undefined })
  report.browserLaunchMs = performance.now() - started
  report.browser = browser.version()
  const context = await browser.newContext()
  await context.route('**/*', route => {
    if (route.request().url().startsWith(origin + '/') || route.request().url().startsWith('data:')) return route.continue()
    report.networkRequests.push(route.request().url()); return route.abort()
  })
  const probe = await context.newPage(); await probe.goto(origin)
  const imageBytes = await readFile('Docs/samples/v0.3/assets/em.png')
  const images = { 'assets/em.png': `data:image/png;base64,${imageBytes.toString('base64')}` }
  images['assets/tall.png'] = await probe.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 900; c.height = 1800
    const ctx = c.getContext('2d'); ctx.fillStyle = '#2862ad'; ctx.fillRect(0, 0, c.width, c.height)
    ctx.fillStyle = 'white'; ctx.font = '70px sans-serif'; ctx.fillText('IMAGE TOP', 80, 110); ctx.fillText('IMAGE BOTTOM', 80, 1710)
    return c.toDataURL('image/png')
  })
  for (const [fixture, text] of [['office', office], ['safety', safety], ['stress', stress]]) {
    const input = await probe.evaluate(({ text, images }) => globalThis.pdfProbe(text, images), { text, images })
    report[`${fixture}Warnings`] = input.warnings
    report[`${fixture}ModelWarnings`] = input.model.warnings
    await writeFile(resolve(output, `${fixture}.html`), input.html)
    for (const format of ['A4', 'Letter']) {
      for (const engine of ['system-css', 'pagedjs']) {
        const page = await context.newPage(); page.on('pageerror', error => report.errors.push({ engine, fixture, error: error.message }))
        await page.goto(origin)
        // Same production-sanitized body/styles; harness adds only trusted evaluation scripts.
        await page.evaluate(html => { const doc = new DOMParser().parseFromString(html, 'text/html'); document.head.append(...doc.querySelectorAll('style')); document.body.innerHTML = doc.body.innerHTML }, input.html)
        await page.addStyleTag({ content: `@page { size: ${format}; }` })
        await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(image => image.decode())) })
        const memoryBeforeBytes = fixture === 'stress' ? await browserMemory(browser) : undefined
        const begin = performance.now()
        let pages
        if (engine === 'pagedjs') {
          await page.addScriptTag({ url: origin + '/paged.js' })
          pages = await page.evaluate(async () => {
            const flow = await new PagedModule.Previewer().preview()
            return flow.total
          })
        }
        const filename = `${engine}-${fixture}-${format}.pdf`
        await page.pdf({ path: resolve(output, filename), format, preferCSSPageSize: true, printBackground: true })
        const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable')
        const metrics = await cdp.send('Performance.getMetrics')
        const bytes = await readFile(resolve(output, filename))
        report.runs.push({ engine, fixture, format, filename, paginationPages: pages, generationMs: performance.now() - begin, rendererJsHeapBytesAfterGeneration: metrics.metrics.find(metric => metric.name === 'JSHeapUsedSize')?.value, bytes: bytes.length, sha256: hash(bytes) })
        if (fixture === 'stress') report.runs.at(-1).browserWorkingSet = { beforeBytes: memoryBeforeBytes, afterBytes: await browserMemory(browser), metric: 'sum of browser-process working sets at two points, shared pages may be counted twice; not a peak' }
        await page.close()
      }
      const result = await structured({ model: input.model, images, format })
      assert.ok(!result.error, result.error)
      const filename = `pdfmake-${fixture}-${format}.pdf`, bytes = Buffer.from(result.bytes)
      await writeFile(resolve(output, filename), bytes)
      report.runs.push({ engine: 'pdfmake', fixture, format, filename, startupMs: result.startupMs, generationMs: result.generationMs, processPeakRssBytes: result.peakRssBytes, bytes: bytes.length, sha256: hash(bytes) })
    }
  }
  const input = await probe.evaluate(({ text, images }) => globalThis.pdfProbe(text, images), { text: stress, images })
  report.workerCancellation = await structured({ model: input.model, images, format: 'A4' }, true)
  report.invalidFont = await structured({ model: input.model, images, format: 'A4', font: resolve(tools, 'does-not-exist.otf') })
  assert.ok(report.invalidFont.error)
  const recovered = await structured({ model: input.model, images, format: 'A4' })
  report.recoveryAfterError = { passed: !recovered.error, outputBytes: recovered.bytes?.length }
  report.browserWorker = await probe.evaluate(async ({ definition, fontBase64, origin }) => {
    const code = `importScripts(${JSON.stringify(origin + '/pdfmake.js')}); postMessage({ready:true}); onmessage = async event => { try { pdfMake.setUrlAccessPolicy(() => false); pdfMake.addVirtualFileSystem({'Noto.otf':event.data.fontBase64}); pdfMake.addFonts({Noto:{normal:'Noto.otf',bold:'Noto.otf',italics:'Noto.otf',bolditalics:'Noto.otf'}}); const start = performance.now(); const output = await pdfMake.createPdf(event.data.definition).getBuffer(); postMessage({bytes: output.length, generationMs:performance.now()-start}); } catch(error) { postMessage({error:error.message}); } }`
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' })), begin = performance.now()
    return new Promise((done, reject) => {
      const worker = new Worker(url), timer = setTimeout(() => { worker.terminate(); URL.revokeObjectURL(url); reject(new Error('Browser Worker timeout')) }, 60_000)
      let startupMs
      const finish = () => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url) }
      worker.onerror = event => { finish(); reject(new Error(event.message)) }
      worker.onmessage = event => {
        if (event.data.ready) { startupMs = performance.now() - begin; worker.postMessage({ definition, fontBase64 }) }
        else { finish(); done({ ...event.data, startupMs, applicationCsp: true }) }
      }
    })
  }, { definition: recovered.definition, fontBase64: (await readFile(font)).toString('base64'), origin })
  assert.ok(report.browserWorker.bytes && !report.browserWorker.error, JSON.stringify(report.browserWorker))
  // HTML pagination can be cancelled by destroying its isolated document.
  const cancelledPage = await context.newPage(); await cancelledPage.goto(origin)
  await cancelledPage.addScriptTag({ url: origin + '/paged.js' })
  await cancelledPage.evaluate(text => { document.body.innerHTML = '<main class="export-document"></main>'; document.querySelector('main').textContent = text.repeat(100); globalThis.pending = new PagedModule.Previewer().preview() }, stress)
  const cancelStarted = performance.now(); await cancelledPage.close()
  report.htmlCancellation = { isolatedPageClosed: true, cancellationMs: performance.now() - cancelStarted, noPDFWritten: true }
  report.passed = report.errors.length === 0 && report.networkRequests.length === 0 && report.recoveryAfterError.passed
  assert.equal(report.passed, true)
} catch (error) { report.failure = error.stack; process.exitCode = 1 }
finally {
  await browser?.close(); await new Promise(done => server.close(done))
  const lock = await readFile(resolve(tools, 'package-lock.json'))
  report.evaluationLockSha256 = hash(lock)
  await writeFile(resolve(output, 'generation.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ passed: report.passed, outputs: report.runs.length, failure: report.failure }))
}
