import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { serveProduction, acknowledgeGuide, selectAppearanceTheme } from './serve-production.mjs'
import { fillSource } from './source-test-utils.mjs'

const server = await serveProduction(), report = { passed: false, checks: [], scope: 'Production Chromium keyboard/pointer; desktop IPC fixture plus Rust filesystem tests. Real IME/native dialogs remain manual.' }
let browser, page
await mkdir('test-results/quick-entry', { recursive: true })
try {
  browser = await chromium.launch({ channel: process.env.EASYM_TEST_BROWSER || undefined }); report.browser = browser.version()
  page = await browser.newPage({ viewport: { width: 1120, height: 800 } })
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await acknowledgeGuide(page); await page.goto(server.url)
  const source = () => page.locator('.document-panel:not([hidden])').getByRole('textbox', { name: 'Markdown 源码编辑器' })
  const body = () => source().evaluate(node => [...node.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'))
  const slash = page.getByRole('menu', { name: '快捷插入', exact: true })
  await fillSource(page, '/h2'); await slash.waitFor(); assert.equal(await source().evaluate(node => node === document.activeElement), true)
  await source().press('Enter'); await slash.waitFor({ state: 'detached' }); assert.equal(await body(), '## ')
  await source().press('Control+z'); assert.equal(await body(), '/h2'); await source().press('Control+Shift+Z'); assert.equal(await body(), '## ')
  await fillSource(page, '/不存在'); await slash.waitFor(); assert.match(await slash.innerText(), /没有匹配结果/)
  await source().press('Enter'); assert.equal(await body(), '/不存在'); await page.keyboard.press('Escape'); await slash.waitFor({ state: 'detached' }); assert.equal(await body(), '/不存在')
  for (const value of ['hello /h1', 'https://example.com', '/notes/a.md', '```\n/h1\n```', '| a | b |\n| --- | --- |\n| /h1 | b |', '---\n/h1\n---']) {
    await fillSource(page, value); await page.waitForTimeout(140); assert.equal(await slash.count(), 0, value)
  }
  await fillSource(page, '/'); await slash.waitFor(); await source().press('End'); await source().press('Home'); await source().press('ArrowDown'); await source().press('ArrowDown'); await source().press('Enter'); assert.equal(await body(), '# ')
  const image = page.locator('.image-panel'); assert.equal(await image.count(), 0)
  report.checks.push('slash passive focus, Chinese/English and empty filtering, nontriggers, navigation, atomic undo/redo and Escape preserves query')

  await fillSource(page, '/table'); await slash.waitFor(); await source().press('Enter')
  const table = page.getByRole('dialog', { name: '插入表格', exact: true }); await table.waitFor(); await table.getByRole('button', { name: '取消', exact: true }).click(); assert.equal(await body(), '/table')
  await fillSource(page, '/table'); await slash.waitFor(); await slash.getByRole('menuitem', { name: '插入表格', exact: true }).click(); await table.waitFor(); await table.getByRole('button', { name: '创建表格', exact: true }).click()
  const cell = page.getByRole('dialog', { name: '编辑表格', exact: true }); await cell.waitFor(); await page.keyboard.press('Escape'); await cell.waitFor({ state: 'detached' }); await source().press('Control+z'); assert.equal(await body(), '/table')
  await fillSource(page, '/image'); await slash.waitFor()
  const chooserPromise = page.waitForEvent('filechooser'); await source().press('Enter'); const chooser = await chooserPromise
  await chooser.element().dispatchEvent('cancel'); assert.equal(await body(), '/image')
  const pngBytes = await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(2, 2), context = canvas.getContext('2d')
    context.fillStyle = '#336699'; context.fillRect(0, 0, 2, 2)
    return [...new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())]
  })
  const png = { name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from(pngBytes) }
  const pickImage = async () => { await fillSource(page, '/image'); await slash.waitFor(); const picked = page.waitForEvent('filechooser'); await source().press('Enter'); await (await picked).setFiles(png); await page.getByRole('dialog', { name: '编辑图片副本', exact: true }).waitFor() }
  await pickImage(); await page.getByRole('dialog', { name: '编辑图片副本', exact: true }).getByRole('button', { name: '取消', exact: true }).click(); assert.equal(await body(), '/image')
  await pickImage(); await page.getByRole('button', { name: '应用修改', exact: true }).click(); await page.getByRole('dialog', { name: '编辑图片副本', exact: true }).waitFor({ state: 'detached' }); assert.match(await body(), /!\[pixel\]\(assets\/img-/); assert.ok(!(await body()).includes('/image')); await source().press('Control+z'); assert.equal(await body(), '/image')
  report.checks.push('table/image follow-up cancel retains slash input; confirmation replaces trigger and one undo restores it')

  await fillSource(page, 'hello'); await source().press('Control+Home'); await source().press('Shift+End'); await source().press('F1')
  const palette = page.getByRole('dialog', { name: '命令面板', exact: true }), query = palette.getByRole('combobox')
  await palette.waitFor(); await query.fill('bold'); await query.press('Enter'); await palette.waitFor({ state: 'detached' }); await page.waitForFunction(() => document.querySelector('.document-panel:not([hidden]) .cm-line')?.textContent === '**hello**'); assert.equal(await body(), '**hello**')
  await source().press('Control+z'); assert.equal(await body(), 'hello')
  await source().press('F1'); await query.fill('选择代码语言'); const disabled = palette.getByRole('option'); assert.equal(await disabled.getAttribute('aria-disabled'), 'true'); assert.match(await disabled.innerText(), /光标/); await query.press('Enter'); assert.equal(await palette.count(), 1)
  await query.fill('nothing-matches'); assert.equal(await palette.getByRole('option').count(), 0); await query.press('Escape'); await palette.waitFor({ state: 'detached' })
  await source().press('F1'); await query.fill('settings'); await query.press('Enter'); const settings = page.getByRole('dialog', { name: '设置', exact: true }); await settings.waitFor(); await page.keyboard.press('F1'); assert.equal(await palette.count(), 0); await settings.getByRole('button', { name: '完成', exact: true }).click()
  report.checks.push('F1 palette searches shared commands, preserves selected range, shows disabled reasons, guards modal nesting and supports settings handoff')

  await page.getByRole('button', { name: '新建标签', exact: true }).click(); await fillSource(page, 'second tab')
  await source().press('Control+Alt+o'); const quick = page.getByRole('dialog', { name: '快速打开', exact: true }); await quick.waitFor(); assert.equal(await quick.getByRole('option').count(), 2); assert.match(await quick.innerText(), /浏览器演示仅搜索/)
  await quick.getByRole('combobox').press('Home'); await quick.getByRole('combobox').press('Enter'); await quick.waitFor({ state: 'detached' }); assert.equal(await body(), 'hello'); assert.equal(await page.getByRole('tab').count(), 2)
  await source().press('F1'); await query.dispatchEvent('compositionstart', { data: '中' }); await query.fill('加粗'); await query.press('Enter'); await query.press('Escape'); assert.equal(await palette.count(), 1); await query.dispatchEvent('compositionend', { data: '中' }); await query.press('Escape'); await palette.waitFor({ state: 'detached' })
  await fillSource(page, '/h1'); await slash.waitFor(); await source().dispatchEvent('compositionstart', { data: '中' }); await slash.waitFor({ state: 'detached' }); await source().dispatchEvent('compositionend', { data: '中' }); await slash.waitFor(); await page.keyboard.press('Escape')
  report.checks.push('opened-tab quick switch retains edits without duplicate tabs; synthetic composition blocks acceptance and Escape')
  for (const theme of ['light', 'dark', 'paper', 'forest']) { await selectAppearanceTheme(page, theme); await source().press('F1'); await palette.waitFor(); await page.screenshot({ path: `test-results/quick-entry/${theme}.png` }); await query.press('Escape') }
  await page.setViewportSize({ width: 760, height: 600 }); await source().press('F1'); await palette.waitFor(); const bounds = await palette.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 760 && bounds.y + bounds.height <= 600); await page.screenshot({ path: 'test-results/quick-entry/compact.png' }); await query.press('Escape')
  report.checks.push('four themes and compact window palette bounds')

  const native = await browser.newPage(); native.on('pageerror', error => errors.push(error.message)); await acknowledgeGuide(native)
  await native.addInitScript(() => {
    window.isTauri = true; window.quickCalls = []; window.quickSlow = false; window.quickFail = false
    let callback = 0; window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' } }, transformCallback: () => ++callback, invoke: async (command, args) => {
        if (command === 'recent_state') return { entries: [], session: { tabs: [], activeDraftKey: null, workspaceId: null } }
        if (command === 'remember_session') return

      window.quickCalls.push({ command, args })
      if (command.startsWith('plugin:window|is_')) return false
      if (command.startsWith('plugin:')) return 1
      if (command === 'open_workspace') return { id: 'work', name: '工作区', entries: [] }
      if (command === 'search_workspace_filenames') { if (args.query === 'slow') await new Promise(resolve => setTimeout(resolve, 450)); return { paths: args.query === 'none' ? [] : ['中文 notes/同名.md', 'other/同名.md'], scanned: 10000, skipped: 2, limited: true, cancelled: false } }
      if (command === 'open_workspace_document') { if (window.quickSlow) await new Promise(resolve => setTimeout(resolve, 450)); if (window.quickFail) throw new Error('resource_missing'); return { id: args.relativePath.startsWith('other/') ? 'other-doc' : 'doc', name: '同名.md', revision: 'hash', bytes: [...new TextEncoder().encode('# 原文')] } }
      if (command === 'close_document' || command === 'cancel_workspace_search') return
      if (command === 'history_operation') return { entries: [], enabled: false }
      if (command === 'save_document') return { id: 'doc', name: '同名.md', revision: 'hash2', destination: 'disk' }
      throw new Error('Unexpected command ' + command)
    } }
  })
  await native.goto(server.url); await native.getByRole('button', { name: 'EM 菜单' }).click(); await native.getByRole('menuitem', { name: '打开工作区', exact: true }).click()
  const nsource = () => native.locator('.document-panel:not([hidden])').getByRole('textbox', { name: 'Markdown 源码编辑器' }), nquick = native.getByRole('dialog', { name: '快速打开', exact: true })
  await nsource().press('Control+Alt+o'); await nquick.waitFor(); await nquick.getByRole('option', { name: /工作区 · 中文 notes/ }).waitFor(); assert.match(await nquick.innerText(), /结果受限，请缩小查询/)
  await nquick.getByRole('combobox').fill('slow'); await native.waitForFunction(() => window.quickCalls.some(call => call.command === 'search_workspace_filenames' && call.args.query === 'slow')); await nquick.getByRole('combobox').fill('none'); await native.waitForTimeout(700); assert.equal(await nquick.getByRole('option').count(), 0); assert.ok(await native.evaluate(() => window.quickCalls.some(call => call.command === 'cancel_workspace_search')))
  await nquick.getByRole('combobox').fill('同名'); await nquick.getByRole('option', { name: /工作区 · 中文 notes/ }).click(); await nquick.waitFor({ state: 'detached' }); assert.equal(await native.getByRole('tab').count(), 2)
  await fillSource(native, '# 未保存编辑'); await nsource().press('Control+Alt+o'); await nquick.getByRole('option', { name: /工作区 · 中文 notes/ }).click(); await nquick.waitFor({ state: 'detached' }); assert.equal(await native.getByRole('tab').count(), 2); assert.match(await nsource().innerText(), /未保存编辑/)
  await native.evaluate(() => { window.quickSlow = true }); await nsource().press('Control+Alt+o'); await nquick.getByRole('option', { name: /工作区 · other/ }).click(); await nquick.getByRole('combobox').press('Escape'); await native.waitForFunction(() => window.quickCalls.some(call => call.command === 'close_document' && call.args.id === 'other-doc')); assert.equal(await native.getByRole('tab').count(), 2)
  await native.evaluate(() => { window.quickSlow = false; window.quickFail = true }); await nsource().press('Control+Alt+o'); await nquick.getByRole('option', { name: /工作区 · other/ }).click(); await nquick.getByRole('alert').waitFor(); assert.match(await nsource().innerText(), /未保存编辑/); await nquick.getByRole('combobox').press('Escape')
  report.checks.push('desktop IPC fixture: bounded report, same-name paths, debounced cancellation/stale search, tab reuse, cancelled open handle ownership and missing-file preserves body')
  assert.deepEqual(errors, []); report.passed = true
} catch (error) { report.error = error.stack; if (page) await page.screenshot({ path: 'test-results/quick-entry/failure.png' }).catch(() => {}); throw error }
finally { await writeFile('test-results/quick-entry-verification.json', JSON.stringify(report, null, 2) + '\n'); await browser?.close(); await server.close() }
console.log(JSON.stringify(report, null, 2))
