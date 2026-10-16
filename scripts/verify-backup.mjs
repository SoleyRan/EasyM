import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { serveProduction, acknowledgeGuide } from './serve-production.mjs'
import { fillSource } from './source-test-utils.mjs'

const server = await serveProduction()
const report = { passed: false, startedAt: new Date().toISOString(), checks: [], scope: 'Production UI and actual resource Worker with deterministic native IPC. Real archive/filesystem behavior is covered by Rust tests; native dialogs, native GUI, and IME are not asserted.' }
let browser, page
await mkdir('test-results/backup', { recursive: true })
try {
  browser = await chromium.launch({ channel: process.env.EASYM_TEST_BROWSER || undefined }); report.browser = browser.version()
  page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await acknowledgeGuide(page)
  await page.addInitScript(() => {
    const encode = text => [...new TextEncoder().encode(text)]
    window.calls = []; window.backupMode = 'cancel'; window.inspectMode = 'cancel'; window.restoreMode = 'cancel'; window.ticketNumber = 0
    window.disk = { text: '\uFEFF# 磁盘正文\r\n', revision: 'disk-1' }
    const file = () => ({ id: 'backup-file', name: '中文-' + 'long-name-'.repeat(18) + '.md', bytes: encode(window.disk.text), revision: window.disk.revision })
    const summary = includeHistory => ({ documentName: file().name, createdAt: 1792108800000, files: 6, bytes: 90000, includesHistory: includeHistory, packageHash: 'sha256:' + 'a'.repeat(64) })
    let callback = 0
    window.isTauri = true; window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' } }, transformCallback: () => ++callback, invoke: async (command, args) => {
      window.calls.push({ command, args })
      if (command.startsWith('plugin:window|is_')) return false
      if (command.startsWith('plugin:')) return 1
      if (command === 'recent_state') return { entries: [], session: { tabs: [], activeDraftKey: null, workspaceId: null } }
      if (command === 'remember_session' || command === 'close_document' || command === 'release_document_backup') return
      if (command === 'open_document') return file()
      if (command === 'inspect_document') return { revision: window.disk.revision, bytes: args.expectedRevision === window.disk.revision ? null : encode(window.disk.text) }
      if (command === 'save_document') {
        if (args.expectedRevision !== window.disk.revision) throw 'revision_conflict'
        window.disk = { text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array(args.bytes)), revision: 'saved-' + crypto.randomUUID() }
        return file()
      }
      if (command === 'create_document_backup') {
        if (window.backupMode === 'hold') await new Promise(resolve => { window.finishBackup = resolve })
        if (window.backupMode === 'error') throw 'backup_exists'
        return window.backupMode === 'cancel' ? null : summary(args.input.includeHistory)
      }
      if (command === 'inspect_document_backup') {
        if (window.inspectMode === 'cancel') return null
        if (window.inspectMode === 'corrupt') throw 'backup_corrupt'
        const valid = window.inspectMode !== 'missing'
        return { token: 'ticket-' + ++window.ticketNumber, summary: summary(true), reviews: [
          { text: '# 恢复正文\n\n' + 'plain '.repeat(12000) + '\n![a][img]\n\n[img]: assets/a.png\n\n`![fake](ignored.png)`', availableReferences: valid ? ['assets/a.png'] : [] },
          { text: '![old](assets/old.png)', availableReferences: ['assets/old.png', 'assets/original.png'] },
        ] }
      }
      if (command === 'restore_document_backup') {
        if (window.restoreMode === 'hold') await new Promise(resolve => { window.finishRestore = resolve })
        if (window.restoreMode === 'changed') throw 'backup_changed'
        if (window.restoreMode === 'expired') throw 'backup_expired'
        return window.restoreMode === 'cancel' ? null : 'fixture/EasyM-restored-new/中文.md'
      }
      throw new Error('Unexpected IPC ' + command)
    } }
  })
  await page.goto(server.url)
  const menu = async name => { await page.getByRole('button', { name: 'EM 菜单', exact: true }).click(); await page.getByRole('menuitem', { name, exact: true }).click() }
  const dialog = () => page.getByRole('dialog', { name: '文档备份与恢复', exact: true })
  const create = () => dialog().getByRole('button', { name: '创建备份…', exact: true })
  const choose = () => dialog().getByRole('button', { name: '选择并校验备份…', exact: true })
  const restore = () => dialog().getByRole('button', { name: '选择父目录并恢复…', exact: true })
  const confirm = () => dialog().getByRole('checkbox', { name: '已审查备份信息，确认恢复到新目录', exact: true })
  const history = () => dialog().getByRole('checkbox', { name: '包含此文档已登记的版本历史', exact: true })
  const status = text => dialog().getByRole('status').filter({ hasText: text }).waitFor()
  const body = () => page.locator('.document-panel:not([hidden]) .cm-content').evaluate(node => [...node.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'))
  const calls = command => page.evaluate(command => window.calls.filter(call => call.command === command), command)

  const local = '# 尚未保存的正文 😀\n'
  await fillSource(page, local); await menu('文档备份与恢复')
  assert.equal(await history().isChecked(), false); assert.equal(await history().isDisabled(), true)
  await create().click(); await status('已取消创建备份')
  const input = (await calls('create_document_backup'))[0].args.input
  assert.equal(new TextDecoder().decode(new Uint8Array(input.bytes)), local)
  assert.equal(input.id, null); assert.equal(input.expectedRevision, null); assert.equal(input.includeHistory, false)
  assert.deepEqual(input.references, []); assert.deepEqual(input.assets, [])
  assert.equal((await calls('save_document')).length, 0)
  await choose().click(); await status('已取消选择备份')
  assert.equal(await restore().count(), 0); assert.equal(await body(), local)
  report.checks.push('new unsaved document uses frozen current bytes with history off; canceled creation and selection do not save or restore')

  await page.evaluate(() => { window.backupMode = 'hold' }); await create().click()
  await page.waitForFunction(() => typeof window.finishBackup === 'function')
  assert.equal(await create().isDisabled(), true); assert.equal(await choose().isDisabled(), true)
  assert.equal(await dialog().getByRole('button', { name: '完成', exact: true }).isDisabled(), true)
  assert.equal(await page.getByRole('button', { name: '新建标签', exact: true }).isDisabled(), true)
  assert.equal(await page.getByRole('tab').first().isDisabled(), true)
  assert.equal(await page.locator('.document-panel:not([hidden]) .app-shell').getAttribute('inert'), '')
  await page.keyboard.press('Escape'); assert.equal(await dialog().count(), 1)
  await page.evaluate(() => window.finishBackup()); await status('备份已创建并校验')
  assert.equal((await calls('create_document_backup')).length, 2); assert.equal(await body(), local)
  report.checks.push('busy create locks editing, tabs, duplicate submission, and Escape; success preserves the editor')
  await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'detached' })

  await menu('打开文件'); await page.waitForFunction(() => window.calls.some(call => call.command === 'inspect_document'))
  await menu('文档备份与恢复'); assert.equal(await history().isDisabled(), false)
  await history().check(); await page.evaluate(() => { window.backupMode = 'ok' }); await create().click(); await status('备份已创建并校验')
  const diskInput = (await calls('create_document_backup')).at(-1).args.input
  assert.deepEqual(diskInput.bytes.slice(0, 3), [239, 187, 191]); assert.equal(diskInput.includeHistory, true)
  assert.equal(new TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array(diskInput.bytes)), '\uFEFF# 磁盘正文\r\n')
  assert.equal(diskInput.expectedRevision, 'disk-1')
  await page.evaluate(() => { window.backupMode = 'error' }); await create().click()
  await dialog().getByRole('alert').filter({ hasText: '未覆盖原文件' }).waitFor()
  report.checks.push('opened document includes history only after opt-in, retains original BOM/CRLF/revision, and reports existing-backup refusal')

  await page.evaluate(() => { window.inspectMode = 'missing' }); await choose().click()
  await dialog().getByRole('alert').filter({ hasText: '正文与归档资源不一致' }).waitFor()
  await page.waitForFunction(() => window.calls.some(call => call.command === 'release_document_backup' && call.args.token === 'ticket-1'))
  assert.equal(await restore().count(), 0); assert.equal((await calls('restore_document_backup')).length, 0)
  await page.evaluate(() => { window.inspectMode = 'corrupt' }); await choose().click()
  await dialog().getByRole('alert').filter({ hasText: '哈希校验失败' }).waitFor()
  assert.equal(await restore().count(), 0)
  report.checks.push('actual resource Worker rejects absent image inventory, releases rejected tokens, and native corrupt-package errors block restore')

  await page.evaluate(() => { window.inspectMode = 'valid' }); await choose().click(); await confirm().waitFor()
  assert.equal(await restore().isDisabled(), true); assert.equal(await confirm().isChecked(), false)
  await page.screenshot({ path: 'test-results/backup/review.png' })
  await confirm().check(); await restore().click(); await status('尚未恢复')
  const firstRestore = (await calls('restore_document_backup')).at(-1).args
  assert.equal(firstRestore.token, 'ticket-2'); assert.deepEqual(firstRestore.references, [['assets/a.png'], ['assets/old.png']])
  await page.evaluate(() => { window.restoreMode = 'changed' }); await restore().click()
  await dialog().getByRole('alert').filter({ hasText: '审查后发生变化' }).waitFor()
  await page.evaluate(() => { window.restoreMode = 'expired' }); await restore().click()
  await dialog().getByRole('alert').filter({ hasText: '审查已过期' }).waitFor()
  report.checks.push('explicit restore review uses Worker-scanned AST references, excludes inline fake images, and handles canceled, changed, and expired packages')

  await choose().click(); await confirm().waitFor(); assert.equal(await confirm().isChecked(), false)
  await page.waitForFunction(() => window.calls.some(call => call.command === 'release_document_backup' && call.args.token === 'ticket-2'))
  await page.setViewportSize({ width: 430, height: 650 })
  assert.equal(await dialog().evaluate(node => node.scrollWidth > node.clientWidth), false)
  await confirm().scrollIntoViewIfNeeded(); await page.screenshot({ path: 'test-results/backup/compact.png' })
  await confirm().check(); await page.evaluate(() => { window.restoreMode = 'hold' }); await restore().click()
  await page.waitForFunction(() => typeof window.finishRestore === 'function')
  assert.equal(await restore().isDisabled(), true); assert.equal(await confirm().isDisabled(), true)
  await page.keyboard.press('Escape'); assert.equal(await dialog().count(), 1)
  await page.evaluate(() => window.finishRestore()); await status('已恢复到')
  assert.equal(await confirm().count(), 0); assert.equal(await body(), '# 磁盘正文\n')
  assert.equal(await page.evaluate(() => window.disk.text), '\uFEFF# 磁盘正文\r\n')
  assert.equal((await calls('save_document')).length, 0)
  report.checks.push('reselection invalidates confirmation and releases old token; long names fit compact layout; busy restore is locked and leaves editor/disk unchanged')

  await page.setViewportSize({ width: 1200, height: 900 }); await choose().click(); await confirm().waitFor()
  await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'detached' })
  await page.waitForFunction(() => window.calls.some(call => call.command === 'release_document_backup' && call.args.token === 'ticket-4'))
  await page.keyboard.press('F1')
  const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
  await palette.getByRole('combobox').fill('文档备份与恢复'); await page.keyboard.press('Enter'); await dialog().waitFor()
  assert.equal(await history().isChecked(), false); await page.keyboard.press('Escape')
  report.checks.push('closing releases the active token and F1 exposes the same backup action with fresh default state')
  assert.deepEqual(errors, []); report.passed = true
} catch (error) {
  report.error = error.stack; process.exitCode = 1
  await page?.screenshot({ path: 'test-results/backup/failure.png' }).catch(() => {})
} finally {
  report.finishedAt = new Date().toISOString()
  await writeFile('test-results/backup-verification.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2)); await browser?.close(); await server.close()
}
