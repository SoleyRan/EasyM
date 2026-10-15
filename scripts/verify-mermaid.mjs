import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { serveProduction, acknowledgeGuide, selectAppearanceTheme } from './serve-production.mjs'
import { fillSource } from './source-test-utils.mjs'

const server = await serveProduction()
const report = { passed: false, checks: [], scope: 'Production Chromium sandbox, static SVG images, offline HTML, browser print PDF and DOCX source fallback. Native WebViews/OS print remain step-4 acceptance.' }
await mkdir('test-results/mermaid', { recursive: true })
let browser, page
try {
  browser = await chromium.launch({ channel: process.env.EASYM_TEST_BROWSER || undefined })
  report.browser = browser.version()
  page = await browser.newPage({ viewport: { width: 1180, height: 850 } })
  const errors = [], external = [], engineRequests = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith(server.url)) external.push(request.url())
    if (/mermaid\.min-/.test(request.url())) engineRequests.push(request.url())
  })
  page.on('dialog', dialog => void (dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss()))
  await acknowledgeGuide(page); await page.goto(server.url)
  const panel = () => page.locator('.document-panel:not([hidden])')
  const preview = () => panel().locator('.preview')
  const source = () => panel().locator('[aria-label="Markdown 源码编辑器"]')
  const text = () => source().evaluate(node => [...node.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'))
  const action = async name => { await page.getByRole('button', { name: 'EM 菜单', exact: true }).click(); await page.getByRole('menuitem', { name, exact: true }).click() }
  const exportAction = async name => { await action('导出'); await page.getByRole('menuitem', { name, exact: true }).click() }
  const setting = async enabled => {
    await action('设置'); await page.getByRole('checkbox', { name: 'Mermaid 图表渲染', exact: true }).setChecked(enabled)
    await page.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '完成', exact: true }).click()
  }
  const waitImages = async (count = 2) => {
    await page.waitForFunction(count => {
      const panel = document.querySelector('.document-panel:not([hidden]) .preview')
      const images = [...(panel?.querySelectorAll('.markdown-mermaid > img') ?? [])]
      return images.length === count && images.every(image => image.complete && image.naturalWidth > 0)
    }, count)
  }
  await fillSource(page, '# 普通 Markdown\n\n```js\nalert(1)\n```')
  await page.getByRole('button', { name: '分屏', exact: true }).click()
  await preview().locator('code.language-js').waitFor()
  assert.equal(engineRequests.length, 0)
  const sample = (await readFile('Docs/samples/v0.6/Mermaid.md', 'utf8')).replaceAll('\r\n', '\n').trimEnd()
  await fillSource(page, sample); await waitImages()
  assert.equal(await preview().locator('.markdown-mermaid details[open]').count(), 2)
  assert.match(await preview().innerText(), /语法错误/)
  assert.match(await preview().innerText(), /仅支持流程图与时序图/)
  assert.equal(await text(), sample)
  const svg = () => preview().locator('.markdown-mermaid > img').first().getAttribute('src')
  const first = await svg()
  assert.match(decodeURIComponent(first), /fill:#e9f1fe/)
  assert.match(decodeURIComponent(first), /开始写作/)
  assert.doesNotMatch(decodeURIComponent(first), /foreignObject|<script|@keyframes|animation:/)
  report.checks.push('engine absent on ordinary Markdown; offline flowchart/sequence images, syntax/unsupported source fallback and static SVG paint')
  for (const theme of ['light', 'dark', 'paper', 'forest']) {
    await selectAppearanceTheme(page, theme); await waitImages()
    const expected = { light: '#e9f1fe', dark: '#202c3e', paper: '#f1e8d8', forest: '#dfebdb' }[theme]
    await page.waitForFunction(expected => {
      const image = document.querySelector('.document-panel:not([hidden]) .preview .markdown-mermaid > img')
      return image && decodeURIComponent(image.getAttribute('src')).includes(expected)
    }, expected)
    assert.ok(decodeURIComponent(await svg()).includes(expected))
    await preview().evaluate(node => { node.scrollTop = 0 })
    await page.screenshot({ path: `test-results/mermaid/${theme}.png` })
  }
  await page.setViewportSize({ width: 760, height: 600 }); await waitImages()
  assert.equal(await preview().evaluate(node => node.scrollWidth <= node.clientWidth + 1), true)
  await page.screenshot({ path: 'test-results/mermaid/compact.png' }); await page.setViewportSize({ width: 1180, height: 850 })
  await page.getByRole('button', { name: '即时渲染', exact: true }).click(); await source().press('Control+End')
  await panel().locator('.live-block-mermaid img').first().waitFor()
  await page.getByRole('button', { name: '显示图表源码', exact: true }).first().click()
  assert.match(await source().innerText(), /flowchart TD/)
  await page.getByRole('button', { name: '源码', exact: true }).click(); assert.equal(await text(), sample)
  await page.getByRole('button', { name: '分屏', exact: true }).click()
  await page.getByRole('button', { name: '阅读模式', exact: true }).click(); await waitImages(); await page.keyboard.press('Escape')
  report.checks.push('four theme palettes, compact layout, live source reveal and reading mode without source mutation')

  await setting(false)
  await preview().locator('figcaption', { hasText: 'Mermaid 渲染已关闭' }).first().waitFor()
  assert.equal(await preview().locator('.markdown-mermaid img').count(), 0)
  const disabledDownload = page.waitForEvent('download'); await exportAction('HTML'); await (await disabledDownload).saveAs('test-results/mermaid/disabled.html')
  assert.doesNotMatch(await readFile('test-results/mermaid/disabled.html', 'utf8'), /<img /)
  await panel().locator('.statusbar').filter({ hasText: '草稿已保存' }).waitFor(); await page.reload()
  await page.getByRole('dialog', { name: '恢复草稿', exact: true }).getByRole('button', { name: '恢复草稿', exact: true }).click()
  await action('设置'); assert.equal(await page.getByRole('checkbox', { name: 'Mermaid 图表渲染', exact: true }).isChecked(), false)
  assert.equal(await page.getByRole('checkbox', { name: '数学公式渲染', exact: true }).isChecked(), true)
  await page.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '完成', exact: true }).click()
  await setting(true); await fillSource(page, sample); await page.getByRole('button', { name: '分屏', exact: true }).click(); await waitImages()
  report.checks.push('independent persisted setting controls preview and HTML source fallback')

  const downloaded = page.waitForEvent('download'); await exportAction('HTML')
  const htmlPath = `${process.cwd()}/test-results/mermaid/standalone.html`; await (await downloaded).saveAs(htmlPath)
  const standalone = await browser.newPage()
  standalone.on('request', request => { if (/^https?:/.test(request.url())) external.push(request.url()) })
  await standalone.goto(pathToFileURL(htmlPath).href)
  assert.equal(await standalone.locator('img').count(), 2)
  assert.equal(await standalone.locator('script,iframe,link,svg').count(), 0)
  assert.equal(await standalone.locator('img').first().evaluate(image => image.complete && image.naturalWidth > 0), true)
  assert.ok(decodeURIComponent(await standalone.locator('img').first().getAttribute('src')).includes('#e9f1fe'))
  assert.equal(await standalone.locator('details').first().locator('code').textContent(), sample.slice(sample.indexOf('```mermaid'), sample.indexOf('```', sample.indexOf('```mermaid') + 3) + 3))
  await standalone.screenshot({ path: 'test-results/mermaid/standalone.png', fullPage: true }); await standalone.close()
  await exportAction('PDF'); await page.locator('.print-dialog').waitFor()
  assert.equal(await page.locator('#easym-print-root img').count(), 2)
  await page.waitForFunction(() => [...document.querySelectorAll('#easym-print-root img')].every(image => image.complete && image.naturalWidth > 0))
  await page.emulateMedia({ media: 'print' }); await page.pdf({ path: 'test-results/mermaid/diagrams.pdf', format: 'A4', printBackground: true })
  await page.emulateMedia({ media: 'screen' }); await page.keyboard.press('Escape')
  await exportAction('DOCX'); const docx = page.getByRole('dialog', { name: '导出 DOCX', exact: true })
  await page.waitForFunction(() => [...document.querySelectorAll('.docx-warnings li')].some(node => node.textContent.includes('Mermaid 图表以可编辑围栏源码')))
  const docxDownload = page.waitForEvent('download'); await docx.getByRole('button', { name: '生成 DOCX', exact: true }).click()
  await (await docxDownload).saveAs('test-results/mermaid/diagrams.docx'); await docx.waitFor({ state: 'detached' }); assert.equal(await text(), sample)
  report.checks.push('offline standalone HTML/static images/exact source, light print PDF and explicit DOCX source fallback')

  const malicious = ['%%{init: {securityLevel: "loose"}}%%\nflowchart TD\n A-->B', 'flowchart TD\n click A "https://evil.example"', 'flowchart TD\n A[<img src="https://evil.example/a.png">]', 'flowchart TD\n classDef x fill:red', 'flowchart TD\n' + 'A'.repeat(8001)]
  await fillSource(page, malicious.map(code => '```mermaid\n' + code + '\n```').join('\n\n'))
  await preview().locator('.markdown-mermaid details[open]').first().waitFor()
  await page.waitForFunction(() => document.querySelectorAll('.document-panel:not([hidden]) .preview .markdown-mermaid details[open]').length === 5)
  assert.equal(await preview().locator('img,script,iframe,svg,a').count(), 0)
  assert.equal(await preview().locator('code').first().textContent(), '```mermaid\n' + malicious[0] + '\n```')
  await fillSource(page, Array.from({ length: 13 }, (_, i) => '```mermaid\nflowchart TD\n A' + i + '-->B\n```').join('\n\n'))
  await preview().locator('figcaption', { hasText: '文档图表数量' }).waitFor()
  assert.equal(await preview().locator('.markdown-mermaid img').count(), 12)
  report.checks.push('configuration/click/HTML/style/oversized inputs and per-document count limits fall back without external requests')

  const enginePattern = '**/mermaid.min-*.js'
  await page.route(enginePattern, route => route.abort())
  await fillSource(page, '```mermaid\nflowchart TD\n A-->B\n```')
  await preview().locator('figcaption', { hasText: '渲染失败' }).waitFor()
  await page.unroute(enginePattern)
  let releaseEngine
  const held = new Promise(resolve => { releaseEngine = resolve })
  await page.route(enginePattern, async route => { await held; await route.abort().catch(() => {}) })
  await fillSource(page, '```mermaid\nsequenceDiagram\n A->>B: timeout\n```')
  await preview().locator('figcaption', { hasText: '渲染超时' }).waitFor()
  assert.equal(await page.locator('iframe.mermaid-sandbox').count(), 0)
  releaseEngine(); await page.unroute(enginePattern)
  await fillSource(page, sample)
  await page.waitForSelector('iframe.mermaid-sandbox', { state: 'attached' })
  await fillSource(page, '# 最新内容\n\n无图表')
  await preview().getByRole('heading', { name: '最新内容' }).waitFor()
  assert.equal(await preview().locator('.markdown-mermaid').count(), 0)
  assert.equal(await page.locator('iframe.mermaid-sandbox').count(), 0)
  await action('新建文档'); await fillSource(page, '```mermaid\nflowchart TD\n New-->Tab\n```')
  await page.getByRole('button', { name: '分屏', exact: true }).click(); await waitImages(1)
  await page.getByRole('tab').first().click(); await preview().getByRole('heading', { name: '最新内容' }).waitFor()
  assert.equal(await preview().locator('.markdown-mermaid').count(), 0)
  assert.deepEqual(external, []); assert.deepEqual(errors, [])
  report.checks.push('engine load failure, timeout removal, canceled stale results and document isolation; no external network or page errors')
  report.passed = true
} catch (error) {
  report.error = error.stack ?? error.message; process.exitCode = 1
  if (page) await page.screenshot({ path: 'test-results/mermaid/failure.png' }).catch(() => {})
} finally {
  if (browser) await browser.close(); await server.close()
  await writeFile('test-results/mermaid-verification.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}
