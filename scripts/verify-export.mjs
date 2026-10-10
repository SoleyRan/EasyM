import assert from 'node:assert/strict'
import { fillSource } from './source-test-utils.mjs'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { pathToFileURL } from 'node:url'
import { serveProduction } from './serve-production.mjs'

const server = await serveProduction()
let browser
try {
  browser = await chromium.launch({ channel: process.env.EASYM_TEST_BROWSER || undefined })
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  const errors = [], remoteRequests = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (/evil\.example/.test(request.url())) remoteRequests.push(request.url()) })
  page.on('dialog', dialog => { void (dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss()) })
  await page.addInitScript(() => { window.print = () => { globalThis.printCalls = (globalThis.printCalls || 0) + 1 } })
  await page.goto(server.url)
  const editor = page.getByRole('textbox', { name: 'Markdown 源码编辑器' })
  const source = () => editor.evaluate(element => [...element.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'))
  const action = async name => {
    await page.getByRole('button', { name: 'EM 菜单', exact: true }).click()
    await page.getByRole('menuitem', { name, exact: true }).click()
  }
  // Immediate export after an edit must not use the debounced preview's old body.
  await fillSource(page, '# 中文导出\n\n**latest**\n\n<script>globalThis.exportExecuted=true</script>\n\n[unsafe](javascript:alert%281%29)\n\n![remote](https://evil.example/track.png)\n\n![missing](gone.png)\n\n|甲|乙|\n|---|---|\n|一|二|\n\n```js\nconst value = "中文"\n```')
  const downloadEvent = page.waitForEvent('download'); await action('导出 HTML')
  const download = await downloadEvent
  assert.equal(download.suggestedFilename(), '未命名.html')
  await mkdir('test-results', { recursive: true })
  const filePath = `${process.cwd()}/test-results/export-standalone.html`
  await download.saveAs(filePath)
  const html = await readFile(filePath, 'utf8')
  assert.ok(html.includes('<strong>latest</strong>'))
  assert.ok(!html.includes('data-source-from'))
  assert.ok((await page.getByRole('tab', { selected: true }).textContent()).includes('*'))
  assert.ok((await page.locator('.document-panel:not([hidden]) [role=alert]').textContent()).includes('2 项图片'))
  assert.ok((await source()).includes('<script>'))
  // Open the delivered standalone file: it should render with no network requests/scripts.
  const standalone = await browser.newPage()
  const external = []
  standalone.on('request', request => { if (/^https?:/.test(request.url())) external.push(request.url()) })
  await standalone.goto(pathToFileURL(filePath).href)
  assert.equal(await standalone.locator('h1').textContent(), '中文导出')
  assert.equal(await standalone.locator('script').count(), 0)
  assert.equal(await standalone.locator('a[href^="javascript"]').count(), 0)
  assert.equal(await standalone.locator('.missing-image').count(), 2)
  assert.equal(await standalone.evaluate(() => globalThis.exportExecuted), undefined)
  assert.equal(await standalone.locator('td').first().evaluate(element => getComputedStyle(element).borderTopWidth), '1px')
  await standalone.screenshot({ path: 'test-results/export-standalone.png', fullPage: true })
  assert.deepEqual(external, [])
  await standalone.close()
  // Use real image import so the output embeds draft assets, requiring no disk session.
  const png = Buffer.from(await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(160, 80), context = canvas.getContext('2d')
    context.fillStyle = '#2862ad'; context.fillRect(0, 0, 160, 80)
    context.fillStyle = 'white'; context.font = '30px sans-serif'; context.fillText('EM', 52, 50)
    return Array.from(new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()))
  }))
  await page.locator('.document-panel:not([hidden]) input[type=file][accept="image/png,image/jpeg"]').setInputFiles({ name: 'tiny.png', mimeType: 'image/png', buffer: png })
  await page.getByRole('button', { name: '应用修改', exact: true }).click()
  await page.locator('.preview img[data-resource^="assets/"]').waitFor()
  const imageDownload = page.waitForEvent('download'); await action('导出 HTML')
  const imageOutput = await imageDownload; await imageOutput.saveAs(filePath)
  const imageHtml = await readFile(filePath, 'utf8')
  assert.match(imageHtml, /src="data:image\/png;base64,/)
  const beforePrint = await source()
  await page.keyboard.press('Control+p')
  await page.locator('.print-dialog').waitFor()
  assert.equal(await page.locator('#easym-print-root img').evaluate(image => image.src.startsWith('data:image/png;base64,')), true)
  assert.equal(await page.getByRole('button', { name: '返回编辑', exact: true }).evaluate(element => element === document.activeElement), true)
  await page.keyboard.press('Shift+Tab')
  assert.equal(await page.getByRole('button', { name: '打开系统打印', exact: true }).evaluate(element => element === document.activeElement), true)
  await page.getByRole('button', { name: '打开系统打印', exact: true }).click()
  await page.waitForFunction(() => globalThis.printCalls === 1)
  await page.screenshot({ path: 'test-results/export-print-preview.png' })
  await page.emulateMedia({ media: 'print' })
  assert.equal(await page.locator('#root').evaluate(element => getComputedStyle(element).display), 'none')
  assert.equal(await page.locator('#easym-print-root').evaluate(element => getComputedStyle(element).position), 'static')
  await page.screenshot({ path: 'test-results/export-print-media.png', fullPage: true })
  await page.pdf({ path: 'test-results/export-print.pdf', format: 'A4', printBackground: true })
  await page.emulateMedia({ media: 'screen' }); await page.keyboard.press('Escape')
  assert.equal(await page.locator('#easym-print-root').count(), 0)
  assert.equal(await source(), beforePrint)
  // Multi-page output exercises headers, tables, long code, Chinese and page rules.
  const long = '# 多页中文\n\n' + Array.from({ length: 45 }, (_, i) => `## 第 ${i + 1} 节\n\n中文段落 ${'内容与分页 '.repeat(20)}\n\n|列一|列二|\n|---|---|\n|中文|${i + 1}|`).join('\n\n') + '\n\n```text\n' + '很长的代码'.repeat(100) + '\n```'
  await fillSource(page, long); await action('打印文档'); await page.locator('.print-dialog').waitFor()
  await page.waitForFunction(() => document.body.classList.contains('easym-print-ready') && document.querySelector('#easym-print-root h1')?.textContent === '多页中文')
  await page.emulateMedia({ media: 'print' })
  await page.pdf({ path: 'test-results/export-multipage.pdf', format: 'A4', printBackground: true })
  const pdf = await readFile('test-results/export-multipage.pdf')
  const pageCount = [...pdf.toString('latin1').matchAll(/\/Type\s*\/Page\b/g)].length
  assert.ok(pageCount > 3, `Expected multiple pages, got ${pageCount}`)
  await page.emulateMedia({ media: 'screen' })
  await page.getByRole('button', { name: '返回编辑', exact: true }).click()
  // CodeMirror virtualizes long sources; verify the full post-print body through
  // a fresh export rather than reading only the currently visible .cm-line nodes.
  const afterPrintDownload = page.waitForEvent('download'); await action('导出 HTML')
  await (await afterPrintDownload).saveAs('test-results/export-after-print.html')
  const afterPrint = await readFile('test-results/export-after-print.html', 'utf8')
  assert.equal((afterPrint.match(/<h2>/g) ?? []).length, 45)
  assert.equal((afterPrint.match(/<table>/g) ?? []).length, 45)
  assert.ok(afterPrint.includes('很长的代码'.repeat(100)))
  assert.deepEqual(remoteRequests, []); assert.deepEqual(errors, [])
  const report = { stage: 'v0.2-step-5', verifiedAt: new Date().toISOString(), browser: await browser.version(), passed: true, pageCount, checks: ['exact current Markdown exported without mutating source/dirty state', 'standalone HTML file rendering with strict CSP', 'no scripts, unsafe href or remote resource requests', 'missing image placeholders/warnings', 'real imported PNG embedded as data URL', 'print entry, Ctrl+P, focus cycling and Escape', 'system print call exercised via browser stub', 'print media hides app and displays only body', 'Chinese, headings, bordered tables and code styles', 'multi-page A4 PDF generation'], pending: ['native Windows save dialog and WebView2 print UI', 'macOS WKWebView and Linux WebKitGTK real print pagination'] }
  await writeFile('test-results/export-verification.json', JSON.stringify(report, null, 2) + '\n')
  console.log(`Export/print verification passed; multi-page PDF: ${pageCount} pages.`)
} finally { await browser?.close(); await server.close() }
