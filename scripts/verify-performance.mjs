import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { cpus, totalmem, platform, release } from 'node:os'
import { chromium } from 'playwright'
import { serveProduction } from './serve-production.mjs'
import { productionWorkers } from './production-workers.mjs'

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
    await page.goto(server.url)
    const [picker] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: /打开文件/ }).click(),
    ])
    const start = Date.now()
    await picker.setFiles({ name: 'benchmark.md', mimeType: 'text/markdown', buffer: Buffer.from(body) })
    const editor = page.getByRole('textbox', { name: 'Markdown 源码编辑器' })
    await page.waitForFunction(() => !document.querySelector('.content-grid')?.inert && document.querySelector('.statusbar')?.textContent.includes('文件已打开'))
    const openMs = Date.now() - start
    await editor.click()
    await page.keyboard.press('Control+Home')
    await page.evaluate(() => {
      window.__latencies = []
      const editor = document.querySelector('.cm-content')
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
    report.cases.push({ name, bytes: Buffer.byteLength(body), openMs, inputSamples: samples.length, inputEventToNextFrameP95Ms: p95Ms, targetMs: 50, targetMet: p95Ms <= 50 })
    console.log(`${name}: open ${openMs} ms, input p95 ${p95Ms} ms`)
    await context.close()
  }

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.setDefaultTimeout(60000)
  await page.goto(server.url)
  await page.waitForFunction(() => !document.querySelector('.content-grid')?.inert)
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
  const workerSource = (await productionWorkers()).find((source) => source.includes('createImageBitmap'))
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
  console.log(JSON.stringify(report, null, 2))
} finally {
  await mkdir('test-results', { recursive: true })
  await writeFile('test-results/performance-verification.json', JSON.stringify(report, null, 2) + '\n')
  await browser?.close()
  await server.close()
}
