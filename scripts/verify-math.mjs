import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { serveProduction, acknowledgeGuide, selectAppearanceTheme } from './serve-production.mjs'
import { fillSource } from './source-test-utils.mjs'

const server = await serveProduction()
const report = { passed: false, checks: [], scope: 'Production Chromium MathML, static HTML, print PDF and DOCX source fallback; native Word, OS print and other WebViews require release acceptance.' }
await mkdir('test-results/math', { recursive: true })
let browser, page
try {
  browser = await chromium.launch({ channel: process.env.EASYM_TEST_BROWSER || undefined })
  report.browser = browser.version()
  page = await browser.newPage({ viewport: { width: 1120, height: 800 } })
  const errors = [], external = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(server.url)) external.push(request.url()) })
  page.on('dialog', dialog => void (dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss()))
  await acknowledgeGuide(page); await page.goto(server.url)
  const source = () => page.locator('.document-panel:not([hidden]) [aria-label="Markdown 源码编辑器"]')
  const preview = () => page.locator('.document-panel:not([hidden]) .preview')
  const text = () => source().evaluate(node => [...node.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'))
  const action = async name => {
    await page.getByRole('button', { name: 'EM 菜单', exact: true }).click()
    await page.getByRole('menuitem', { name, exact: true }).click()
  }
  const exportAction = async name => { await action('导出'); await page.getByRole('menuitem', { name, exact: true }).click() }
  const setting = async enabled => {
    await action('设置')
    await page.getByRole('checkbox', { name: '数学公式渲染', exact: true }).setChecked(enabled)
    await page.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '完成', exact: true }).click()
  }
  const sample = (await readFile('Docs/samples/v0.6/数学公式.md', 'utf8')).replaceAll('\r\n', '\n').trimEnd()
  await fillSource(page, sample)
  await page.getByRole('button', { name: '分屏', exact: true }).click()
  await preview().locator('mtable').waitFor()
  for (const tag of ['mfrac', 'msqrt', 'munderover', 'mtable']) assert.equal(await preview().locator(tag).count() > 0, true)
  assert.equal(await preview().locator('math').count(), 7)
  assert.equal(await preview().locator('.math-source code').innerText(), '$\\unknown{x}$')
  assert.equal(await preview().locator('mfrac').evaluate(node => node.getBoundingClientRect().height > node.querySelector('mn').getBoundingClientRect().height), true)
  assert.equal(await text(), sample)
  report.checks.push('native fractions/roots/sums/matrices, Chinese, prices, code, note/table math and recoverable syntax errors')
  for (const theme of ['light', 'dark', 'paper', 'forest']) {
    await selectAppearanceTheme(page, theme)
    await preview().evaluate(node => { node.scrollTop = 0 })
    assert.equal(await preview().locator('math').first().evaluate(node => getComputedStyle(node).color === getComputedStyle(node.closest('.markdown-math')).color), true)
    await page.screenshot({ path: `test-results/math/${theme}.png` })
  }
  await page.setViewportSize({ width: 760, height: 600 })
  assert.equal(await preview().evaluate(node => node.scrollWidth <= node.clientWidth + 1), true)
  await page.screenshot({ path: 'test-results/math/compact.png' })
  await page.setViewportSize({ width: 1120, height: 800 })
  report.checks.push('four themes and compact layout without document horizontal overflow')

  await page.getByRole('button', { name: '即时渲染', exact: true }).click()
  await source().press('Control+End')
  await page.locator('.document-panel:not([hidden]) .live-block-math').first().waitFor()
  await page.getByRole('button', { name: '显示公式源码', exact: true }).first().click()
  assert.match(await source().innerText(), /\\frac\{1\}\{2\}/)
  await page.getByRole('button', { name: '源码', exact: true }).click()
  assert.equal(await text(), sample)
  await source().press('Control+End'); await page.keyboard.insertText('\n修改')
  await page.getByRole('toolbar', { name: '格式工具栏', exact: true }).getByRole('button', { name: '撤销', exact: true }).click()
  assert.equal(await text(), sample)
  await page.getByRole('button', { name: '分屏', exact: true }).click()
  await page.getByRole('button', { name: '阅读模式', exact: true }).click()
  await page.getByRole('button', { name: '退出阅读模式', exact: true }).waitFor()
  await preview().locator('mtable').waitFor()
  await page.keyboard.press('Escape')
  report.checks.push('live block source reveal, unchanged source, undo and reading mode')

  await setting(false)
  await preview().locator('.math-source', { hasText: '公式渲染已关闭' }).first().waitFor()
  assert.equal(await preview().locator('math').count(), 0)
  const disabledDownload = page.waitForEvent('download'); await exportAction('HTML')
  const disabled = await disabledDownload
  await disabled.saveAs('test-results/math/disabled.html')
  assert.doesNotMatch(await readFile('test-results/math/disabled.html', 'utf8'), /<math[ >]/)
  await page.locator('.document-panel:not([hidden]) .statusbar').filter({ hasText: '草稿已保存' }).waitFor()
  await page.reload()
  await page.getByRole('dialog', { name: '恢复草稿', exact: true }).getByRole('button', { name: '恢复草稿', exact: true }).click()
  await action('设置')
  assert.equal(await page.getByRole('checkbox', { name: '数学公式渲染', exact: true }).isChecked(), false)
  await page.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '完成', exact: true }).click()
  await setting(true)
  await fillSource(page, sample)
  await page.getByRole('button', { name: '分屏', exact: true }).click()
  await preview().locator('mtable').waitFor()
  report.checks.push('rendering setting persists across reload and controls export fallback')

  const downloaded = page.waitForEvent('download'); await exportAction('HTML')
  const htmlPath = `${process.cwd()}/test-results/math/standalone.html`
  await (await downloaded).saveAs(htmlPath)
  const standalone = await browser.newPage()
  standalone.on('request', request => { if (/^https?:/.test(request.url())) external.push(request.url()) })
  await standalone.goto(pathToFileURL(htmlPath).href)
  assert.equal(await standalone.locator('math').count(), 7)
  assert.equal(await standalone.locator('script,link,img').count(), 0)
  assert.equal(await standalone.locator('annotation').first().textContent(), 'E=mc^2')
  assert.equal(await standalone.locator('mfrac').evaluate(node => node.getBoundingClientRect().height > 20), true)
  await standalone.screenshot({ path: 'test-results/math/standalone.png', fullPage: true })
  await standalone.close()
  await exportAction('PDF'); await page.locator('.print-dialog').waitFor()
  assert.equal(await page.locator('#easym-print-root math').count(), 7)
  await page.emulateMedia({ media: 'print' })
  await page.pdf({ path: 'test-results/math/formulas.pdf', format: 'A4', printBackground: true })
  await page.emulateMedia({ media: 'screen' }); await page.keyboard.press('Escape')
  await exportAction('DOCX')
  const docx = page.getByRole('dialog', { name: '导出 DOCX', exact: true })
  await page.waitForFunction(() => [...document.querySelectorAll('.docx-warnings li')].some(node => node.textContent.includes('Word 原生公式')))
  const docxDownload = page.waitForEvent('download'); await docx.getByRole('button', { name: '生成 DOCX', exact: true }).click()
  await (await docxDownload).saveAs('test-results/math/formulas.docx')
  await docx.waitFor({ state: 'detached' })
  assert.equal(await text(), sample)
  report.checks.push('offline static MathML and TeX annotation, print PDF, explicit DOCX source fallback/download without source mutation')

  await action('新建文档'); await fillSource(page, '$\\href{https://evil.example}{x}$\n\n$\\def\\a{a}\\a$\n\n正常 $z^2$')
  await page.getByRole('button', { name: '分屏', exact: true }).click()
  await preview().locator('annotation', { hasText: 'z^2' }).waitFor({ state: 'attached' })
  assert.equal(await preview().locator('math').count(), 1)
  assert.equal(await preview().locator('.math-source').count(), 2)
  assert.equal(await preview().locator('script,style,img,a,svg,[href],[src]').count(), 0)
  await page.getByRole('tab').first().click()
  await preview().locator('mtable').waitFor()
  assert.equal(await preview().locator('math').count(), 7)
  assert.equal(await text(), sample)
  assert.deepEqual(errors, []); assert.deepEqual(external, [])
  report.checks.push('blocked resource/macro commands, subsequent valid math and independent tabs; zero external network requests or page errors')
  report.passed = true
} catch (error) {
  report.error = error.stack; process.exitCode = 1
  await page?.screenshot({ path: 'test-results/math/failure.png' }).catch(() => {})
} finally {
  await writeFile('test-results/math-verification.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
  await browser?.close(); await server.close()
}
