import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { serveProduction } from './serve-production.mjs'
import { fillSource } from './source-test-utils.mjs'

const output = 'test-results/extension-delivery', server = await serveProduction()
const { version } = JSON.parse(await readFile('package.json', 'utf8'))
const require = createRequire(import.meta.url), JSZip = createRequire(require.resolve('docx'))('jszip')
const report = { version, verifiedAt: new Date().toISOString(), passed: false, checks: [], scope: 'Production Chromium mixed extensions and actual downloaded outputs; OS dialogs, native WebViews and Word are separate checks.' }
await mkdir(output, { recursive: true })
let browser, page
try {
  browser = await chromium.launch({ channel: process.env.EASYM_TEST_BROWSER || undefined })
  report.browser = browser.version()
  page = await browser.newPage({ viewport: { width: 960, height: 680 } })
  const errors = [], external = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(server.url)) external.push(request.url()) })
  page.on('dialog', dialog => void (dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss()))
  await page.goto(server.url)
  const guide = page.getByRole('dialog', { name: 'EasyM 使用导引', exact: true })
  await guide.waitFor(); assert.ok((await guide.innerText()).includes(version))
  for (let index = 1; index <= 4; index++) {
    assert.equal(await guide.locator('section').count(), 1)
    assert.equal(await guide.getByRole('status').innerText(), `${index} / 4`)
    assert.equal(await guide.evaluate(node => {
      const r = node.getBoundingClientRect(), nav = node.querySelector('.guide-navigation').getBoundingClientRect()
      return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && nav.bottom <= innerHeight
    }), true, `Guide page ${index} must fit minimum desktop window`)
    await page.screenshot({ path: `${output}/guide-${index}.png` })
    if (index < 4) await page.keyboard.press('ArrowRight')
  }
  assert.match(await guide.innerText(), /DOCX.*源码/)
  await page.keyboard.press('ArrowLeft'); assert.equal(await guide.getByRole('status').innerText(), '3 / 4')
  await page.keyboard.press('ArrowRight'); await guide.getByRole('button', { name: '开始使用', exact: true }).click()
  report.checks.push('four guide pages with arrow navigation, v0.6 extension/export contract and visible navigation at 960x680')
  await page.setViewportSize({ width: 1180, height: 850 })
  const panel = () => page.locator('.document-panel:not([hidden])')
  const source = () => panel().locator('[aria-label="Markdown 源码编辑器"]')
  const text = () => source().evaluate(node => [...node.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'))
  const preview = () => panel().locator('.preview')
  const action = async name => { await page.getByRole('button', { name: 'EM 菜单', exact: true }).click(); await page.getByRole('menuitem', { name, exact: true }).click() }
  const exportAction = async name => { await action('导出'); await page.getByRole('menuitem', { name, exact: true }).click() }
  const waitImages = root => root.locator('img').evaluateAll(async images => {
    await Promise.all(images.map(image => image.decode()))
    return images.length === 3 && images.every(image => image.naturalWidth > 0)
  })
  // Import through the real editor so the local image has an authorized resource.
  await fillSource(page, '')
  await panel().locator('input[type=file][accept="image/png,image/jpeg"]').setInputFiles('Docs/samples/v0.6/assets/em.png')
  await page.getByRole('button', { name: '应用修改', exact: true }).click()
  await page.locator('.image-dialog').waitFor({ state: 'hidden' })
  const displayPath = (await text()).match(/!\[em\]\(([^)]+)\)/)?.[1]
  assert.ok(displayPath)
  const sample = (await readFile('Docs/samples/v0.6/扩展与导出.md', 'utf8')).replaceAll('\r\n', '\n').trimEnd().replaceAll('assets/em.png', displayPath)
  await fillSource(page, sample); await page.getByRole('button', { name: '分屏', exact: true }).click()
  await preview().locator('.markdown-mermaid > img').nth(1).waitFor()
  assert.equal(await waitImages(preview()), true)
  assert.equal(await preview().locator('math').count(), 3)
  assert.equal(await preview().locator('.footnotes ol > li').count(), 1)
  assert.equal(await preview().locator('.markdown-metadata').count(), 1)
  await preview().evaluate(node => { node.scrollTop = 0 })
  await page.screenshot({ path: `${output}/mixed-preview.png` })
  assert.equal(await text(), sample)
  const download = page.waitForEvent('download'); await exportAction('HTML')
  const htmlPath = `${process.cwd()}/${output}/combined.html`; await (await download).saveAs(htmlPath)
  const standalone = await browser.newPage()
  standalone.on('request', request => { if (/^https?:/.test(request.url())) external.push(request.url()) })
  await standalone.goto(pathToFileURL(htmlPath).href)
  assert.equal(await standalone.locator('script,iframe,link,svg').count(), 0)
  assert.equal(await standalone.locator('math').count(), 3)
  assert.equal(await standalone.locator('img[src^="data:image/svg+xml"]').count(), 2)
  assert.equal(await standalone.locator('img[src^="data:image/png;base64,"]').count(), 1)
  assert.equal(await waitImages(standalone), true)
  assert.match(await standalone.locator('.markdown-metadata').innerText(), /<script>仅作元数据原文展示<\/script>/)
  assert.equal(await standalone.locator('a[href^="#"]').evaluateAll(anchors => anchors.length === 4 && anchors.every(link => document.getElementById(link.getAttribute('href').slice(1)))), true)
  assert.equal(await standalone.locator('td').first().evaluate(node => getComputedStyle(node).borderTopWidth), '1px')
  await standalone.screenshot({ path: `${output}/combined-html.png`, fullPage: true }); await standalone.close()
  report.checks.push('mixed static HTML has escaped metadata, valid note anchors, MathML, two SVG images, embedded authorized PNG and bordered table; offline file has no active runtime')
  await exportAction('PDF'); await page.locator('.print-dialog').waitFor()
  const print = page.locator('#easym-print-root')
  assert.equal(await print.locator('math').count(), 3); assert.equal(await print.locator('.footnotes').count(), 1)
  assert.equal(await waitImages(print), true)
  await page.emulateMedia({ media: 'print' })
  await page.pdf({ path: `${output}/combined.pdf`, format: 'A4', printBackground: true })
  await page.emulateMedia({ media: 'screen' }); await page.keyboard.press('Escape')
  await exportAction('DOCX'); const dialog = page.getByRole('dialog', { name: '导出 DOCX', exact: true })
  await page.waitForFunction(() => document.querySelector('.docx-dialog [role=status]')?.textContent.includes('预检完成'))
  const warnings = await dialog.locator('.docx-warnings').innerText()
  for (const expected of ['Mermaid', 'LaTeX', 'Word 原生逐页脚注', '“yaml”将作为静态原文保留']) assert.ok(warnings.includes(expected), expected)
  assert.equal(await dialog.getByRole('checkbox', { name: '使用图片占位继续' }).count(), 0)
  const next = page.waitForEvent('download'); await dialog.getByRole('button', { name: '生成 DOCX', exact: true }).click()
  await (await next).saveAs(`${output}/combined.docx`); await dialog.waitFor({ state: 'hidden' })
  const zip = await JSZip.loadAsync(await readFile(`${output}/combined.docx`), { checkCRC32: true })
  const xml = await zip.file('word/document.xml').async('string')
  for (const content of ['EasyM v0.6 扩展与导出', 'E=mc^2', '\\frac{1}{2}+\\sqrt{4}=\\frac{5}{2}', '```mermaid', 'flowchart TD', 'sequenceDiagram', '这是文末脚注', '&lt;script&gt;仅作元数据原文展示&lt;/script&gt;']) assert.ok(xml.includes(content), content)
  assert.match(xml, /<w:tbl>/)
  assert.equal(Object.keys(zip.files).filter(name => name.startsWith('word/media/') && !zip.files[name].dir).length, 1)
  assert.equal(await text(), sample)
  report.checks.push('actual print PDF and downloaded DOCX retain mixed content, editable exact formula/diagram source, note/metadata warnings, table and embedded PNG; original Markdown unchanged')
  await action('设置')
  await page.getByRole('checkbox', { name: '数学公式渲染', exact: true }).uncheck()
  await page.getByRole('checkbox', { name: 'Mermaid 图表渲染', exact: true }).uncheck()
  await page.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '完成', exact: true }).click()
  await preview().locator('figcaption', { hasText: 'Mermaid 渲染已关闭' }).first().waitFor()
  const disabled = page.waitForEvent('download'); await exportAction('HTML')
  await (await disabled).saveAs(`${output}/disabled.html`)
  const disabledHtml = await readFile(`${output}/disabled.html`, 'utf8')
  assert.doesNotMatch(disabledHtml, /<math\b|data:image\/svg\+xml/)
  for (const content of ['flowchart TD', 'sequenceDiagram', 'E=mc^2']) assert.ok(disabledHtml.includes(content))
  assert.match(disabledHtml, /data:image\/png;base64,/)
  assert.equal(await text(), sample)
  assert.deepEqual(errors, []); assert.deepEqual(external, [])
  report.checks.push('both rendering switches preserve mixed source fallbacks in exported HTML and leave local PNG/source intact; no external requests or page errors')
  report.passed = true
} catch (error) {
  report.error = error.stack ?? error.message; process.exitCode = 1
  await page?.screenshot({ path: `${output}/failure.png` }).catch(() => {})
} finally {
  await browser?.close(); await server.close()
  await writeFile('test-results/extension-delivery-verification.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}
