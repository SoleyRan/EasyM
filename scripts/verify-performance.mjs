import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { cpus, totalmem, platform, release } from 'node:os'
import { chromium } from 'playwright'
import { serveProduction, acknowledgeGuide } from './serve-production.mjs'
import { productionWorkers, workerKind } from './production-workers.mjs'
import { fillSource } from './source-test-utils.mjs'

// Local baseline only. Event-to-next-frame measures UI latency, not physical screen/input latency.
const server = await serveProduction()
let browser
const report = { verifiedAt: new Date().toISOString(), machine: { os: platform(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryGiB: +(totalmem() / 2 ** 30).toFixed(1) }, cases: [] }
try {
  browser = await chromium.launch({ channel: process.env.EASYM_TEST_BROWSER || undefined })
  report.browser = await browser.version()
  const paragraph = 'Markdown office text with ordinary words and punctuation. '.repeat(12) + '\n\n'
  for (const [name, body] of [
    ['5 MiB text', ('# Large document\n\n' + paragraph.repeat(Math.ceil(5 * 1024 * 1024 / paragraph.length))).slice(0, 5 * 1024 * 1024)],
    ['100 KiB single line', 'x'.repeat(100 * 1024)],
  ]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    page.setDefaultTimeout(30000)
    await acknowledgeGuide(page)
  await page.goto(server.url)
    await page.getByRole('button', { name: 'EM 菜单', exact: true }).click()
    const [picker] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('menuitem', { name: '打开文件', exact: true }).click(),
    ])
    const start = Date.now()
    await picker.setFiles({ name: 'benchmark.md', mimeType: 'text/markdown', buffer: Buffer.from(body) })
    const editor = page.getByRole('textbox', { name: 'Markdown 源码编辑器' })
    await page.waitForFunction(() => !document.querySelector('.document-panel:not([hidden]) .content-grid')?.inert && document.querySelector('.document-panel:not([hidden]) .statusbar')?.textContent.includes('文件已打开'))
    const openMs = Date.now() - start
    await editor.click()
    await page.keyboard.press('Control+Home')
    await page.evaluate(() => {
      window.__latencies = []
      const editor = document.querySelector('.document-panel:not([hidden]) .cm-content')
      editor.addEventListener('keydown', (event) => {
        if (event.key !== 'a') return
        const start = performance.now()
        requestAnimationFrame(() => window.__latencies.push(performance.now() - start))
      })
    })
    for (let i = 0; i < 40; i++) { await page.keyboard.press('a'); await page.waitForTimeout(80) }
    const samples = await page.evaluate(() => window.__latencies)
    assert.equal(samples.length, 40)
    samples.sort((a, b) => a - b)
    const p95Ms = +samples[Math.ceil(samples.length * 0.95) - 1].toFixed(2)
    const highlightLimited = await page.locator('.document-panel:not([hidden]) .statusbar').textContent().then(text => text.includes('源码高亮已暂停'))
    assert.equal(highlightLimited, name === '100 KiB single line')
    report.cases.push({ name, bytes: Buffer.byteLength(body), openMs, inputSamples: samples.length, inputEventToNextFrameP95Ms: p95Ms, targetMs: 50, targetMet: p95Ms <= 50, sourceHighlightLimited: highlightLimited })
    if (highlightLimited) {
      // Undo restores the full file; shortening it reinstates Markdown support
      // in the same editor, and undoing the replacement reinstates the guard.
      for (let i = 0; i < 40; i++) await page.keyboard.press('Control+z')
      await page.keyboard.press('Control+a')
      await page.keyboard.insertText('# Short heading')
      await page.waitForFunction(() => !document.querySelector('.document-panel:not([hidden]) .statusbar').textContent.includes('源码高亮已暂停'))
      await page.locator('.document-panel:not([hidden]) .syntax-heading').first().waitFor()
      await page.keyboard.press('Control+z')
      await page.waitForFunction(() => document.querySelector('.document-panel:not([hidden]) .statusbar').textContent.includes('源码高亮已暂停'))
      await page.getByRole('button', { name: '分屏', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('.document-panel:not([hidden]) .preview')?.textContent === 'x'.repeat(100 * 1024))
      report.cases.at(-1).fullPreviewAndUndoVerified = true
    }
    console.log(`${name}: open ${openMs} ms, input p95 ${p95Ms} ms`)
    await context.close()
  }

  // At the simultaneous cell/column limits: 20 columns, 99 body rows.
  // A separate fixture exercises the 200-body-row limit with 9 columns.
  const tableContext = await browser.newContext({ viewport: { width: 1440, height: 900 } }), tablePage = await tableContext.newPage()
  await acknowledgeGuide(tablePage); await tablePage.goto(server.url)
  const row = count => '| ' + Array.from({ length: count }, (_, i) => `cell ${i}`).join(' | ') + ' |'
  for (const [rows, columns] of [[100, 20], [201, 9]]) {
    const text = [row(columns), '| ' + Array(columns).fill('---').join(' | ') + ' |', ...Array(rows - 1).fill(row(columns))].join('\n')
    await fillSource(tablePage, text); await tablePage.getByRole('textbox', { name: 'Markdown 源码编辑器' }).press('Control+Home')
    const start = Date.now(); await tablePage.getByRole('button', { name: '编辑表格', exact: true }).click()
    const input = tablePage.getByRole('textbox', { name: '单元格 Markdown', exact: true }); await input.waitFor()
    const openMs = Date.now() - start
    const table = tablePage.getByRole('dialog', { name: '编辑表格', exact: true })
    const scrollStart = Date.now(); await table.getByRole('button', { name: `正文第 ${rows - 1} 行 第 ${columns} 列`, exact: true }).click()
    assert.equal(await input.inputValue(), `cell ${columns - 1}`)
    report.cases.push({ name: 'table limit', rowsIncludingHeader: rows, columns, cells: rows * columns, bytes: Buffer.byteLength(text), openMs, lastCellScrollAndSelectMs: Date.now() - scrollStart, scope: 'wall time includes Playwright interaction; no physical input or native WebView timing' })
    await table.getByRole('button', { name: '取消输入', exact: true }).click()
  }
  await fillSource(tablePage, 'hello world\n\n' + Array.from({ length: 500 }, (_, i) => `paragraph ${i}`).join('\n\n'))
  const source = tablePage.getByRole('textbox', { name: 'Markdown 源码编辑器' }), floating = tablePage.getByRole('toolbar', { name: '选区格式工具栏', exact: true })
  const times = []
  for (let i = 0; i < 10; i++) {
    await source.press('Control+Home'); await tablePage.waitForTimeout(150); const start = Date.now(); await source.press('Shift+End'); await floating.waitFor()
    times.push(Date.now() - start)
    const box = await floating.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 1440 && box.y >= 0 && box.y + box.height <= 900)
    const rect = await source.boundingBox(); await tablePage.mouse.move(rect.x + 100, rect.y + 100); await tablePage.mouse.wheel(0, 600); await floating.waitFor({ state: 'detached' })
  }
  report.cases.push({ name: 'selection overlay positioning and scroll dismissal', samples: times.length, wallTimeToVisibleP95Ms: times.sort((a,b) => a-b)[Math.ceil(times.length * .95) - 1], intentionalDebounceMs: 160, bounded: true, scrollDismissed: true, scope: 'UI wall time includes debounce and automation; not input-to-frame p95' })
  await tableContext.close()

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.setDefaultTimeout(60000)
  await acknowledgeGuide(page)
  await page.goto(server.url)
  await page.waitForFunction(() => !document.querySelector('.document-panel:not([hidden]) .content-grid')?.inert)
  await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(800, 600)
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#2476a7'; ctx.fillRect(0, 0, 800, 600)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    const assets = {}, instances = [], lines = ['# 100 images', '']
    for (let i = 0; i < 100; i++) {
      const instanceId = `bench-${i}`, path = `assets/img-${instanceId}.png`, sourcePath = `assets/.originals/img-${instanceId}-source.png`
      assets[path] = blob; assets[sourcePath] = blob
      instances.push({ instanceId, documentId: null, sourcePath, sourceHash: 'benchmark-only', displayPath: path, referenceRevision: 1, recipe: { version: 1, orientationNormalized: true, rotateDegrees: 0, flipHorizontal: false, flipVertical: false, output: { mime: 'image/png' } } })
      lines.push(`![image ${i}](${path})`, '')
    }
    const text = lines.join('\n'), bytes = new TextEncoder().encode(text)
    await new Promise((resolve, reject) => {
      const open = indexedDB.open('easym-drafts', 1)
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('drafts', 'readwrite')
        tx.objectStore('drafts').put({ version: 1, name: 'images.md', text, snapshot: { text, originalText: text, originalBytes: bytes, encoding: 'utf-8', lineEnding: 'lf' }, resources: { assets, instances }, updatedAt: Date.now() }, 'current')
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => { db.close(); reject(tx.error) }
      }
      open.onerror = () => reject(open.error)
    })
  })
  const imagesStart = Date.now()
  await page.reload()
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click()
  await page.getByRole('button', { name: '分屏', exact: true }).click()
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('.preview img')]
    return images.length === 100 && images.every((image) => image.complete && image.naturalWidth === 800 && image.naturalHeight === 600)
  })
  report.cases.push({ name: '100 local 800×600 images', restoreAndDecodeMs: Date.now() - imagesStart, imageCount: 100, allDecoded: true })
  const workerSource = (await productionWorkers()).find((source) => workerKind(source) === 'image')
  const boundaries = await page.evaluate(async (source) => {
    const canvas = new OffscreenCanvas(800, 600), ctx = canvas.getContext('2d')
    ctx.fillRect(0, 0, 800, 600)
    const png = await canvas.convertToBlob({ type: 'image/png' })
    const boundary = new Blob([png, new Uint8Array(20 * 1024 * 1024 - png.size)], { type: 'image/png' })
    async function run(blob) {
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' })), worker = new Worker(url), start = performance.now()
      try {
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Worker boundary test timed out')), 15000)
          worker.onerror = () => { clearTimeout(timer); reject(new Error('Worker crashed')) }
          worker.onmessage = (event) => { clearTimeout(timer); resolve({ durationMs: +(performance.now() - start).toFixed(2), width: event.data.width, height: event.data.height, error: event.data.error }) }
          worker.postMessage({ source: blob })
        })
      } finally { worker.terminate(); URL.revokeObjectURL(url) }
    }
    return { boundaryBytes: boundary.size, accepted: await run(boundary), rejected: await run(new Blob([boundary, new Uint8Array(1)], { type: 'image/png' })) }
  }, workerSource)
  assert.equal(boundaries.accepted.width, 800); assert.equal(boundaries.accepted.height, 600)
  assert.equal(boundaries.accepted.error, undefined)
  assert.ok(boundaries.rejected.error.includes('20 MB'))
  report.cases.push({ name: '20 MiB PNG byte boundary (padded 800×600 fixture)', ...boundaries })
  await context.close()
  assert.ok(report.cases.filter(item => 'targetMet' in item).every(item => item.targetMet), 'Input-to-next-frame p95 exceeds the frozen 50 ms target')
  report.passed = true
  console.log(JSON.stringify(report, null, 2))
} finally {
  await mkdir('test-results', { recursive: true })
  await writeFile('test-results/performance-verification.json', JSON.stringify(report, null, 2) + '\n')
  await browser?.close()
  await server.close()
}
