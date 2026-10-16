import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { serveProduction, acknowledgeGuide } from './serve-production.mjs'
import { fillSource } from './source-test-utils.mjs'

const server = await serveProduction()
const report = { passed: false, checks: [], scope: 'Production Chromium with deterministic native IPC; raw filesystem inspection has separate Rust tests. No real native window/IME claim.' }
let browser, page
await mkdir('test-results/external', { recursive: true })
try {
  browser = await chromium.launch({ channel: process.env.EASYM_TEST_BROWSER || undefined }); report.browser = browser.version()
  page = await browser.newPage({ viewport: { width: 1150, height: 850 } }); const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await acknowledgeGuide(page)
  await page.addInitScript(() => {
    const encoder = new TextEncoder()
    window.disk = { a: { text: '# 原文件\n\n中文 😀', revision: 'r1' } }; window.calls = []; window.nextOpen = 'a'
    let callback = 0
    const file = id => ({ id, name: `${id}.md`, revision: window.disk[id].revision, bytes: [...encoder.encode(window.disk[id].text)] })
    window.isTauri = true; window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' } }, transformCallback: () => ++callback, invoke: async (command, args) => {
      window.calls.push({ command, args })
      if (command.startsWith('plugin:window|is_')) return false
      if (command.startsWith('plugin:')) return 1
      if (command === 'recent_state') return { entries: [], session: { tabs: [], activeDraftKey: null, workspaceId: null } }
      if (command === 'remember_session' || command === 'close_document') return
      if (command === 'open_document') return file(window.nextOpen)
      if (command === 'inspect_document') {
        const result = window.disk[args.id] && { revision: window.disk[args.id].revision, bytes: window.disk[args.id].revision === args.expectedRevision ? null : [...encoder.encode(window.disk[args.id].text)] }
        const error = window.inspectError
        if (window.delayInspect) await new Promise(resolve => { window.resolveInspect = resolve })
        if (error) throw error
        if (!result) throw 'resource_missing'
        return result
      }
      if (command === 'reload_document') {
        if (args.expectedRevision && args.expectedRevision !== window.disk[args.id].revision) throw 'revision_conflict'
        return file(args.id)
      }
      if (command === 'save_document') {
        if (!args.saveAs && args.expectedRevision !== window.disk[args.id]?.revision) throw 'revision_conflict'
        const id = args.saveAs ? 'copy' : args.id
        window.disk[id] = { text: new TextDecoder().decode(new Uint8Array(args.bytes)), revision: `saved-${Date.now()}` }
        return file(id)
      }
      if (command === 'history_operation') throw 'history_disabled'
      throw new Error(`Unexpected IPC ${command}`)
    } }
  })
  await page.goto(server.url)
  const menu = async label => { await page.getByRole('button', { name: 'EM 菜单', exact: true }).click(); await page.getByRole('menuitem', { name: label, exact: true }).click() }
  const body = () => page.locator('.document-panel:not([hidden]) .cm-content').evaluate(node => [...node.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'))
  const banner = () => page.getByRole('status', { name: '外部文件变化', exact: true })
  const dialog = () => page.getByRole('dialog', { name: '外部版本对比', exact: true })
  const mutate = async (text, revision) => page.evaluate(({ text, revision }) => { window.disk.a = { text, revision }; window.dispatchEvent(new Event('focus')) }, { text, revision })
  await menu('打开文件'); assert.equal(await body(), '# 原文件\n\n中文 😀')
  await page.waitForFunction(() => window.calls.some(c => c.command === 'inspect_document'))
  await mutate('# 磁盘变更\n\n中文 😀', 'r2'); await banner().waitFor()
  assert.equal(await body(), '# 原文件\n\n中文 😀')
  await banner().getByRole('button', { name: '比较外部版本' }).click()
  assert.equal(await dialog().getByRole('textbox', { name: '磁盘正文' }).inputValue(), '# 磁盘变更\n\n中文 😀')
  assert.equal(await dialog().getByRole('textbox', { name: '本地正文' }).inputValue(), '# 原文件\n\n中文 😀')
  await dialog().getByRole('button', { name: '分析三方合并', exact: true }).click()
  const analysis = () => dialog().getByRole('region', { name: '三方合并分析', exact: true })
  const candidate = () => analysis().getByRole('textbox', { name: '合并候选（只读）', exact: true })
  await candidate().waitFor()
  assert.equal(await candidate().inputValue(), '# 磁盘变更\n\n中文 😀')
  assert.equal(await candidate().getAttribute('readonly'), '')
  assert.equal(await body(), '# 原文件\n\n中文 😀')
  assert.equal(await page.evaluate(() => window.disk.a.text), '# 磁盘变更\n\n中文 😀')
  report.checks.push('three-way analysis uses the actual opened baseline, previews disk-only change read-only and preserves both inputs')
  await dialog().getByRole('textbox', { name: '本地正文' }).click(); await page.keyboard.press('Control+a')
  assert.equal(await dialog().getByRole('textbox', { name: '本地正文' }).evaluate(node => node.selectionEnd - node.selectionStart), '# 原文件\n\n中文 😀'.length)
  await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'detached' })
  assert.equal(await body(), '# 原文件\n\n中文 😀')
  await banner().getByRole('button', { name: '重新加载磁盘版本' }).click(); await banner().waitFor({ state: 'detached' })
  assert.equal(await body(), '# 磁盘变更\n\n中文 😀')
  report.checks.push('clean-file notice preserves memory, comparison supports selection/copy, Escape retains body, explicit reload updates baseline')

  const saves = await page.evaluate(() => window.calls.filter(c => c.command === 'save_document').length)
  await fillSource(page, '# 本地未保存\n\n不能覆盖'); await mutate('# 第三方修改', 'r3'); await banner().waitFor()
  await page.waitForTimeout(1500)
  assert.equal(await body(), '# 本地未保存\n\n不能覆盖')
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.command === 'save_document').length), saves)
  await banner().getByRole('button', { name: '比较外部版本' }).click(); await dialog().getByRole('button', { name: '加载磁盘版本', exact: true }).click()
  await dialog().getByRole('button', { name: '分析三方合并', exact: true }).click()
  await analysis().getByText(/有 \d+ 处文本冲突/).waitFor()
  assert.equal(await analysis().getByRole('textbox', { name: '冲突 1 共同祖先' }).inputValue(), '# 磁盘变更\n\n中文 😀')
  assert.equal(await candidate().count(), 0)
  assert.equal(await analysis().getByRole('button', { name: '应用合并并保存', exact: true }).isDisabled(), true)
  await analysis().getByRole('textbox', { name: '冲突 1 共同祖先' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'test-results/external/merge-conflict.png' })
  await page.setViewportSize({ width: 430, height: 600 })
  const conflictOverflow = await analysis().evaluate(node => node.scrollWidth > node.clientWidth)
  assert.equal(conflictOverflow, false)
  await analysis().getByRole('textbox', { name: '冲突 1 本地片段' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'test-results/external/merge-conflict-compact.png' })
  await page.setViewportSize({ width: 1150, height: 850 })
  report.checks.push('conflicting local/disk edits retain the last reloaded common ancestor and expose no writable candidate')
  await page.evaluate(() => { window.disk.a = { text: '# 又一次修改', revision: 'r4' } })
  await dialog().getByRole('button', { name: '确认加载磁盘版本' }).click(); await dialog().getByRole('alert').filter({ hasText: '外部修改' }).waitFor()
  assert.equal(await body(), '# 本地未保存\n\n不能覆盖')
  await dialog().getByRole('button', { name: '保留本地编辑' }).click(); await banner().getByRole('button', { name: '重新检查' }).click()
  await page.waitForFunction(() => window.calls.some(c => c.command === 'inspect_document') && document.querySelector('[aria-label="外部文件变化"]'))
  await banner().getByRole('button', { name: '比较外部版本' }).click()
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="磁盘正文"]')?.value === '# 又一次修改')
  await page.screenshot({ path: 'test-results/external/conflict.png' })
  await dialog().getByRole('button', { name: '另存本地副本' }).click(); await dialog().waitFor({ state: 'detached' }); await banner().waitFor({ state: 'detached' })
  assert.equal(await page.evaluate(() => window.disk.a.text), '# 又一次修改')
  assert.equal(await page.evaluate(() => window.disk.copy.text), '# 本地未保存\n\n不能覆盖')
  report.checks.push('dirty conflict pauses autosave, stale confirmation refuses newer disk revision, save-copy preserves external original')

  for (const error of ['resource_missing', 'permission_denied', 'quota_exceeded']) {
    await page.evaluate(error => { window.inspectError = error; window.dispatchEvent(new Event('focus')) }, error)
    await banner().getByText('无法检查磁盘版本', { exact: true }).waitFor()
    assert.equal(await body(), '# 本地未保存\n\n不能覆盖')
    await page.evaluate(() => { window.inspectError = null; window.dispatchEvent(new Event('focus')) }); await banner().waitFor({ state: 'detached' })
  }
  await fillSource(page, '# 成功保存'); await page.locator('.document-panel:not([hidden]) .statusbar').filter({ hasText: '已自动保存' }).waitFor()
  await page.waitForTimeout(250); assert.equal(await banner().count(), 0)
  report.checks.push('missing/revoked/over-limit inspection retains body and can retry, own saves update baseline without repeated conflict')

  await page.evaluate(() => { window.delayInspect = true; window.dispatchEvent(new Event('focus')) })
  await page.waitForFunction(() => !!window.resolveInspect)
  await page.getByRole('tab').first().click()
  await page.evaluate(() => { window.delayInspect = false; window.resolveInspect() })
  await page.waitForTimeout(300); assert.equal(await banner().count(), 0)
  await page.getByRole('tab', { name: 'copy.md', exact: true }).click(); await page.waitForTimeout(300)
  assert.equal(await body(), '# 成功保存'); assert.equal(await banner().count(), 0)
  report.checks.push('tab switch discards late inspection result and keeps each file baseline separate')

  await page.evaluate(() => { window.disk.copy = { text: '\uFEFF# 成功保存', revision: 'bom-only' }; window.dispatchEvent(new Event('focus')) })
  await banner().waitFor(); await banner().getByRole('button', { name: '比较外部版本' }).click()
  await dialog().getByText('新增 0 行 / 删除 0 行', { exact: true }).waitFor()
  assert.match(await dialog().innerText(), /utf-8-bom/)
  await page.keyboard.press('Escape'); await banner().getByRole('button', { name: '重新加载磁盘版本' }).click(); await banner().waitFor({ state: 'detached' })
  report.checks.push('BOM-only disk change is detected even with identical normalized body and zero text differences')

  await page.evaluate(() => { window.disk.table = { text: '| 表头 |\n| --- |\n| 内容 |', revision: 'table-1' }; window.nextOpen = 'table' })
  await menu('打开文件'); const source = page.locator('.document-panel:not([hidden])').getByRole('textbox', { name: 'Markdown 源码编辑器' })
  await source.press('Control+Home'); await page.getByRole('button', { name: '编辑表格', exact: true }).first().click()
  const table = page.getByRole('dialog', { name: '编辑表格', exact: true }), cell = table.getByRole('textbox', { name: '单元格 Markdown', exact: true })
  await cell.fill('未提交表格草稿')
  await page.evaluate(() => { window.disk.table = { text: '# 表格外部变化', revision: 'table-2' }; window.dispatchEvent(new Event('focus')) })
  await banner().waitFor(); assert.equal(await cell.inputValue(), '未提交表格草稿')
  assert.equal(await banner().getByRole('button', { name: '重新加载磁盘版本' }).isDisabled(), true)
  await table.getByRole('button', { name: '确认', exact: true }).click(); await table.waitFor({ state: 'detached' })
  assert.match(await body(), /未提交表格草稿/)
  const tableSaves = await page.evaluate(() => window.calls.filter(c => c.command === 'save_document').length)
  await page.waitForTimeout(1300); assert.equal(await page.evaluate(() => window.calls.filter(c => c.command === 'save_document').length), tableSaves)
  page.once('dialog', native => native.accept()); await banner().getByRole('button', { name: '重新加载磁盘版本' }).click(); await banner().waitFor({ state: 'detached' })
  assert.equal(await body(), '# 表格外部变化')
  report.checks.push('external inspection preserves unsubmitted table draft, reload is gated, applying the cell keeps autosave paused until explicit resolution')

  const png = await page.evaluate(async () => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2; canvas.getContext('2d').fillRect(0, 0, 2, 2); return [...new Uint8Array(await (await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))).arrayBuffer())] })
  await page.locator('.document-panel:not([hidden]) input[type=file]').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from(png) })
  const image = page.getByRole('dialog', { name: '编辑图片副本', exact: true })
  await image.getByLabel('Alt 文本', { exact: true }).fill('图片待提交')
  await page.evaluate(() => { window.disk.table = { text: '# 图片编辑期间磁盘变化', revision: 'table-3' }; window.dispatchEvent(new Event('focus')) })
  await banner().waitFor(); assert.equal(await image.getByLabel('Alt 文本', { exact: true }).inputValue(), '图片待提交')
  await image.getByRole('button', { name: '应用修改', exact: true }).click(); await image.getByRole('alert').filter({ hasText: '磁盘版本' }).waitFor()
  assert.equal(await body(), '# 表格外部变化'); assert.equal(await page.evaluate(() => window.calls.filter(c => c.command === 'save_document').length), tableSaves)
  await image.getByRole('button', { name: '取消', exact: true }).click(); await image.waitFor({ state: 'detached' })
  await banner().getByRole('button', { name: '比较外部版本' }).click(); await dialog().waitFor()
  await dialog().getByRole('button', { name: '分析三方合并', exact: true }).click(); await candidate().waitFor()
  for (const theme of ['dark', 'paper', 'forest']) {
    await page.evaluate(theme => { document.querySelector('.application').dataset.theme = theme }, theme)
    await page.screenshot({ path: `test-results/external/${theme}.png` })
  }
  await page.setViewportSize({ width: 430, height: 600 })
  const bounds = await dialog().boundingBox(); assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 430 && bounds.y + bounds.height <= 600, JSON.stringify({ viewport: page.viewportSize(), bounds }))
  await page.screenshot({ path: 'test-results/external/compact.png' })
  report.checks.push('pending image recipe survives external change; apply cannot write stale disk or source, comparison remains within compact viewport')
  await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'detached' }); await page.setViewportSize({ width: 1150, height: 850 })
  await page.evaluate(() => { window.disk.merge = { text: '# 基线\n\n中间 😀\n\n结尾\n', revision: 'merge-base' }; window.nextOpen = 'merge' })
  await menu('打开文件')
  await page.waitForFunction(() => window.calls.some(c => c.command === 'inspect_document' && c.args.id === 'merge'))
  await fillSource(page, '# 本地标题\n\n中间 😀\n\n结尾\n')
  await page.evaluate(() => { window.disk.merge = { text: '# 基线\n\n中间 😀\n\n磁盘结尾\n', revision: 'merge-external' }; window.dispatchEvent(new Event('focus')) })
  await banner().waitFor(); const mergeSaves = await page.evaluate(() => window.calls.filter(c => c.command === 'save_document').length)
  await banner().getByRole('button', { name: '比较外部版本' }).click(); await dialog().getByRole('button', { name: '分析三方合并', exact: true }).click()
  await candidate().waitFor(); assert.equal(await candidate().inputValue(), '# 本地标题\n\n中间 😀\n\n磁盘结尾\n')
  await page.screenshot({ path: 'test-results/external/merge-preview.png' })
  await dialog().getByRole('button', { name: '收起三方合并分析', exact: true }).click(); assert.equal(await analysis().count(), 0)
  await dialog().getByRole('button', { name: '分析三方合并', exact: true }).click(); await candidate().waitFor()
  await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'detached' }); await page.waitForTimeout(1400)
  assert.equal(await body(), '# 本地标题\n\n中间 😀\n\n结尾\n')
  assert.equal(await page.evaluate(() => window.disk.merge.text), '# 基线\n\n中间 😀\n\n磁盘结尾\n')
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.command === 'save_document').length), mergeSaves)
  report.checks.push('independent changes combine without losing final newline; collapse/reopen/Escape retain both versions and keep autosave blocked')
  assert.deepEqual(errors, []); report.passed = true
} catch (error) { report.error = error.stack; process.exitCode = 1; await page?.screenshot({ path: 'test-results/external/failure.png' }).catch(() => {}) }
finally { await writeFile('test-results/external-verification.json', JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2)); await browser?.close(); await server.close() }
