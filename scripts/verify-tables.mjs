import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { serveProduction, acknowledgeGuide, selectAppearanceTheme } from './serve-production.mjs'
import { fillSource } from './source-test-utils.mjs'

const server = await serveProduction()
const report = { passed: false, checks: [], scope: 'Production browser pointer/keyboard and simulated desktop IPC; real IME/native dialogs remain manual.' }
let browser, page
await mkdir('test-results/tables', { recursive: true })
try {
  browser = await chromium.launch({ channel: process.env.EASYM_TEST_BROWSER || undefined }); report.browser = browser.version()
  page = await browser.newPage({ viewport: { width: 1120, height: 800 } })
  const errors = []
  page.on('pageerror', err => errors.push(err.message))
  await acknowledgeGuide(page); await page.goto(server.url)
  const source = () => page.locator('.document-panel:not([hidden])').getByRole('textbox', { name: 'Markdown 源码编辑器' })
  const body = () => source().evaluate(node => [...node.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'))
  const panel = page.getByRole('dialog', { name: '编辑表格', exact: true })
  const input = page.getByRole('textbox', { name: '单元格 Markdown', exact: true })
  const decision = page.getByRole('dialog', { name: '未应用的表格输入', exact: true })
  const open = async () => { await page.getByRole('button', { name: '编辑表格', exact: true }).first().click(); await input.waitFor() }
  const confirm = async () => { await panel.getByRole('button', { name: '确认', exact: true }).click(); await panel.waitFor({ state: 'detached' }) }
  const cancel = async () => { await panel.getByRole('button', { name: '取消输入', exact: true }).click(); await panel.waitFor({ state: 'detached' }) }
  const fixture = '| 名称 | 值 |\n| :--- | ---: |\n| **中文😀** | `a\\|b` |\n| 尾行 | end |'
  await fillSource(page, '')
  await page.getByRole('button', { name: '插入表格', exact: true }).click()
  const insert = page.getByRole('dialog', { name: '插入表格', exact: true })
  assert.equal(await insert.getByLabel('正文行数', { exact: true }).inputValue(), '2')
  assert.equal(await insert.getByLabel('列数', { exact: true }).inputValue(), '3')
  await insert.getByRole('button', { name: '创建表格', exact: true }).click(); await input.waitFor()
  assert.equal(await input.inputValue(), '')
  assert.equal((await body()).split('\n').filter(line => line.startsWith('|')).length, 4)
  await cancel(); await page.getByRole('button', { name: '撤销', exact: true }).click(); assert.equal(await body(), '')
  await page.getByRole('button', { name: '重做', exact: true }).click()
  assert.equal((await body()).split('\n').filter(line => line.startsWith('|')).length, 4)
  report.checks.push('default blank insertion, first-header focus and atomic undo/redo')

  await fillSource(page, fixture); await source().press('ControlOrMeta+Home'); await open()
  await input.fill('**新标题😀**'); await input.press('Tab')
  assert.equal(await input.inputValue(), '值')
  await input.fill('`p|q`'); await input.press('Enter')
  assert.match(await body(), /`p\\\|q`/)
  await page.getByRole('button', { name: '撤销', exact: true }).click(); assert.match(await body(), /\| 值 \|/)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await source().press('ControlOrMeta+Home'); await open()
  await input.fill('取消'); await input.press('Escape'); assert.equal(await panel.count(), 0); assert.doesNotMatch(await body(), /取消/)
  report.checks.push('Markdown cell draft, escaped code pipe, Enter/Tab, cancel and cell undo')

  await fillSource(page, fixture); await source().press('ControlOrMeta+Home'); await open()
  await panel.getByRole('button', { name: '正文第 2 行 第 2 列', exact: true }).click()
  await input.fill('last'); await input.press('Tab')
  assert.equal(await input.inputValue(), '')
  assert.match(await panel.innerText(), /正文第 3 行/)
  await confirm(); await page.getByRole('button', { name: '撤销', exact: true }).click(); assert.equal(await body(), fixture)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  assert.match(await body(), /last/)
  await source().press('ControlOrMeta+Home'); await open(); await input.press('Shift+Tab'); assert.equal(await panel.count(), 0)
  report.checks.push('final Tab commits plus appends in one transaction; first Shift+Tab returns to source')

  await fillSource(page, fixture); await source().press('ControlOrMeta+Home'); await open()
  await panel.getByRole('button', { name: '正文第 1 行 第 1 列', exact: true }).click()
  await panel.getByRole('button', { name: '上方插行', exact: true }).click()
  assert.match(await body(), /\|  \|  \|/)
  await panel.getByRole('button', { name: '右侧插列', exact: true }).click()
  assert.match(await body(), /\| :--- \| --- \| ---: \|/)
  await panel.getByLabel('列对齐', { exact: true }).selectOption('center')
  assert.match(await body(), /\| :---: \| --- \| ---: \|/)
  await panel.getByRole('button', { name: '正文第 2 行 第 1 列', exact: true }).click()
  page.once('dialog', dialog => dialog.dismiss())
  const before = await body(); await panel.getByRole('button', { name: '删除当前行', exact: true }).click(); assert.equal(await body(), before)
  page.once('dialog', dialog => dialog.accept())
  await panel.getByRole('button', { name: '删除当前行', exact: true }).click(); assert.doesNotMatch(await body(), /中文😀/)
  await confirm(); await page.getByRole('button', { name: '撤销', exact: true }).click(); assert.equal(await body(), before)
  report.checks.push('row/column insertion, alignment, nonempty deletion cancel/confirm and atomic restoration')

  await source().press('ControlOrMeta+Home'); await open()
  await input.fill('line\nbreak'); await input.press('Enter')
  assert.match(await panel.innerText(), /不能包含换行/); assert.equal(await input.inputValue(), 'line\nbreak')
  await cancel(); assert.equal(await body(), before)
  await open(); await input.fill('草稿')
  await page.getByRole('button', { name: '分屏', exact: true }).click(); await decision.waitFor()
  await decision.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(await input.inputValue(), '草稿'); assert.equal(await page.locator('.preview').count(), 0)
  await page.getByRole('button', { name: '分屏', exact: true }).click()
  await decision.getByRole('button', { name: '应用', exact: true }).click(); await page.locator('.preview').waitFor()
  assert.match(await body(), /草稿/)
  report.checks.push('invalid newline preserves draft; mode change cancel/apply guard')

  await page.waitForFunction(() => document.querySelector('.preview th')?.textContent === '草稿'); await page.locator('.preview td').first().click(); await input.waitFor()
  await input.fill('未应用'); await page.getByRole('button', { name: '新建标签', exact: true }).click(); await decision.waitFor()
  await decision.getByRole('button', { name: '取消', exact: true }).click(); assert.equal(await input.inputValue(), '未应用')
  await page.getByRole('button', { name: '新建标签', exact: true }).click()
  await decision.getByRole('button', { name: '放弃', exact: true }).click(); await source().waitFor()
  await page.getByRole('tab').first().click(); assert.doesNotMatch(await body(), /未应用/)
  await page.locator('.preview td').first().click(); await input.waitFor()
  await input.fill('关闭取消'); await page.getByRole('button', { name: /^关闭 未命名/ }).first().click(); await decision.waitFor()
  await decision.getByRole('button', { name: '取消', exact: true }).click(); assert.equal(await input.inputValue(), '关闭取消')
  await cancel()
  report.checks.push('preview cell edits same source; new/switch tab and close preserve unapplied draft')

  for (const theme of ['light', 'dark', 'paper', 'forest']) {
    await selectAppearanceTheme(page, theme)
    await page.locator('.preview td').first().click(); await input.waitFor()
    await page.screenshot({ path: `test-results/tables/${theme}.png` }); await cancel()
  }
  await page.setViewportSize({ width: 430, height: 420 }); await page.locator('.preview td').first().click(); await input.waitFor()
  const box = await panel.boundingBox(); assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 430 && box.y + box.height <= 420)
  await page.screenshot({ path: 'test-results/tables/compact.png' }); await cancel()
  await page.setViewportSize({ width: 1120, height: 800 })
  await page.getByRole('button', { name: '即时渲染', exact: true }).click(); await source().press('ControlOrMeta+End'); await source().press('Enter'); await source().press('Enter')
  const live = page.locator('.live-block-table'); await live.waitFor()
  await live.getByRole('button', { name: '编辑表格', exact: true }).click(); await input.waitFor(); await cancel()
  await page.getByRole('button', { name: '阅读模式', exact: true }).click(); await page.locator('.application.reading-mode').waitFor()
  assert.equal(await page.locator('.preview-table-actions').count(), 0); assert.equal(await panel.count(), 0)
  await page.keyboard.press('Escape')
  report.checks.push('four themes, compact viewport, live table entry and read-only reading')
  await page.getByRole('button', { name: '源码', exact: true }).click()
  await fillSource(page, fixture); await source().press('ControlOrMeta+Home'); await open()
  await input.fill('输入法草稿')
  await input.dispatchEvent('compositionstart', { data: '中' })
  await input.press('Tab'); assert.equal(await input.inputValue(), '输入法草稿'); assert.equal(await panel.count(), 1)
  await panel.getByRole('button', { name: '确认', exact: true }).click(); assert.equal(await panel.count(), 1)
  await input.dispatchEvent('compositionend', { data: '中' })
  await cancel(); assert.equal(await body(), fixture)
  await open(); await input.fill('非法\n换行')
  await page.getByRole('button', { name: '分屏', exact: true }).click(); await decision.waitFor()
  await decision.getByRole('button', { name: '应用', exact: true }).click()
  assert.match(await decision.innerText(), /不能包含换行/)
  assert.equal(await page.locator('.preview').count(), 0)
  await decision.getByRole('button', { name: '取消', exact: true }).click(); assert.equal(await input.inputValue(), '非法\n换行'); await cancel()
  report.checks.push('synthetic composition guards Tab and pointer commit; failed apply blocks navigation and retains draft')

  // A separate profile supplies desktop IPC without touching real files. Its
  // call log verifies autosave timing and task entry; this is not a native IO test.
  const desktopPage = await browser.newPage({ viewport: { width: 1120, height: 800 } })
  desktopPage.on('pageerror', err => errors.push(err.message))
  await acknowledgeGuide(desktopPage)
  await desktopPage.addInitScript(fixture => {
    window.isTauri = true; window.calls = []
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
    let callback = 0
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' } }, transformCallback: () => ++callback,
      invoke: async (command, args) => {
        if (command === 'recent_state') return { entries: [], session: { tabs: [], activeDraftKey: null, workspaceId: null } }
        if (command === 'remember_session') return

        window.calls.push({ command, args })
        if (command.startsWith('plugin:window|is_')) return false
        if (command.startsWith('plugin:')) return 1
        if (command === 'open_document') return { id: 'table-file', name: 'table.md', bytes: [...new TextEncoder().encode(fixture)], revision: 'r1' }
        if (command === 'save_document') return { id: 'table-file', name: 'table.md', revision: 'r2', destination: 'disk' }
        if (command === 'inspect_document') return { revision: args.expectedRevision, bytes: null }
        if (command === 'close_document') return
        if (command === 'history_operation') throw 'history_disabled'
        throw new Error(`Unexpected IPC ${command}`)
      } }
  }, fixture)
  await desktopPage.goto(server.url)
  await desktopPage.getByRole('button', { name: 'EM 菜单', exact: true }).click()
  await desktopPage.getByRole('menuitem', { name: '打开文件', exact: true }).click()
  await desktopPage.getByRole('tab', { name: 'table.md', exact: true }).waitFor()
  const ds = desktopPage.locator('.document-panel:not([hidden])').getByRole('textbox', { name: 'Markdown 源码编辑器' })
  await fillSource(desktopPage, fixture + '\n\nx'); await ds.press('ControlOrMeta+Home')
  await desktopPage.getByRole('button', { name: '编辑表格', exact: true }).click()
  const di = desktopPage.getByRole('textbox', { name: '单元格 Markdown', exact: true }), dp = desktopPage.getByRole('dialog', { name: '编辑表格', exact: true }), dd = desktopPage.getByRole('dialog', { name: '未应用的表格输入', exact: true })
  await di.fill('暂停保存')
  await desktopPage.waitForTimeout(1600)
  assert.equal(await desktopPage.evaluate(() => window.calls.filter(call => call.command === 'save_document').length), 0)
  await desktopPage.getByRole('button', { name: 'EM 菜单', exact: true }).click(); await dd.waitFor()
  await dd.getByRole('button', { name: '取消', exact: true }).click(); assert.equal(await di.inputValue(), '暂停保存')
  await desktopPage.getByRole('button', { name: 'EM 菜单', exact: true }).click(); await dd.waitFor()
  await dd.getByRole('button', { name: '应用', exact: true }).click(); await dp.waitFor({ state: 'detached' })
  await desktopPage.waitForFunction(() => window.calls.some(call => call.command === 'save_document'))
  const saved = await desktopPage.evaluate(() => window.calls.find(call => call.command === 'save_document'))
  assert.match(new TextDecoder().decode(new Uint8Array(saved.args.bytes)), /暂停保存/)
  assert.equal(await desktopPage.getByRole('dialog', { name: '未应用的表格输入', exact: true }).count(), 0)
  await desktopPage.close()
  report.checks.push('desktop IPC fixture: no autosave with unsubmitted draft; EM cancel retains draft; applied source autosaves afterward')
  assert.deepEqual(errors, []); report.passed = true
} catch (err) { report.error = err.stack; process.exitCode = 1; if (page) await page.screenshot({ path: 'test-results/tables/failure.png' }).catch(() => {}) }
finally { await writeFile('test-results/tables-verification.json', JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2)); await browser?.close(); await server.close() }
