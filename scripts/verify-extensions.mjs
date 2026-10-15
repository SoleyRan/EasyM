import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { serveProduction, acknowledgeGuide, selectAppearanceTheme } from './serve-production.mjs'
import { fillSource } from './source-test-utils.mjs'

const server = await serveProduction(), report = { passed: false, checks: [], scope: 'Production Chromium: footnotes and static Front Matter, browser export/print; no native Word, system print dialog or screen-reader claim.' }
await mkdir('test-results/extensions', { recursive: true })
let browser, page
try {
  browser = await chromium.launch({ channel: process.env.EASYM_TEST_BROWSER || undefined }); report.browser = browser.version()
  page = await browser.newPage({ viewport: { width: 1120, height: 800 } })
  const errors = [], external = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (!request.url().startsWith(server.url) && /^https?:/.test(request.url())) external.push(request.url()) })
  page.on('dialog', dialog => void dialog.dismiss())
  await acknowledgeGuide(page); await page.goto(server.url)
  const source = () => page.locator('.document-panel:not([hidden]) [aria-label="Markdown 源码编辑器"]')
  const body = () => source().evaluate(node => [...node.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'))
  const preview = () => page.locator('.document-panel:not([hidden]) .preview')
  const action = async name => {
    await page.getByRole('button', { name: 'EM 菜单', exact: true }).click()
    await page.getByRole('menuitem', { name, exact: true }).click()
  }
  const exportAction = async name => { await action('导出'); await page.getByRole('menuitem', { name, exact: true }).click() }
  const sample = (await readFile('Docs/samples/v0.6/脚注与元数据.md', 'utf8')).replaceAll('\r\n', '\n').trimEnd()
  const text = sample.replace('## 使用方式', Array.from({ length: 30 }, (_, i) => `段落 ${i + 1}：${'内容 '.repeat(8)}`).join('\n\n') + '\n\n## 使用方式')
  await fillSource(page, text); await page.getByRole('button', { name: '分屏', exact: true }).click()
  await preview().locator('.footnotes').waitFor()
  assert.equal(await preview().locator('[data-footnote-ref]').count(), 3)
  assert.equal(await preview().locator('.markdown-metadata').count(), 3)
  const validAnchors = article => [...article.querySelectorAll('a[data-footnote-ref],a[data-footnote-backref]')].every(link => [...article.querySelectorAll('[id]')].some(target => target.id === link.getAttribute('href').slice(1)))
  assert.equal(await preview().evaluate(validAnchors), true)
  await source().press('Control+Home')
  await preview().locator('[data-footnote-ref]').first().click()
  await page.waitForFunction(() => document.activeElement?.matches('.document-panel:not([hidden]) .footnotes li'))
  assert.equal(await preview().locator('[data-footnote-backref]').first().isVisible(), true)
  assert.match(await page.locator('.document-panel:not([hidden]) .cm-activeLine').innerText(), /\[\^说明\]:/)
  assert.equal(await page.getByRole('dialog', { name: '插入 / 编辑链接', exact: true }).count(), 0)
  const back = preview().locator('[data-footnote-backref]').first()
  await back.focus(); await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.activeElement?.matches('.document-panel:not([hidden]) [data-footnote-ref]'))
  assert.match(await page.locator('.document-panel:not([hidden]) .cm-activeLine').innerText(), /首次引用/)
  assert.equal(await body(), text)
  report.checks.push('mouse forward / keyboard back jump, exact source selection, repeated references, retained definitions and source unchanged')

  // A second tab has identical generated IDs. Navigation must stay scoped.
  await action('新建文档'); await fillSource(page, text.replace('首次引用', '第二标签首次引用'))
  await page.getByRole('button', { name: '分屏', exact: true }).click()
  await preview().locator('.footnotes').waitFor()
  await preview().locator('[data-footnote-ref]').first().focus(); await page.keyboard.press('Enter')
  assert.equal(await page.evaluate(() => document.activeElement.closest('.document-panel')?.hidden), false)
  assert.match(await page.locator('.document-panel:not([hidden]) .cm-activeLine').innerText(), /\[\^说明\]:/)
  await page.getByRole('button', { name: '阅读模式', exact: true }).click()
  await page.getByRole('button', { name: '退出阅读模式', exact: true }).waitFor()
  await preview().locator('[data-footnote-backref]').first().click()
  await preview().locator('[data-footnote-ref]').first().focus(); await page.keyboard.press('Enter')
  assert.equal(await page.evaluate(() => document.activeElement.matches('.document-panel:not([hidden]) .footnotes li')), true)
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: '阅读模式', exact: true }).waitFor()
  report.checks.push('duplicate IDs isolated across tabs; keyboard navigation in reading mode and Escape preserves editor')

  for (const theme of ['light', 'dark', 'paper', 'forest']) {
    await selectAppearanceTheme(page, theme)
    await preview().evaluate(article => { article.scrollTop = 0 })
    await page.screenshot({ path: `test-results/extensions/${theme}.png` })
  }
  await page.setViewportSize({ width: 760, height: 600 })
  assert.equal(await preview().evaluate(article => article.scrollWidth <= article.clientWidth + 1), true)
  await page.screenshot({ path: 'test-results/extensions/compact.png' })
  await page.setViewportSize({ width: 1120, height: 800 })
  report.checks.push('four theme / compact screenshots with metadata source and visible note heading')

  await fillSource(page, sample)
  const before = await body()
  const downloaded = page.waitForEvent('download'); await exportAction('HTML')
  const download = await downloaded, htmlPath = `${process.cwd()}/test-results/extensions/standalone.html`
  await download.saveAs(htmlPath)
  const standalone = await browser.newPage()
  standalone.on('request', request => { if (/^https?:/.test(request.url())) external.push(request.url()) })
  await standalone.goto(pathToFileURL(htmlPath).href)
  assert.equal(await standalone.locator('script').count(), 0)
  assert.equal(await standalone.locator('.footnotes').count(), 1)
  assert.equal(await standalone.locator('.markdown-metadata').count(), 3)
  assert.equal(await standalone.locator('main').evaluate(article => [...article.querySelectorAll('a[href^="#"]')].every(link => [...article.querySelectorAll('[id]')].some(target => target.id === link.getAttribute('href').slice(1)))), true)
  const first = standalone.locator('sup a').first(); await first.click()
  assert.ok(await standalone.evaluate(() => location.hash.startsWith('#user-content-')))
  await standalone.screenshot({ path: 'test-results/extensions/standalone.png', fullPage: true }); await standalone.close()
  await exportAction('PDF'); await page.locator('.print-dialog').waitFor()
  assert.equal(await page.locator('#easym-print-root .footnotes').count(), 1)
  assert.equal(await page.locator('#easym-print-root .markdown-metadata').count(), 3)
  await page.emulateMedia({ media: 'print' }); await page.pdf({ path: 'test-results/extensions/endnotes.pdf', format: 'A4', printBackground: true })
  await page.emulateMedia({ media: 'screen' }); await page.keyboard.press('Escape')
  await exportAction('DOCX'); const docx = page.getByRole('dialog', { name: '导出 DOCX', exact: true })
  await docx.getByRole('button', { name: '生成 DOCX', exact: true }).waitFor({ state: 'visible' })
  await page.waitForFunction(() => [...document.querySelectorAll('.docx-warnings li')].some(node => node.textContent.includes('不是 Word 原生逐页脚注')))
  const docxDownload = page.waitForEvent('download'); await docx.getByRole('button', { name: '生成 DOCX', exact: true }).click()
  await (await docxDownload).saveAs('test-results/extensions/endnotes.docx')
  await docx.waitFor({ state: 'detached' })
  assert.equal(await body(), before)
  report.checks.push('standalone HTML anchors, offline output, print/PDF endnotes and explicit DOCX preflight/download leave source unchanged')

  await fillSource(page, '+++\ntitle = "<script>danger</script>"\n+++\n\n正文[^a]\n\n[^a]: A[^b]\n\n[^b]: B[^a]')
  await preview().locator('.markdown-metadata > p', { hasText: 'TOML' }).waitFor()
  assert.equal(await preview().locator('.footnotes ol > li').count(), 2)
  assert.equal(await preview().evaluate(validAnchors), true)
  assert.equal(await preview().locator('script').count(), 0)
  await page.getByRole('button', { name: '即时渲染', exact: true }).click()
  await source().press('Control+End')
  assert.match(await source().innerText(), /\[\^a\]:/)
  assert.match(await source().innerText(), /\[\^b\]:/)
  assert.equal(await source().locator('.live-block-code').count(), 0)
  await page.waitForFunction(() => [...document.querySelectorAll('.document-panel:not([hidden]) .cm-line')].some(line => line.textContent.includes('正文[^a]')))
  await page.getByRole('button', { name: '源码', exact: true }).click()
  await source().press('Control+End'); await page.keyboard.insertText('\n末尾修改')
  await page.getByRole('toolbar', { name: '格式工具栏', exact: true }).getByRole('button', { name: '撤销', exact: true }).click()
  assert.ok(!(await body()).includes('末尾修改'))
  await fillSource(page, '[^early]: 前置定义\n\n# 正文标题\n\n正文[^early]\n\n' + '长段落\n\n'.repeat(35))
  await page.getByRole('button', { name: '分屏', exact: true }).click()
  const earlyReference = preview().locator('[data-footnote-ref][href$="fn-early"]')
  await earlyReference.waitFor()
  await earlyReference.click()
  assert.match(await page.locator('.document-panel:not([hidden]) .cm-activeLine').innerText(), /\[\^early\]:/)
  await page.getByRole('button', { name: '阅读模式', exact: true }).click()
  await page.getByRole('button', { name: '展开大纲', exact: true }).click()
  await page.getByRole('button', { name: '正文标题', exact: true }).click()
  assert.equal(await preview().locator('h1').evaluate(heading => {
    const h = heading.getBoundingClientRect(), p = heading.closest('.preview').getBoundingClientRect()
    return h.top >= p.top - 1 && h.bottom <= p.bottom
  }), true)
  await page.keyboard.press('Escape')
  assert.deepEqual(errors, []); assert.deepEqual(external, [])
  report.checks.push('TOML escaped raw data, cyclic notes bounded, live footnote source visible, undo, early-definition jumps and reading outline')
  report.passed = true
} catch (error) { report.error = error.stack; process.exitCode = 1; await page?.screenshot({ path: 'test-results/extensions/failure.png' }).catch(() => {}) }
finally {
  await writeFile('test-results/extensions-verification.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2)); await browser?.close(); await server.close()
}
