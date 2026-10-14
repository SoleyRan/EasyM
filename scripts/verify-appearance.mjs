import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { serveProduction, acknowledgeGuide } from './serve-production.mjs'
import { fillSource } from './source-test-utils.mjs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url), JSZip = createRequire(require.resolve('docx'))('jszip')

const server = await serveProduction(), report = { passed: false, checks: [], scope: 'Production Chromium appearance, emulated system color scheme, real keyboard and pointer. Native OS settings and WebViews remain device checks.' }
let browser, page
await mkdir('test-results/appearance', { recursive: true })
try {
  browser = await chromium.launch({ channel: process.env.EASYM_TEST_BROWSER || undefined }); report.browser = browser.version()
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); const errors = []
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => void dialog.accept())
  await acknowledgeGuide(page)
  await page.addInitScript(() => {
    if (!localStorage.getItem('appearance-fixture')) {
      localStorage.setItem('appearance-fixture', 'yes'); localStorage.setItem('easym-theme', 'paper'); localStorage.setItem('easym-editor-font-size', '19'); localStorage.setItem('history-test-record', 'retained')
    }
  })
  await page.goto(server.url)
  assert.equal(await page.locator('.application').getAttribute('data-theme'), 'paper')
  const source = page.getByRole('textbox', { name: 'Markdown 源码编辑器' })
  const body = () => source.evaluate(node => [...node.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'))
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  const open = async () => { await page.getByRole('button', { name: 'EM 菜单', exact: true }).click(); await page.getByRole('menuitem', { name: '设置', exact: true }).click() }
  const close = async () => settings.getByRole('button', { name: '完成', exact: true }).click()
  const text = 'Ordinary paragraph '.repeat(25) + '\n\n```js\nconst value = "' + 'code '.repeat(80) + '"\n```\n\nend'
  const exportAction = async format => {
    await page.getByRole('button', { name: 'EM 菜单', exact: true }).click(); await page.getByRole('menuitem', { name: '导出', exact: true }).click(); await page.getByRole('menuitem', { name: format, exact: true }).click()
  }
  const exportSignature = async prefix => {
    const htmlEvent = page.waitForEvent('download'); await exportAction('HTML'); const html = await htmlEvent
    const htmlPath = `test-results/appearance/${prefix}.html`; await html.saveAs(htmlPath)
    await exportAction('DOCX'); const docx = page.getByRole('dialog', { name: '导出 DOCX', exact: true })
    await docx.getByRole('status').filter({ hasText: '预检完成' }).waitFor()
    const docxEvent = page.waitForEvent('download'); await docx.getByRole('button', { name: '生成 DOCX', exact: true }).click(); const download = await docxEvent
    const docxPath = `test-results/appearance/${prefix}.docx`; await download.saveAs(docxPath); await docx.waitFor({ state: 'hidden' })
    const zip = await JSZip.loadAsync(await readFile(docxPath)), xml = await Promise.all(['word/document.xml', 'word/styles.xml'].map(path => zip.file(path).async('string')))
    await exportAction('PDF'); await page.locator('#easym-print-root pre code').waitFor()
    const print = await page.locator('#easym-print-root').evaluate(node => ({ html: node.innerHTML, font: getComputedStyle(node.querySelector('p')).fontSize, codeFont: getComputedStyle(node.querySelector('pre code')).fontSize, codeWrap: getComputedStyle(node.querySelector('pre code')).whiteSpace }))
    await page.getByRole('button', { name: '返回编辑', exact: true }).click()
    return { html: await readFile(htmlPath, 'utf8'), xml, print }
  }
  await fillSource(page, text); const beforeExport = await exportSignature('before')
  await source.press('Control+End'); await source.press('!')
  await open(); assert.equal(await settings.getByLabel('编辑字号', { exact: true }).inputValue(), '19')
  for (const [label, value] of [['编辑字号', '20'], ['正文行高', '2'], ['正文宽度', '720'], ['代码字号', '18']]) await settings.getByLabel(label, { exact: true }).selectOption(value)
  await settings.getByLabel('代码自动换行', { exact: true }).uncheck(); await close()
  await source.press('Control+Home')
  const sourceStyle = await source.evaluate(node => {
    const code = node.querySelectorAll('.cm-source-code')[1], regular = node.querySelector('.cm-line')
    return { width: node.getBoundingClientRect().width, font: getComputedStyle(regular).fontSize, height: getComputedStyle(regular).lineHeight, codeFont: getComputedStyle(code).fontSize, codeWidth: code.scrollWidth, codeViewport: code.clientWidth, regularOverflow: regular.scrollWidth > regular.clientWidth + 1 }
  })
  assert.equal(sourceStyle.font, '20px'); assert.equal(sourceStyle.height, '40px'); assert.equal(sourceStyle.codeFont, '18px'); assert.ok(sourceStyle.width <= 720.5); assert.ok(sourceStyle.codeWidth > sourceStyle.codeViewport); assert.equal(sourceStyle.regularOverflow, false)
  assert.equal(await body(), text + '!')
  // Appearance changes do not consume the Markdown undo history.
  await source.press('Control+z'); assert.equal(await body(), text)
  report.checks.push('legacy migration; bounded source width, independent code font, code-only horizontal scrolling; appearance preserves text and undo')
  await page.getByRole('button', { name: '分屏', exact: true }).click()
  await page.locator('.preview pre code').waitFor()
  const previewStyle = await page.locator('.preview').evaluate(node => {
    const p = node.querySelector('p'), pre = node.querySelector('pre'), code = pre.querySelector('code')
    return { font: getComputedStyle(p).fontSize, height: getComputedStyle(p).lineHeight, codeFont: getComputedStyle(code).fontSize, preWidth: pre.scrollWidth, viewport: pre.clientWidth, width: p.getBoundingClientRect().width }
  })
  assert.equal(previewStyle.font, '20px'); assert.equal(previewStyle.height, '40px'); assert.equal(previewStyle.codeFont, '18px'); assert.ok(previewStyle.preWidth > previewStyle.viewport); assert.ok(previewStyle.width <= 720)
  await open(); await settings.getByLabel('代码自动换行', { exact: true }).check(); await close()
  await page.waitForFunction(() => { const pre = document.querySelector('.preview pre'); return pre.scrollWidth <= pre.clientWidth + 1 })
  await page.getByRole('button', { name: '即时渲染', exact: true }).click(); await source.press('Control+End')
  assert.equal(await source.locator('.cm-line').last().evaluate(node => getComputedStyle(node).fontSize), '20px')
  assert.equal(await source.locator('.cm-line').last().evaluate(node => getComputedStyle(node).lineHeight), '40px')
  await page.locator('.live-rendered-block pre code').waitFor()
  assert.equal(await page.locator('.live-rendered-block pre code').evaluate(node => getComputedStyle(node).fontSize), '18px')
  await page.getByRole('button', { name: '阅读模式', exact: true }).click(); await page.locator('.reading-mode .preview pre code').waitFor()
  assert.equal(await page.locator('.preview p').first().evaluate(node => getComputedStyle(node).fontSize), '20px'); await page.keyboard.press('Escape')
  report.checks.push('split, live and reading typography; enabled code wrap removes horizontal overflow')
  assert.deepEqual(await exportSignature('after'), beforeExport)
  report.checks.push('HTML byte equality, DOCX document/styles XML equality and print DOM/computed styles unchanged by appearance')
  await page.emulateMedia({ colorScheme: 'light' }); await open(); await settings.getByLabel('跟随系统主题', { exact: true }).check()
  await settings.getByLabel('系统浅色主题', { exact: true }).selectOption('forest'); await settings.getByLabel('系统深色主题', { exact: true }).selectOption('paper'); await close()
  assert.equal(await page.locator('.application').getAttribute('data-theme'), 'forest')
  await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForFunction(() => document.querySelector('.application').dataset.theme === 'paper')
  await open(); await settings.getByLabel('设置配色主题', { exact: true }).selectOption('dark'); await close()
  await page.emulateMedia({ colorScheme: 'light' }); await page.waitForFunction(() => document.querySelector('.application').dataset.theme === 'forest')
  await page.reload(); await page.getByRole('button', { name: '恢复草稿', exact: true }).click(); await source.waitFor()
  assert.equal(await page.locator('.application').getAttribute('data-theme'), 'forest')
  await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForFunction(() => document.querySelector('.application').dataset.theme === 'dark')
  await open(); assert.equal(await settings.getByLabel('正文行高', { exact: true }).inputValue(), '2'); await settings.getByRole('button', { name: '恢复默认外观', exact: true }).click()
  assert.equal(await settings.getByLabel('编辑字号', { exact: true }).inputValue(), '14'); assert.equal(await settings.getByLabel('跟随系统主题', { exact: true }).isChecked(), false)
  assert.equal(await page.evaluate(() => localStorage.getItem('history-test-record')), 'retained'); await close(); assert.equal(await body(), text)
  report.checks.push('live system transitions, separate theme memory across reload; reset retains draft, guide and unrelated history record')
  for (const theme of ['light', 'dark', 'paper', 'forest']) {
    await open(); await settings.getByLabel('设置配色主题', { exact: true }).selectOption(theme)
    await page.screenshot({ path: `test-results/appearance/${theme}.png` }); await close()
  }
  await page.setViewportSize({ width: 760, height: 600 }); await open()
  assert.equal(await settings.evaluate(node => node.scrollWidth <= node.clientWidth), true)
  await settings.getByLabel('正文宽度', { exact: true }).selectOption('1080'); await page.screenshot({ path: 'test-results/appearance/compact.png' }); await close()
  await page.getByRole('button', { name: '分屏', exact: true }).click()
  assert.equal(await page.locator('.application').evaluate(node => node.scrollWidth <= node.clientWidth), true)
  // A denied persistence write must still apply to the current session and report the failure.
  await page.evaluate(() => { window.originalStorageWrite = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key === 'easym-appearance') throw new DOMException('quota', 'QuotaExceededError'); return window.originalStorageWrite.call(this, key, value) } })
  await open(); await settings.getByLabel('编辑字号', { exact: true }).selectOption('22'); await close()
  await page.getByRole('alert').filter({ hasText: '无法保存外观设置' }).waitFor()
  assert.equal(await page.locator('.application').evaluate(node => node.style.getPropertyValue('--editor-font-size')), '22px')
  await page.evaluate(() => { Storage.prototype.setItem = window.originalStorageWrite })
  assert.deepEqual(errors, []); report.checks.push('four theme and compact screenshots; denied persistence is reported without losing session settings'); report.passed = true
} catch (error) { report.error = error.stack; process.exitCode = 1; console.error(error); await page?.screenshot({ path: 'test-results/appearance/failure.png' }).catch(() => {}) }
finally { await writeFile('test-results/appearance-verification.json', JSON.stringify(report, null, 2) + '\n'); await browser?.close(); await server.close() }
