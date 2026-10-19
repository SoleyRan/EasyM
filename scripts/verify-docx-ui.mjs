import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cpus, totalmem, release } from 'node:os'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { serveProduction, acknowledgeGuide, selectAppearanceTheme } from './serve-production.mjs'
import { fillSource } from './source-test-utils.mjs'

const output = 'test-results/docx-ui', server = await serveProduction()
const report = { stage: 'v0.3-step3c', verifiedAt: new Date().toISOString(), platform: process.platform, passed: false, checks: [] }
report.machine = { osRelease: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryGiB: +(totalmem() / 2 ** 30).toFixed(1) }
const exec = promisify(execFile), require = createRequire(import.meta.url)
const JSZip = createRequire(require.resolve('docx'))('jszip')
await mkdir(output, { recursive: true })
let browser
try {
  browser = await chromium.launch({ channel: process.env.EASYM_TEST_BROWSER || undefined })
  report.browser = browser.version()
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } }), errors = [], remote = [], requests = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { requests.push(request.url()); if (/^https?:\/\//.test(request.url()) && !request.url().startsWith(server.url)) remote.push(request.url()) })
  await page.addInitScript(() => {
    const OriginalWorker = window.Worker
    window.docxWorkerMode = ''; window.docxWorkerStats = { held: 0, terminated: 0 }
    window.Worker = class extends OriginalWorker {
      postMessage(message, ...args) {
        if (['parse', 'generate'].includes(message.type) && window.docxWorkerMode === message.type) {
          window.docxWorkerStats.held++; this.held = true; return
        }
        if (message.type === 'generate' && window.docxWorkerMode === 'fail') {
          queueMicrotask(() => this.onmessage?.({ data: { error: { message: '测试生成失败', name: 'Error' } } })); return
        }
        super.postMessage(message, ...args)
      }
      terminate() { if (this.held) window.docxWorkerStats.terminated++; super.terminate() }
    }
  })
  await acknowledgeGuide(page)
  await page.goto(server.url)
  const editor = page.getByRole('textbox', { name: 'Markdown 源码编辑器' })
  const source = () => editor.evaluate(element => [...element.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'))
  const draftText = async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await page.waitForFunction(() => document.querySelector('.document-panel:not([hidden]) .statusbar')?.textContent.includes('草稿已保存'))
    return page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('easym-drafts', 1)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result, transaction = db.transaction('drafts'), value = transaction.objectStore('drafts').get('current')
        transaction.oncomplete = () => { db.close(); resolve(value.result?.text) }
        transaction.onerror = () => { db.close(); reject(transaction.error) }
      }
    }))
  }
  const action = async () => {
    await page.getByRole('button', { name: 'EM 菜单', exact: true }).click()
    await page.getByRole('menuitem', { name: '导出', exact: true }).click()
    await page.getByRole('menuitem', { name: 'DOCX', exact: true }).click()
  }
  const ready = () => page.waitForFunction(() => document.querySelector('.docx-dialog [role=status]')?.textContent.includes('预检完成'))
  const dialog = page.getByRole('dialog', { name: '导出 DOCX', exact: true })
  const generate = () => dialog.getByRole('button', { name: '生成 DOCX', exact: true }).click()
  const download = async name => {
    const next = page.waitForEvent('download'); await generate(); const file = await next
    assert.equal(file.suggestedFilename(), '未命名.docx')
    const path = `${output}/${name}.docx`; await file.saveAs(path); await dialog.waitFor({ state: 'hidden' })
    return JSZip.loadAsync(await readFile(path), { checkCRC32: true })
  }
  const original = '# 未保存的中文\n\n**粗体**与 *斜体*\n\n|标题|数值|\n|---|---|\n|甲|42|\n\n```rust\nlet value = 1;\n```'
  await fillSource(page, original)
  assert.ok(!requests.some(url => /\/docx-[^/]+\.js$/.test(url)), 'DOCX must not load at startup')
  await action(); await ready()
  assert.ok(requests.some(url => /\/docx-[^/]+\.js$/.test(url)), 'DOCX must load when requested')
  assert.equal(await dialog.getByRole('combobox', { name: 'DOCX 纸张' }).inputValue(), 'a4')
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'DOCX 纸张')
  await page.keyboard.press('Shift+Tab')
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), '生成 DOCX')
  await dialog.getByRole('combobox', { name: 'DOCX 纸张' }).selectOption('letter')
  await dialog.getByRole('combobox', { name: 'DOCX 办公样式' }).selectOption('compact')
  const zip = await download('letter-compact'), xml = await zip.file('word/document.xml').async('string')
  assert.match(xml, /未保存的中文/); assert.match(xml, /<w:tbl>/); assert.match(xml, /w:w="12240"/)
  assert.equal(await source(), original); assert.ok((await page.getByRole('tab', { selected: true }).textContent()).includes('*'))
  await page.getByRole('textbox', { name: 'Markdown 源码编辑器' }).press('ControlOrMeta+z')
  assert.notEqual(await source(), original)
  await page.getByRole('button', { name: '重做', exact: true }).click(); assert.equal(await source(), original)
  report.checks.push('lazy loading; real Worker export; Letter/compact; current unsaved source, dirty and undo preserved; focus trap')

  const missing = '# 图片\n\n![缺失](missing.png)\n\n![远程](https://evil.example/track.png)'
  await fillSource(page, missing); await action(); await ready()
  assert.equal(await dialog.getByRole('button', { name: '生成 DOCX' }).isDisabled(), true)
  assert.equal(await dialog.getByRole('button', { name: '第 3 行 · 第 1 列 · 定位' }).count(), 1)
  await dialog.getByRole('button', { name: '第 3 行 · 第 1 列 · 定位' }).click(); await dialog.waitFor({ state: 'hidden' })
  assert.equal(await source(), missing)
  assert.equal(await editor.evaluate(element => element.closest('.app-shell').inert), false)
  await action(); await ready(); await dialog.getByRole('checkbox', { name: '使用图片占位继续' }).check()
  const placeholderZip = await download('placeholders'), placeholderXml = await placeholderZip.file('word/document.xml').async('string')
  assert.match(placeholderXml, /缺失/); assert.match(placeholderXml, /远程/)
  assert.equal(Object.keys(placeholderZip.files).filter(path => path.startsWith('word/media/') && !placeholderZip.files[path].dir).length, 0)
  report.checks.push('missing/remote image block; explicit placeholder consent; source warning navigation; no remote fetch')

  for (const mode of ['parse', 'generate']) {
    await page.evaluate(mode => { window.docxWorkerMode = mode }, mode)
    await action()
    if (mode === 'generate') { await ready(); await dialog.getByRole('checkbox', { name: '使用图片占位继续' }).check(); await generate() }
    await page.waitForFunction(mode => document.querySelector('.docx-dialog [role=status]')?.textContent.includes(mode === 'parse' ? '正在预检' : '正在生成'), mode)
    await page.waitForFunction(mode => window.docxWorkerStats.held >= (mode === 'parse' ? 1 : 2), mode)
    assert.equal(await editor.evaluate(element => element.closest('.app-shell').inert), true)
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' })
    assert.equal(await source(), missing)
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'EM 菜单')
  }
  assert.deepEqual(await page.evaluate(() => window.docxWorkerStats), { held: 2, terminated: 2 })
  await page.evaluate(() => { window.docxWorkerMode = '' })
  await page.getByRole('button', { name: '新建标签', exact: true }).click()
  await fillSource(page, '其他标签仍可阅读')
  await page.getByRole('tab').first().click()
  await page.evaluate(() => { window.docxWorkerMode = 'parse' })
  await action(); await dialog.getByRole('button', { name: '阅读其他文档', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  assert.match(await source(), /其他标签仍可阅读/)
  await page.getByRole('tab').first().click()
  await dialog.waitFor(); assert.equal(await editor.evaluate(element => element.closest('.app-shell').inert), true)
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' })
  assert.equal(await source(), missing)
  report.checks.push('other tabs remain readable during preflight; returning resumes dialog; target stays locked')
  await page.evaluate(() => { window.docxWorkerMode = 'fail' })
  await action(); await ready(); await dialog.getByRole('checkbox', { name: '使用图片占位继续' }).check(); await generate()
  await page.getByRole('alert').filter({ hasText: '测试生成失败' }).waitFor()
  await dialog.waitFor({ state: 'hidden' }); assert.equal(await editor.evaluate(element => element.closest('.app-shell').inert), false)
  await page.evaluate(() => { window.docxWorkerMode = '' })
  report.checks.push('preflight/generation cancellation terminates Worker; generation error releases lock; Escape restores EM focus')

  // Exercise the real image import workflow and current display-resource export.
  await fillSource(page, '# 当前显示副本\n')
  await page.locator('.document-panel:not([hidden]) input[type=file][accept="image/png,image/jpeg"]').setInputFiles('Docs/samples/v0.3/assets/em.png')
  await page.getByRole('button', { name: '应用修改', exact: true }).click()
  await page.locator('.image-dialog').waitFor({ state: 'hidden' })
  await page.waitForFunction(() => document.querySelector('.document-panel:not([hidden]) .cm-content')?.textContent.includes('![em]('))
  const imageBody = await source()
  await action(); await ready()
  assert.equal(await dialog.getByRole('checkbox', { name: '使用图片占位继续' }).count(), 0)
  const imageZip = await download('display-image')
  const media = Object.keys(imageZip.files).filter(path => path.startsWith('word/media/') && !imageZip.files[path].dir)
  assert.equal(media.length, 1)
  assert.ok((await imageZip.file(media[0]).async('uint8array')).byteLength > 100)
  assert.equal(await source(), imageBody)
  report.checks.push('real imported current display PNG embedded; source unchanged')
  const displayPath = imageBody.match(/!\[em\]\(([^)]+)\)/)[1]
  const office = (await readFile('Docs/samples/v0.3/办公导出.md', 'utf8')).replaceAll('assets/em.png', displayPath).replaceAll('\r\n', '\n')
  await fillSource(page, office); await action(); await ready(); await download('office')
  report.checks.push('frozen office sample exported through production menu using imported display image')

  for (const [theme, label] of [['light', '清爽浅色'], ['dark', '午夜深色'], ['paper', '暖纸'], ['forest', '护眼绿']]) {
    await selectAppearanceTheme(page, label)
    await action(); await ready()
    assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth))
    await page.screenshot({ path: `${output}/${theme}.png` })
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' })
  }
  report.checks.push('preflight layout in all four themes')

  // Measure the isolated browser process tree (includes renderers and Workers),
  // without inspecting unrelated browser sessions. Sampled peaks are lower bounds.
  const browserSession = await browser.newBrowserCDPSession()
  const rss = async () => {
    const { processInfo } = await browserSession.send('SystemInfo.getProcessInfo')
    const ids = processInfo.map(process => process.id).filter(id => Number.isSafeInteger(id) && id > 0)
    if (process.platform === 'win32') {
      const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | Measure-Object -Property WorkingSet64 -Sum).Sum`], { windowsHide: true })
      return Number(stdout.trim())
    }
    if (process.platform === 'linux') {
      const values = await Promise.all(ids.map(async id => { try { return Number((await readFile(`/proc/${id}/status`, 'utf8')).match(/^VmRSS:\s+(\d+)\s+kB/m)?.[1] ?? 0) * 1024 } catch { return 0 } }))
      return values.reduce((a, b) => a + b, 0)
    }
    const { stdout } = await exec('ps', ['-o', 'rss=', '-p', ids.join(',')])
    return stdout.trim().split(/\s+/).reduce((sum, value) => sum + Number(value) * 1024, 0)
  }
  const memory = { metric: 'summed browser-tree RSS/Windows working set; sampled peak is a lower bound, shared pages may be counted twice', baselineBytes: await rss(), peakBytes: 0, samples: 0, sampleIntervalMs: 500 }
  let measuring = true
  const sampling = (async () => {
    while (measuring) { memory.peakBytes = Math.max(memory.peakBytes, await rss()); memory.samples++; if (measuring) await new Promise(resolve => setTimeout(resolve, memory.sampleIntervalMs)) }
  })()
  const large = '# 大样例\n\n' + ('办公正文 abc 中文。'.repeat(1400) + '\n\n').repeat(100) + imageBody.repeat(100)
  try {
    await fillSource(page, large)
    assert.equal(await draftText(), large, 'complete large fixture must reach the application before export')
    const started = Date.now(); await action(); await ready(); const preflightMs = Date.now() - started
    const generated = Date.now(); const largeZip = await download('large')
    report.performance = { sourceUtf8Bytes: Buffer.byteLength(large), imageReferences: 100, preflightMs, generateAndDownloadMs: Date.now() - generated, memory }
    const largeXml = await largeZip.file('word/document.xml').async('string')
    assert.match(largeXml, /大样例/)
    assert.equal((largeXml.match(/办公正文 abc 中文。/g) ?? []).length, 140000)
    assert.equal((largeXml.match(/<w:drawing>/g) ?? []).length, 100)
    assert.ok(await draftText() === large, 'complete large source preserved in draft (CodeMirror DOM is virtualized)')
  } finally { measuring = false; await sampling }
  report.checks.push('large document and 100 image references; export time and sampled browser-tree memory recorded')

  const multipage = original + '\n\n' + ('中文分页正文 abc。'.repeat(100) + '\n\n').repeat(20) + '\n|列甲|列乙|\n|---|---|\n' + '|长表行|需要跨页保留|\n'.repeat(80) + '\n```text\n' + '    长代码行需要保留缩进\n'.repeat(200) + '```\n\n' + imageBody.repeat(12)
  await fillSource(page, multipage); await action(); await ready(); await download('multipage')
  assert.ok(await draftText() === multipage)

  // Reload and recover the current unsaved body after successful and cancelled exports.
  await page.waitForFunction(() => document.querySelector('.document-panel:not([hidden]) .statusbar')?.textContent.includes('草稿已保存'))
  await page.reload(); await page.getByRole('button', { name: '恢复草稿', exact: true }).click()
  await editor.waitFor(); assert.ok(await draftText() === multipage)
  report.checks.push('unsaved source/image draft recoverable after reload')
  assert.deepEqual(remote, []); assert.deepEqual(errors, [])
  report.pending = ['native save-dialog UI overwrite/cancel and occupied targets', 'Word/WPS/LibreOffice pagination and editability', 'macOS/Linux GUI and assistive technology']
  report.passed = true
  console.log(`DOCX UI verification passed; ${report.performance.sourceUtf8Bytes} bytes, preflight ${report.performance.preflightMs} ms, export ${report.performance.generateAndDownloadMs} ms.`)
} catch (error) { report.error = error.stack; await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: `${output}/failure.png` }).catch(() => {}); throw error }
finally {
  await writeFile('test-results/docx-ui-verification.json', JSON.stringify(report, null, 2) + '\n')
  await browser?.close(); await server.close()
}
