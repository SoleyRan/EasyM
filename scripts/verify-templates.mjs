import assert from 'node:assert/strict'
import { fillSource } from './source-test-utils.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { serveProduction } from './serve-production.mjs'

const server = await serveProduction()
let browser
let page
const cpuThrottlingRate = process.argv.includes('--slow') ? 6 : 1
try {
  browser = await chromium.launch({ channel: process.env.EASYM_TEST_BROWSER || undefined })
  page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  if (cpuThrottlingRate > 1) {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottlingRate })
  }
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('dialog', dialog => { void (dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss()) })
  const editor = page.getByRole('textbox', { name: 'Markdown 源码编辑器' })
  const body = () => editor.evaluate(element => [...element.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'))
  const open = async () => {
    await page.getByRole('button', { name: 'EM 菜单', exact: true }).click()
    await page.getByRole('menuitem', { name: '从模板新建', exact: true }).click()
  }
  const dialog = page.locator('.template-dialog')
  await page.goto(server.url)
  await fillSource(page, '当前标签保留正文')
  await open()
  assert.equal(await dialog.getByLabel('模板', { exact: true }).evaluate(element => element === document.activeElement), true)
  await dialog.getByLabel('模板', { exact: true }).press('Shift+Tab')
  assert.equal(await dialog.getByRole('button', { name: '创建文档' }).evaluate(element => element === document.activeElement), true)
  await page.keyboard.press('Tab')
  await page.keyboard.press('Escape')
  assert.equal(await dialog.count(), 0)
  assert.equal(await page.getByRole('button', { name: 'EM 菜单' }).evaluate(element => element === document.activeElement), true)
  assert.equal(await page.getByRole('tab').count(), 1)
  await open()
  await dialog.getByLabel('模板', { exact: true }).selectOption('meeting')
  await dialog.getByLabel('文档标题').fill('中文🙂 $1 {{date}} <script>globalThis.templateExecuted=true</script>')
  await dialog.getByLabel('日期', { exact: true }).fill('2026-10-10')
  const expected = await dialog.getByLabel('Markdown 内容预览').inputValue()
  assert.ok(expected.startsWith('# 中文🙂 $1 {{date}} <script>'))
  assert.ok(expected.includes('日期：2026-10-10'))
  await dialog.getByRole('button', { name: '创建文档' }).click()
  assert.equal(await page.getByRole('tab').count(), 2)
  assert.equal(await body(), expected)
  await page.getByRole('button', { name: '分屏', exact: true }).click()
  await page.locator('.preview table').waitFor()
  assert.equal(await page.evaluate(() => globalThis.templateExecuted), undefined)
  assert.equal(await page.locator('.preview script').count(), 0)
  await page.waitForFunction(() => [...document.querySelectorAll('.document-panel:not([hidden]) [role=status]')].some(element => element.textContent.includes('草稿已保存')))
  await page.getByRole('tab', { name: '未命名.md *', exact: true }).click()
  assert.equal(await body(), '当前标签保留正文')
  // A blank template is clean even with a suggested name and closes without a decision.
  await open()
  await dialog.getByLabel('文档标题').fill('空白草稿')
  await dialog.getByRole('button', { name: '创建文档' }).click()
  assert.equal(await body(), '')
  // DocumentEditor reports its summary in an effect after the new tab mounts.
  // count() is a snapshot, so wait for the reported title before asserting it.
  await page.getByRole('tab', { name: '空白草稿.md', exact: true }).waitFor()
  assert.equal(await page.getByRole('tab', { name: '空白草稿.md', exact: true }).count(), 1)
  await page.getByRole('button', { name: '关闭 空白草稿.md', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 2)
  assert.equal(await page.locator('.close-dialog').count(), 0)
  assert.equal(await page.getByRole('tab').count(), 2)
  // Recover the generated template as a draft, retaining its exact source and name.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 })
  await page.getByRole('button', { name: '恢复草稿', exact: true }).waitFor()
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click()
  await page.locator('[role=tab][aria-selected=false]').click()
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click()
  assert.equal(await body(), expected)
  await page.getByRole('button', { name: '分屏', exact: true }).click()
  await page.locator('.preview table').waitFor()
  // Generated Markdown uses the existing browser download workflow.
  await page.getByRole('button', { name: 'EM 菜单', exact: true }).click()
  const downloadEvent = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: '下载副本', exact: true }).click()
  const download = await downloadEvent
  assert.ok(download.suggestedFilename().endsWith('.md'))
  const stream = await download.createReadStream()
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  assert.equal(Buffer.concat(chunks).toString('utf8'), expected)
  await mkdir('test-results', { recursive: true })
  for (const theme of ['清爽浅色', '午夜深色', '暖纸', '护眼绿']) {
    await page.getByRole('button', { name: 'EM 菜单', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Style · 配色主题' }).click()
    await page.getByRole('menuitemradio', { name: theme }).click()
    await open()
    await dialog.getByLabel('模板', { exact: true }).selectOption('project')
    await dialog.getByLabel('文档标题').fill('项目说明')
    await page.screenshot({ path: `test-results/templates-${theme}.png` })
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
  }
  await page.setViewportSize({ width: 720, height: 620 })
  await open()
  await dialog.getByLabel('模板', { exact: true }).selectOption('project')
  await page.screenshot({ path: 'test-results/templates-compact.png' })
  const overflow = await dialog.evaluate(element => element.scrollWidth > element.clientWidth + 1 || element.getBoundingClientRect().right > innerWidth)
  assert.equal(overflow, false)
  await dialog.getByRole('button', { name: '创建文档' }).click()
  assert.ok((await body()).startsWith('# 项目说明'))
  assert.equal(await page.getByRole('tab').count(), 3)
  assert.deepEqual(errors, [])
  const report = { stage: 'v0.2-step-4', verifiedAt: new Date().toISOString(), browser: await browser.version(), passed: true, cpuThrottlingRate, checks: ['EM template entry', 'initial focus, focus trap, Escape/cancel and return focus', 'blank/meeting/project templates', 'literal Chinese/emoji/dollar/nested placeholder substitutions', 'script text does not execute', 'independent tabs and preserved source', 'untouched blank closes without prompt', 'generated draft survives reload', 'first browser download preserves exact Markdown', 'four themes and compact dialog layout'] }
  await writeFile(cpuThrottlingRate > 1 ? 'test-results/templates-slow-verification.json' : 'test-results/templates-verification.json', JSON.stringify(report, null, 2) + '\n')
  console.log('Template verification passed: generation, safe text, tabs, draft recovery, download, keyboard and themes.')
} catch (error) {
  await mkdir('test-results', { recursive: true })
  await page?.screenshot({ path: 'test-results/templates-failure.png' }).catch(() => undefined)
  console.error({ tabs: await page?.getByRole('tab').allTextContents(), activePanel: await page?.locator('.document-panel:not([hidden])').getAttribute('id') })
  throw error
} finally {
  await browser?.close()
  await server.close()
}
