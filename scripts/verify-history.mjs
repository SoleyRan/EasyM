import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { serveProduction, acknowledgeGuide } from './serve-production.mjs'
import { fillSource } from './source-test-utils.mjs'

const server = await serveProduction(), report = { stage: 'v0.3-step4', passed: false, verifiedAt: new Date().toISOString(), checks: [], scope: 'Production UI with deterministic desktop IPC fixture; real history filesystem, transactions and fault injection covered by locked Rust tests. Native file dialogs and cross-platform WebView remain manual.' }
let browser, page
await mkdir('test-results/history', { recursive: true })
try {
  browser = await chromium.launch({ channel: process.env.EASYM_TEST_BROWSER || undefined }); report.browser = browser.version()
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = [], remote = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('request', request => { if (/^https?:\/\//.test(request.url()) && !request.url().startsWith(server.url)) remote.push(request.url()) })
  await page.addInitScript(() => {
    window.isTauri = true; window.historyCalls = []; window.historyMode = ''; window.historyEnabled = false; window.historyCopies = 0
    const encoder = new TextEncoder(), old = '# 旧版中文\n\n旧正文', current = '# 当前中文\n\n当前正文'
    window.historyBody = current; window.historyRevision = 'current-revision'; window.historySnapshots = []
    const snapshot = (id, text, reason = 'manual') => ({ schemaVersion: 1, snapshotId: id, documentId: 'persistent-document', parentSnapshotId: null, createdAt: Date.now() - (id === 'baseline' ? 5000 : 0), reason, bodyHash: id, bodySize: encoder.encode(text).length, encoding: 'utf-8', lineEnding: 'lf', diskRevision: 'disk', resources: [], metadata: { schemaVersion: 1, instances: [] }, complete: true, name: null, pinned: false, fixtureText: text })
    const state = () => ({ enabled: window.historyEnabled, documentId: 'persistent-document', readOnly: false, usedBytes: 12345, budgetBytes: 512 * 1024 * 1024, paused: false, snapshots: structuredClone(window.historySnapshots), orphans: [] })
    let callback = 0
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } }, transformCallback: () => ++callback,
      invoke: async (command, args) => {
        if (command === 'recent_state') return { entries: [], session: { tabs: [], activeDraftKey: null, workspaceId: null } }
        if (command === 'remember_session') return

        window.historyCalls.push({ command, args })
        if (command.startsWith('plugin:window|is_')) return false
        if (command.startsWith('plugin:')) return 1
        if (command === 'open_document') return { id: 'authorized-file', name: '中文 history.md', bytes: [...encoder.encode(window.historyBody)], revision: window.historyRevision }
        if (command === 'close_document') return
        if (command === 'save_document') { window.historyBody = new TextDecoder().decode(new Uint8Array(args.bytes)); window.historyRevision = 'saved-' + Date.now(); return { id: 'authorized-file', name: '中文 history.md', revision: window.historyRevision } }
        if (command === 'history_directory') return { path: '/fixture/.easym/history', documentDirectory: '/fixture', custom: false }
        if (command !== 'history_operation') throw new Error(`Unexpected command ${command}`)
        const r = args.request
        if (r.action === 'status') return window.historyMode === 'unknown' ? { ...state(), readOnly: true, enabled: false, warning: '历史格式版本较新；已保留原数据。' } : state()
        if (r.action === 'enable') { window.historyEnabled = true; window.historySnapshots = [snapshot('baseline', current, 'baseline'), snapshot('old', old)]; return state() }
        if (r.action === 'capture') { if (window.historyMode === 'quota') throw 'history_quota'; const item = snapshot('manual-' + window.historySnapshots.length, new TextDecoder().decode(new Uint8Array(r.input.bytes))); item.name = r.name; window.historySnapshots.unshift(item); return state() }
        const item = window.historySnapshots.find(s => s.snapshotId === r.snapshotId)
        if (r.action === 'detail') { if (window.historyMode === 'corrupt') throw 'history_corrupt'; return { snapshot: item, bytes: [...encoder.encode(item.fixtureText)] } }
        if (r.action === 'annotate') { item.name = r.name; item.pinned = r.pinned; return state() }
        if (r.action === 'configure') return { ...state(), budgetBytes: r.budgetMiB * 1024 * 1024 }
        if (r.action === 'prepare') return { relocations: {}, metadata: { schemaVersion: 1, instances: [] } }
        if (r.action === 'restore') {
          if (window.historyMode === 'conflict') throw 'revision_conflict'
          if (r.expectedRevision !== window.historyRevision) throw 'revision_conflict'
          window.historySnapshots.unshift(snapshot('pre-restore', new TextDecoder().decode(new Uint8Array(r.current.bytes)), 'pre-restore'))
          window.historyBody = new TextDecoder().decode(new Uint8Array(r.bytes)); window.historyRevision = 'restored-revision'
          window.historySnapshots.unshift(snapshot('restored', window.historyBody, 'restore'))
          return { revision: window.historyRevision, metadata: { schemaVersion: 1, instances: [] }, preSnapshotId: 'pre-restore' }
        }
        if (r.action === 'copy') { window.historyCopies++; return window.historyMode === 'cancel-copy' ? null : { name: 'history-copy.md', bodyOnly: r.bodyOnly } }
        if (r.action === 'cleanupPreview') return { candidates: window.historySnapshots.filter(s => r.selected.includes(s.snapshotId)).map(s => ({ document: '中文 history.md', ...s })), token: 'reviewed', reclaimBytes: 10 }
        if (r.action === 'cleanupCommit') { if (r.token !== 'reviewed') throw 'revision_conflict'; window.historySnapshots = window.historySnapshots.filter(s => !r.selected.includes(s.snapshotId)); return state() }
        throw new Error(`Unexpected history action ${r.action}`)
      },
    }
  })
  await acknowledgeGuide(page)
  await page.goto(server.url)
  const menu = async name => { await page.getByRole('button', { name: 'EM 菜单', exact: true }).click(); await page.getByRole('menuitem', { name, exact: true }).click() }
  const editor = () => page.locator('.document-panel:not([hidden]) [aria-label="Markdown 源码编辑器"]')
  const source = () => editor().evaluate(element => [...element.querySelectorAll('.cm-line')].map(l => l.textContent).join('\n'))
  const dialog = page.getByRole('dialog', { name: '版本历史', exact: true })
  const idle = () => page.waitForFunction(() => document.querySelector('.history-dialog')?.getAttribute('aria-busy') === 'false')
  const open = async () => { await menu('版本历史'); await dialog.waitFor(); await idle() }
  await open(); assert.match(await dialog.innerText(), /请先.*另存为/); await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'EM 菜单', exact: true }).waitFor()
  await page.waitForFunction(() => document.activeElement?.matches('.app-menu-trigger'))
  assert.equal(await page.getByRole('button', { name: 'EM 菜单' }).evaluate(e => document.activeElement === e), true)
  await menu('打开文件'); await page.getByRole('tab', { name: '中文 history.md', exact: true }).waitFor()
  await open(); assert.match(await dialog.innerText(), /随|分享/)
  assert.equal(await page.evaluate(() => window.historyCalls.filter(c => c.command === 'history_operation' && c.args.request.action !== 'status').length), 0)
  await dialog.getByRole('button', { name: '启用版本历史', exact: true }).click(); await idle()
  const oldItem = dialog.locator('.history-item').filter({ has: page.locator('input[aria-label="选择清理 old"]') }).getByRole('button')
  await oldItem.click(); await dialog.getByLabel('逐行差异', { exact: true }).waitFor()
  assert.equal(await dialog.getByRole('textbox', { name: '归档正文', exact: true }).inputValue(), '# 旧版中文\n\n旧正文')
  assert.match(await dialog.getByLabel('逐行差异').textContent(), /旧正文/)
  assert.equal(await page.evaluate(() => window.historyCalls.some(c => c.command === 'save_document')), false)
  await dialog.getByRole('textbox', { name: '快照名称', exact: true }).fill('固定的中文版本')
  await dialog.getByRole('button', { name: '保存名称', exact: true }).click(); await idle()
  await dialog.getByRole('button', { name: '固定快照', exact: true }).click(); await idle()
  assert.equal(await dialog.getByRole('checkbox', { name: '选择清理 old', exact: true }).isDisabled(), true)
  await dialog.getByRole('button', { name: '取消固定', exact: true }).click(); await idle()
  report.checks.push('explicit consent, baseline, read-only query, normalized worker line diff, name and pin protection')
  await page.evaluate(() => window.historyMode = 'cancel-copy')
  await dialog.getByRole('button', { name: '另存完整副本', exact: true }).click(); await idle(); assert.match(await dialog.innerText(), /另存已取消/)
  assert.equal(await source(), '# 当前中文\n\n当前正文')
  await page.evaluate(() => window.historyMode = 'conflict')
  await dialog.getByRole('button', { name: '恢复此版本…', exact: true }).click()
  await dialog.getByRole('button', { name: '确认恢复并保存', exact: true }).click(); await idle()
  assert.match(await dialog.getByRole('alert').innerText(), /外部修改/); assert.equal(await source(), '# 当前中文\n\n当前正文')
  await page.evaluate(() => window.historyMode = '')
  await dialog.getByRole('button', { name: '确认恢复并保存', exact: true }).click(); await dialog.waitFor({ state: 'hidden' })
  assert.equal(await source(), '# 旧版中文\n\n旧正文')
  assert.ok(await page.evaluate(() => window.historySnapshots.some(s => s.reason === 'pre-restore' && s.fixtureText.includes('当前正文'))))
  if (await page.getByRole('button', { name: '显示格式工具栏', exact: true }).count()) await page.getByRole('button', { name: '显示格式工具栏', exact: true }).click()
  await editor().press('Control+z'); assert.equal(await source(), '# 当前中文\n\n当前正文')
  await page.getByRole('button', { name: '重做', exact: true }).click(); assert.equal(await source(), '# 旧版中文\n\n旧正文')
  report.checks.push('native copy cancellation, external revision conflict, restore current pre-snapshot and one undo/redo')
  await open(); await dialog.getByRole('textbox', { name: '快照名称', exact: true }).fill('手动编辑版本')
  await dialog.getByRole('button', { name: '创建快照', exact: true }).click(); await idle()
  assert.match(await dialog.innerText(), /手动编辑版本/)
  const manualCheckbox = dialog.locator('.history-item').filter({ hasText: '手动编辑版本' }).getByRole('checkbox')
  await manualCheckbox.check()
  await dialog.getByRole('button', { name: /预览清理/ }).click(); await idle()
  assert.ok(await page.evaluate(() => window.historySnapshots.some(s => s.name === '手动编辑版本')))
  await dialog.getByRole('button', { name: '确认清理', exact: true }).click(); await idle()
  assert.equal(await page.evaluate(() => window.historySnapshots.some(s => s.name === '手动编辑版本')), false)
  await page.evaluate(() => window.historyMode = 'quota')
  await dialog.getByRole('button', { name: '创建快照', exact: true }).click(); await idle(); assert.match(await dialog.getByRole('alert').innerText(), /配额不足/)
  await dialog.getByRole('button', { name: '关闭版本历史', exact: true }).click()
  await page.evaluate(() => window.historyMode = 'corrupt'); await open(); await oldItem.click()
  await dialog.getByRole('alert').filter({ hasText: /哈希校验/ }).waitFor(); assert.equal(await source(), '# 旧版中文\n\n旧正文')
  await page.keyboard.press('Escape'); await page.evaluate(() => window.historyMode = 'unknown'); await open()
  assert.match(await dialog.innerText(), /版本较新/); assert.equal(await dialog.getByRole('button', { name: '启用版本历史' }).count(), 0)
  await page.keyboard.press('Escape'); await page.evaluate(() => window.historyMode = ''); await open(); await oldItem.click(); await dialog.getByLabel('逐行差异').waitFor()
  // Keyboard focus stays within the dialog. Capture all existing themes without changing document state.
  await dialog.getByRole('button', { name: '关闭版本历史', exact: true }).focus(); await page.keyboard.press('Shift+Tab')
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('.history-dialog')), true)
  for (const theme of ['light', 'dark', 'paper', 'forest']) {
    await page.evaluate(theme => document.querySelector('.application').setAttribute('data-theme', theme), theme)
    await page.screenshot({ path: `test-results/history/${theme}.png` })
  }
  report.checks.push('manual capture, preview-before-cleanup, quota/corruption/unknown-schema safety, keyboard focus, four theme screenshots')
  await dialog.getByRole('button', { name: '关闭版本历史', exact: true }).click()
  const expected = await source(); await fillSource(page, '# 保留未保存编辑\n\n原正文')
  // Open synchronously before idle autosave, then capture memory without dispatching a body write.
  await open(); const count = await page.evaluate(() => window.historyCalls.filter(c => c.command === 'save_document').length)
  await dialog.getByRole('button', { name: '创建快照', exact: true }).click(); await idle()
  const capture = await page.evaluate(() => window.historyCalls.filter(c => c.command === 'history_operation' && c.args.request.action === 'capture').at(-1).args.request.input)
  assert.match(new TextDecoder().decode(new Uint8Array(capture.bytes)), /保留未保存编辑/)
  assert.equal(await page.evaluate(() => window.historyCalls.filter(c => c.command === 'save_document').length), count)
  assert.notEqual(await source(), expected)
  assert.deepEqual(errors, []); assert.deepEqual(remote, []); report.checks.push('manual snapshot includes current memory edits; panel locks autosave; no remote requests or uncaught errors')
  report.passed = true
  console.log('History production UI, worker comparison, restoration, undo/redo and cleanup pass.')
} catch (error) {
  report.error = error.message; await page?.screenshot({ path: 'test-results/history/failure.png' }).catch(() => {}); console.error(await page?.locator('body').innerText().catch(() => 'No page')); throw error
} finally {
  report.finishedAt = new Date().toISOString(); await writeFile('test-results/history-verification.json', JSON.stringify(report, null, 2) + '\n'); await browser?.close(); await server.close()
}
