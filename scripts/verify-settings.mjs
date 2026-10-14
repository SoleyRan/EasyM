import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { serveProduction } from './serve-production.mjs'

const { version } = JSON.parse(await readFile('package.json', 'utf8'))
const server = await serveProduction()
const report = { passed: false, version, checks: [], scope: 'Production Chromium UI with simulated desktop IPC. Real archive migration and data integrity covered by Rust tests; native directory picker remains manual.' }
let browser
await mkdir('test-results/settings', { recursive: true })
try {
  browser = await chromium.launch({ channel: process.env.EASYM_TEST_BROWSER || undefined })
  report.browser = browser.version()
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } }), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    window.isTauri = true
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
    window.settingsCalls = []; window.directoryMode = ''; window.customDirectory = false
    let callback = 0
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' } }, transformCallback: () => ++callback,
      invoke: async (command, args) => {
        if (command === 'recent_state') return { entries: [], session: { tabs: [], activeDraftKey: null, workspaceId: null } }
        if (command === 'remember_session') return

        window.settingsCalls.push({ command, args })
        if (command.startsWith('plugin:window|is_')) return false
        if (command.startsWith('plugin:')) return 1
        if (command === 'open_document') return { id: 'settings-file', name: '设置文档.md', bytes: [...new TextEncoder().encode('# 保留正文\n\n内容')], revision: 'baseline' }
        if (command === 'close_document') return
        if (command === 'history_directory') {
          if (args.action !== 'status') {
            if (window.directoryMode === 'cancel') return null
            if (window.directoryMode === 'fail') throw 'history_corrupt'
            if (window.directoryMode === 'slow') await new Promise(resolve => { window.finishDirectory = resolve })
            window.customDirectory = args.action === 'choose'
          }
          return { path: window.customDirectory ? 'D:/历史/EasyM-history/库' : 'D:/文档/.easym/history', documentDirectory: 'D:/文档', custom: window.customDirectory, retainedPath: args.action === 'status' ? undefined : 'D:/原历史' }
        }
        throw new Error(`Unexpected IPC: ${command}`)
      }
    }
  })
  await page.goto(server.url)
  const guide = page.getByRole('dialog', { name: 'EasyM 使用导引', exact: true })
  await guide.waitFor(); assert.match(await guide.innerText(), /开始写作/)
  assert.equal(await guide.locator('section').count(), 1)
  assert.equal(await page.locator('.document-panel:not([hidden])').evaluate(el => el.inert), true)
  await page.keyboard.press('Tab'); assert.equal(await guide.evaluate(el => el.contains(document.activeElement)), true)
  await page.keyboard.press('Shift+Tab'); assert.equal(await guide.evaluate(el => el.contains(document.activeElement)), true)
  await page.screenshot({ path: 'test-results/settings/first-run.png' })
  const titles = ['开始写作', '编辑与自动保存', '版本历史 · 找回以前的内容', '图片、导出与阅读']
  for (let index = 0; index < titles.length; index++) {
    assert.equal(await guide.locator('section').count(), 1)
    assert.equal(await guide.getByRole('heading', { level: 3 }).innerText(), titles[index])
    assert.match(await guide.getByRole('status').innerText(), new RegExp(`${index + 1} / 4`))
    await page.screenshot({ path: `test-results/settings/guide-page-${index + 1}.png` })
    if (index < titles.length - 1) await guide.getByRole('button', { name: '下一页', exact: true }).click()
  }
  await guide.getByRole('button', { name: '上一页', exact: true }).click()
  assert.equal(await guide.getByRole('heading', { level: 3 }).innerText(), titles[2])
  await page.keyboard.press('ArrowRight')
  assert.equal(await guide.getByRole('heading', { level: 3 }).innerText(), titles[3])
  await guide.getByRole('button', { name: '开始使用', exact: true }).click()
  await page.reload(); await page.getByRole('button', { name: 'EM 菜单', exact: true }).waitFor()
  assert.equal(await guide.count(), 0)
  await page.evaluate(() => localStorage.setItem('easym-guide-version', '0.2.0'))
  await page.reload(); await guide.waitFor(); assert.match(await guide.innerText(), new RegExp(`已更新到 EasyM ${version.replaceAll('.', '\\.')}`))
  await page.keyboard.press('Escape'); await guide.waitFor({ state: 'detached' })
  report.checks.push('four guide pages, forward/back/keyboard navigation, first-run, version update, acknowledgment across reload, focus trap, Escape')
  const openSettings = async () => { await page.getByRole('button', { name: 'EM 菜单', exact: true }).click(); await page.getByRole('menuitem', { name: '设置', exact: true }).click() }
  await openSettings()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  assert.match(await settings.innerText(), /请先打开或另存/)
  await settings.getByLabel('设置配色主题', { exact: true }).selectOption('dark')
  await settings.getByLabel('编辑字号', { exact: true }).selectOption('20')
  await settings.getByRole('checkbox', { name: '显示格式工具栏', exact: true }).uncheck()
  await page.screenshot({ path: 'test-results/settings/settings-dark.png' })
  await settings.getByRole('button', { name: '完成', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: 'EM 菜单', exact: true }).evaluate(el => el === document.activeElement), true)
  await page.reload()
  assert.equal(await page.locator('.application').getAttribute('data-theme'), 'dark')
  assert.equal(await page.locator('.cm-editor').first().evaluate(el => getComputedStyle(el).fontSize), '20px')
  assert.equal(await page.locator('.toolbar').isVisible(), false)
  report.checks.push('appearance persists, editor font applied, unsaved document guidance, return focus')
  await page.getByRole('button', { name: 'EM 菜单', exact: true }).click(); await page.getByRole('menuitem', { name: '打开文件', exact: true }).click()
  await page.getByRole('tab', { name: '设置文档.md', exact: true }).waitFor()
  await openSettings(); await settings.getByRole('button', { name: '选择历史目录…', exact: true }).waitFor({ state: 'visible' })
  const choose = settings.getByRole('button', { name: '选择历史目录…', exact: true }), reset = settings.getByRole('button', { name: '恢复默认目录', exact: true })
  await choose.click(); await settings.getByRole('status').filter({ hasText: '历史保存位置已更新' }).waitFor()
  assert.match(await settings.innerText(), /D:\/历史/); assert.equal(await reset.isEnabled(), true)
  await page.evaluate(() => { window.directoryMode = 'cancel' }); await choose.click()
  await settings.getByRole('status').filter({ hasText: '已取消' }).waitFor(); assert.match(await settings.innerText(), /D:\/历史/)
  await page.evaluate(() => { window.directoryMode = 'fail' }); await reset.click()
  await settings.getByRole('alert').waitFor(); assert.match(await settings.getByRole('alert').innerText(), /哈希校验失败/)
  await page.evaluate(() => { window.directoryMode = 'slow' }); await reset.click()
  assert.equal(await settings.getByRole('button', { name: '完成', exact: true }).isDisabled(), true)
  await page.keyboard.press('Escape'); assert.equal(await settings.count(), 1)
  await page.evaluate(() => window.finishDirectory()); await settings.getByRole('status').filter({ hasText: '历史保存位置已更新' }).waitFor()
  assert.equal(await reset.isDisabled(), true)
  for (const theme of ['light', 'dark', 'paper', 'forest']) {
    await settings.getByLabel('设置配色主题', { exact: true }).selectOption(theme)
    assert.equal(await settings.evaluate(el => el.scrollWidth <= el.clientWidth), true)
    await page.screenshot({ path: `test-results/settings/settings-${theme}.png` })
  }
  await settings.getByRole('button', { name: '查看使用导引', exact: true }).click(); await guide.waitFor()
  assert.equal(await guide.getByRole('heading', { level: 3 }).innerText(), titles[0])
  for (let index = 0; index < 3; index++) await guide.getByRole('button', { name: '下一页', exact: true }).click()
  await guide.getByRole('button', { name: '开始使用', exact: true }).click()
  const calls = await page.evaluate(() => window.settingsCalls)
  assert.equal(calls.filter(c => c.command === 'history_directory').every(c => c.args.id === 'settings-file'), true)
  assert.equal(calls.some(c => c.command === 'save_document'), false)
  assert.equal(await page.getByRole('tab', { name: '设置文档.md', exact: true }).count(), 1)
  assert.deepEqual(errors, [])
  report.checks.push('authorized directory operations, cancellation, integrity errors, busy lock, reset, four themes, manual guide')
  report.passed = true
} catch (error) { report.error = error.stack; process.exitCode = 1; console.error(error) }
finally { await writeFile('test-results/settings-verification.json', JSON.stringify(report, null, 2) + '\n'); await browser?.close(); await server.close() }
