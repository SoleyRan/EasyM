import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { serveProduction, acknowledgeGuide } from './serve-production.mjs'
import { fillSource } from './source-test-utils.mjs'

const server = await serveProduction(), report = { passed: false, checks: [], scope: 'Production Chromium pointer/keyboard and IndexedDB with deterministic desktop IPC. Native registry/path IO is covered separately by Rust tests; no real OS dialog or native restart claim.' }
let browser, page
await mkdir('test-results/recent', { recursive: true })
try {
  browser = await chromium.launch({ channel: process.env.EASYM_TEST_BROWSER || undefined }); report.browser = browser.version()
  page = await browser.newPage({ viewport: { width: 1120, height: 800 } })
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await acknowledgeGuide(page); await page.goto(server.url)
  await page.getByRole('button', { name: 'EM 菜单', exact: true }).click()
  assert.equal(await page.getByRole('menuitem', { name: '最近打开', exact: true }).isDisabled(), true)
  report.checks.push('browser does not pretend to retain native disk permission')
  await page.close(); page = await browser.newPage({ viewport: { width: 1120, height: 800 } }); page.on('pageerror', error => errors.push(error.message))
  await acknowledgeGuide(page)
  await page.addInitScript(() => {
    const initial = { entries: [{ id: 'a', kind: 'file', name: '同名.md', location: 'D:/中文/同名.md' }, { id: 'b', kind: 'file', name: '同名.md', location: 'D:/other/同名.md' }, { id: 'c', kind: 'file', name: 'cancel.md', location: 'D:/cancel.md' }, { id: 'missing', kind: 'file', name: 'missing.md', location: 'D:/missing.md' }, { id: 'ws', kind: 'workspace', name: '中文项目', location: 'D:/中文项目' }], session: { tabs: [], activeDraftKey: null, workspaceId: null }, bodies: { a: '# 磁盘 A\n\n中文 😀', b: '# 磁盘 B', c: '# cancelled file' } }
    const read = () => JSON.parse(localStorage.getItem('native-recent-fixture') || JSON.stringify(initial))
    const write = value => localStorage.setItem('native-recent-fixture', JSON.stringify(value))
    window.isTauri = true; window.calls = []; let callback = 0
    const processId = crypto.randomUUID(), handles = new Map()
    const file = id => { const state = read(); if (!state.bodies[id]) throw 'resource_missing'; if (!handles.has(id)) handles.set(id, `${processId}:${id}`); return { id: handles.get(id), recentId: id, name: state.entries.find(e => e.id === id)?.name ?? '同名.md', revision: state.bodies[id], bytes: [...new TextEncoder().encode(state.bodies[id])] } }
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' } }, transformCallback: () => ++callback, invoke: async (command, args) => {
      window.calls.push({ command, args })
      if (command.startsWith('plugin:window|is_')) return false
      if (command.startsWith('plugin:')) return 1
      if (command === 'recent_state') { const { entries, session } = read(); return { entries, session } }
      if (command === 'remember_session') { const state = read(); state.session = args.session; write(state); return }
      if (command === 'forget_recent') { const state = read(); state.entries = state.entries.filter(e => args.id && e.id !== args.id); write(state); return }
      if (command === 'open_document') return file('a')
      if (command === 'reopen_recent_file') { if (window.slowFile === args.id) await new Promise(resolve => setTimeout(resolve, 600)); return file(args.id) }
      if (command === 'open_workspace' || command === 'reopen_recent_workspace') return { id: `${processId}:workspace`, recentId: 'ws', name: '中文项目', entries: [{ path: '同名.md', name: '同名.md', kind: 'document' }] }
      if (command === 'open_workspace_document') return file('a')
      if (command === 'save_document') { if (window.failSave) throw 'io_failed'; const id = [...handles.entries()].find(([, handle]) => handle === args.id)?.[0]; if (!id) throw 'permission_denied'; const state = read(); state.bodies[id] = new TextDecoder().decode(new Uint8Array(args.bytes)); write(state); return { ...file(id), bytes: undefined } }
      if (command === 'close_document') return
      if (command === 'history_operation') throw 'history_disabled'
      throw new Error(`Unexpected IPC ${command}`)
    } }
  })
  await page.goto(server.url)
  const menu = async label => { await page.getByRole('button', { name: 'EM 菜单', exact: true }).click(); await page.getByRole('menuitem', { name: label, exact: true }).click() }
  const recent = () => page.getByRole('dialog', { name: '最近打开', exact: true })
  const row = id => recent().locator('.recent-row').filter({ hasText: id })
  const body = () => page.locator('.document-panel:not([hidden]) .cm-content').evaluate(node => [...node.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'))
  const waitSession = async () => page.waitForFunction(() => {
    const state = JSON.parse(localStorage.getItem('native-recent-fixture') || 'null')
    const draftKey = node => { const id = node.id.slice(4); return id === 'current' || id.startsWith('document:') ? id : `document:${id}` }
    const tabs = [...document.querySelectorAll('[role=tab]')], active = tabs.find(tab => tab.getAttribute('aria-selected') === 'true')
    return active && state?.session.activeDraftKey === draftKey(active) && state.session.tabs.length === tabs.length && tabs.every((tab, i) => state.session.tabs[i].draftKey === draftKey(tab))
  })
  await menu('打开文件'); assert.equal(await body(), '# 磁盘 A\n\n中文 😀')
  await fillSource(page, '# 自动保存 A'); await page.locator('.document-panel:not([hidden]) .statusbar').filter({ hasText: '已自动保存' }).waitFor(); await waitSession()
  const originalHandle = await page.evaluate(() => window.calls.find(c => c.command === 'save_document').args.id)
  await menu('最近打开'); await row('D:/other/同名.md').locator('.recent-open').click(); assert.equal(await body(), '# 磁盘 B')
  assert.equal(await page.getByRole('tab').count(), 3)
  await page.getByRole('tab').nth(1).click(); await page.evaluate(() => { window.failSave = true })
  await fillSource(page, '# 内存修改 A\n\n不能被磁盘覆盖')
  await menu('最近打开'); await row('D:/中文/同名.md').locator('.recent-open').click()
  assert.equal(await body(), '# 内存修改 A\n\n不能被磁盘覆盖'); assert.equal(await page.getByRole('tab').count(), 3)
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await page.locator('.document-panel:not([hidden]) .statusbar').filter({ hasText: '草稿已保存' }).waitFor(); await waitSession()
  report.checks.push('native IPC: autosave registers persistent identity, same-name paths are distinct, repeated open reuses tab and preserves edits')

  await page.reload(); await page.getByRole('button', { name: '恢复草稿', exact: true }).click()
  assert.equal(await page.getByRole('tab').count(), 2); assert.equal(await body(), '# 内存修改 A\n\n不能被磁盘覆盖')
  const restoredIds = await page.evaluate(() => window.calls.filter(c => c.command === 'reopen_recent_file').map(c => c.args.id))
  assert.deepEqual(restoredIds, ['b'])
  await menu('最近打开'); await row('D:/中文/同名.md').locator('.recent-open').click()
  assert.equal(await body(), '# 自动保存 A'); assert.equal(await page.getByRole('tab').count(), 3)
  await page.waitForFunction(old => window.calls.some(c => c.command === 'reopen_recent_file' && c.args.id === 'a') && !window.calls.some(c => c.command === 'save_document' && c.args.id === old), originalHandle)
  report.checks.push('reload restores saved tab plus independent dirty recovery copy, active order, and explicit original-disk reopen without draft writeback')

  await menu('最近打开'); await row('D:/中文项目').locator('.recent-open').click(); await page.getByRole('button', { name: /刷新文件树/ }).waitFor()
  await waitSession(); await page.waitForFunction(() => JSON.parse(localStorage.getItem('native-recent-fixture')).session.workspaceId === 'ws')
  await menu('最近打开'); await row('D:/missing.md').locator('.recent-open').click(); await recent().getByRole('alert').waitFor()
  assert.equal(await body(), '# 自动保存 A')
  await row('D:/missing.md').getByRole('button', { name: '移除记录 missing.md', exact: true }).click(); await row('D:/missing.md').waitFor({ state: 'detached' })
  assert.equal(await body(), '# 自动保存 A')
  await page.screenshot({ path: 'test-results/recent/same-names.png' })
  await page.evaluate(() => { window.slowFile = 'c' }); await row('D:/cancel.md').locator('.recent-open').click(); await recent().getByRole('button', { name: '完成', exact: true }).click()
  await page.waitForFunction(() => window.calls.some(c => c.command === 'close_document' && c.args.id.endsWith(':c')))
  assert.equal(await page.getByRole('tab').count(), 3); assert.equal(await body(), '# 自动保存 A')
  report.checks.push('workspace reopen persists selection, missing-file failure preserves body, per-record removal and cancelled asynchronous open release unused handle')

  await menu('最近打开'); await recent().getByRole('button', { name: '清空最近记录', exact: true }).click(); await recent().getByText('还没有最近打开记录。', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('native-recent-fixture')).bodies.a), '# 自动保存 A')
  assert.equal(await body(), '# 自动保存 A'); assert.equal(await page.getByRole('tab').count(), 3)
  await recent().getByRole('button', { name: '完成', exact: true }).click()
  await menu('最近打开'); await page.keyboard.press('Escape'); await recent().waitFor({ state: 'detached' })
  assert.equal(await page.getByRole('button', { name: 'EM 菜单', exact: true }).evaluate(node => node === document.activeElement), true)
  report.checks.push('clear history only removes registry entries, leaves disk bodies and open tabs, Escape restores menu focus')
  assert.deepEqual(errors, []); report.passed = true
} catch (error) { report.error = error.stack; process.exitCode = 1; await page?.screenshot({ path: 'test-results/recent/failure.png' }).catch(() => {}) }
finally { await writeFile('test-results/recent-verification.json', JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2)); await browser?.close(); await server.close() }
