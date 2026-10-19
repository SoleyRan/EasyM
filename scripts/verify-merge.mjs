import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { serveProduction, acknowledgeGuide } from './serve-production.mjs'
import { fillSource } from './source-test-utils.mjs'

const server = await serveProduction()
const report = { passed: false, checks: [], scope: 'Actual production UI and workers with deterministic native IPC. Native filesystem/archives are covered by Rust tests; no real IME/native-dialog claim.' }
let browser, page
await mkdir('test-results/merge', { recursive: true })
try {
  browser = await chromium.launch({ channel: process.env.EASYM_TEST_BROWSER || undefined }); report.browser = browser.version()
  page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  await acknowledgeGuide(page)
  await page.addInitScript(() => {
    const encode = text => [...new TextEncoder().encode(text)]
    window.disk = { text: '# 基线\n\n中段 😀\n\n结尾\n', revision: 'r1' }; window.calls = []; window.archives = []; window.failPrepare = false; window.raceCommit = false
    const file = () => ({ id: 'merge', name: 'merge.md', bytes: encode(window.disk.text), revision: window.disk.revision })
    let callback = 0
    window.isTauri = true; window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' } }, transformCallback: () => ++callback, invoke: async (command, args) => {
      window.calls.push({ command, args })
      if (command.startsWith('plugin:window|is_')) return false
      if (command.startsWith('plugin:')) return 1
      if (command === 'recent_state') return { entries: [], session: { tabs: [], activeDraftKey: null, workspaceId: null } }
      if (command === 'remember_session' || command === 'close_document') return
      if (command === 'open_document' || command === 'reload_document') return file()
      if (command === 'inspect_document') return { revision: window.disk.revision, bytes: args.expectedRevision === window.disk.revision ? null : encode(window.disk.text) }
      if (command === 'save_document') {
        if (args.expectedRevision !== window.disk.revision) throw 'revision_conflict'
        window.disk = { text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array(args.bytes)), revision: 'saved-' + crypto.randomUUID() }
        return file()
      }
      if (command === 'prepare_merge') {
        if (window.failPrepare) throw 'io_failed'
        if (args.input.diskRevision !== window.disk.revision) throw 'revision_conflict'
        const archive = { ...args.input, operationId: crypto.randomUUID(), recoveryPath: 'fixture/.easym/merges/record', createdAt: Date.now() }
        window.archives.push(archive)
        return { operationId: archive.operationId, recoveryPath: archive.recoveryPath }
      }
      if (command === 'commit_merge') {
        const archive = window.archives.find(a => a.operationId === args.operationId)
        if (window.raceCommit) { window.disk = { text: '# 提交前再次变化\n', revision: 'raced-' + crypto.randomUUID() }; throw 'revision_conflict' }
        if (archive.diskRevision !== window.disk.revision) throw 'revision_conflict'
        window.disk = { text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array(archive.result)), revision: 'merged-' + archive.operationId }
        return { revision: window.disk.revision, recoveryPath: archive.recoveryPath }
      }
      if (command === 'merge_recovery') {
        if (args.operationId) return { path: 'fixture/recovered-new-directory/merge.md' }
        return { records: window.archives.map(a => ({ operationId: a.operationId, createdAt: a.createdAt, recoveryPath: a.recoveryPath, resultRevision: 'result' })), warnings: [] }
      }
      throw new Error('Unexpected IPC ' + command)
    } }
  })
  await page.goto(server.url)
  const menu = async label => { await page.getByRole('button', { name: 'EM 菜单', exact: true }).click(); await page.getByRole('menuitem', { name: label, exact: true }).click() }
  const body = () => page.locator('.document-panel:not([hidden]) .cm-content').evaluate(node => [...node.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'))
  const banner = () => page.getByRole('status', { name: '外部文件变化', exact: true })
  const dialog = () => page.getByRole('dialog', { name: '外部版本对比', exact: true })
  const candidate = () => dialog().getByRole('textbox', { name: '合并候选（只读）', exact: true })
  const apply = () => dialog().getByRole('button', { name: '应用合并并保存', exact: true })
  const confirm = () => dialog().getByRole('checkbox', { name: '已审查完整候选及保存格式，确认保存合并结果', exact: true })
  const changeDisk = async (text, revision) => { await page.evaluate(({ text, revision }) => { window.disk = { text, revision }; window.dispatchEvent(new Event('focus')) }, { text, revision }); await banner().waitFor() }
  const analyze = async () => { await banner().getByRole('button', { name: '比较外部版本', exact: true }).click(); await dialog().getByRole('button', { name: '分析三方合并', exact: true }).click() }
  await menu('打开文件'); await page.waitForFunction(() => window.calls.some(c => c.command === 'inspect_document'))
  const local = '# 本地标题\n\n中段 😀\n\n结尾\n', disk = '# 基线\n\n中段 😀\n\n磁盘结尾\n', merged = '# 本地标题\n\n中段 😀\n\n磁盘结尾\n'
  await fillSource(page, local); await changeDisk(disk, 'r2'); await analyze(); await candidate().waitFor()
  assert.equal(await candidate().inputValue(), merged); assert.equal(await apply().isDisabled(), true)
  await confirm().check(); await page.evaluate(() => { window.failPrepare = true }); await apply().click()
  await dialog().getByRole('alert').filter({ hasText: '归档或提交失败' }).waitFor()
  assert.equal(await body(), local); assert.equal(await page.evaluate(() => window.disk.text), disk)
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.command === 'commit_merge').length), 0)
  report.checks.push('independent changes require explicit review; failed mandatory archive blocks commit and preserves both versions')

  await page.evaluate(() => { window.failPrepare = false }); await apply().click(); await dialog().waitFor({ state: 'detached' }); await banner().waitFor({ state: 'detached' })
  assert.equal(await body(), merged); assert.equal(await page.evaluate(() => window.disk.text), merged)
  assert.equal(await page.evaluate(() => new TextDecoder().decode(new Uint8Array(window.archives[0].local))), local)
  assert.equal(await page.evaluate(() => new TextDecoder().decode(new Uint8Array(window.archives[0].disk))), disk)
  const source = page.locator('.document-panel:not([hidden]) .cm-content')
  await source.click(); await page.keyboard.press('ControlOrMeta+z'); assert.equal(await body(), local)
  await page.keyboard.press('ControlOrMeta+Shift+Z'); assert.equal(await body(), merged)
  report.checks.push('prepare then immutable commit persists candidate; one undo/redo restores complete local/merged body without changing the disk baseline')
  await menu('合并恢复记录')
  const recovery = () => page.getByRole('dialog', { name: '合并恢复记录', exact: true })
  await recovery().getByRole('button', { name: '恢复本地版本副本', exact: true }).first().click()
  await recovery().getByRole('status').filter({ hasText: '已恢复到新目录' }).waitFor()
  assert.equal(await body(), merged); assert.equal(await page.evaluate(() => window.disk.text), merged)
  await page.screenshot({ path: 'test-results/merge/recovery.png' }); await page.keyboard.press('Escape')
  report.checks.push('mandatory recovery is accessible from EM without opt-in history and restores to a new directory')

  const conflictLocal = '# 冲突本地\n\n中段 😀\n\n磁盘结尾\n'
  await fillSource(page, conflictLocal); await changeDisk('# 冲突磁盘\n\n中段 😀\n\n磁盘结尾\n', 'r3'); await analyze()
  await dialog().getByText('解决冲突 1', { exact: true }).waitFor()
  assert.equal(await candidate().count(), 0); await confirm().check(); assert.equal(await apply().isDisabled(), true)
  await dialog().getByRole('button', { name: '采用本地', exact: true }).click(); assert.equal(await confirm().isChecked(), false)
  await dialog().getByRole('button', { name: '手工编辑', exact: true }).click()
  await dialog().getByRole('textbox', { name: '冲突 1 手工结果', exact: true }).fill('# 手工合并 😀')
  assert.equal(await candidate().inputValue(), '# 手工合并 😀\n\n中段 😀\n\n磁盘结尾\n')
  await dialog().getByRole('combobox', { name: '合并保存格式', exact: true }).selectOption('disk')
  await confirm().check(); await page.screenshot({ path: 'test-results/merge/conflict-choice.png' })
  await page.evaluate(() => { window.raceCommit = true }); await apply().click()
  await dialog().getByRole('alert').filter({ hasText: '再次变化' }).waitFor()
  await page.waitForFunction(() => document.activeElement?.closest('[role=dialog][aria-label="外部版本对比"]') !== null)
  assert.equal(await body(), conflictLocal); assert.equal(await page.evaluate(() => window.disk.text), '# 提交前再次变化\n')
  assert.equal(await page.evaluate(() => window.archives.length), 2)
  await page.keyboard.press('Escape'); await banner().getByRole('button', { name: '重新检查', exact: true }).click()
  await page.waitForTimeout(250); await analyze(); await dialog().getByRole('button', { name: '采用磁盘', exact: true }).first().waitFor()
  for (const button of await dialog().getByRole('button', { name: '采用磁盘', exact: true }).all()) await button.click()
  await candidate().waitFor(); await confirm().check(); await page.evaluate(() => { window.raceCommit = false }); await apply().click()
  await dialog().waitFor({ state: 'detached' }); assert.equal(await body(), '# 提交前再次变化\n')
  report.checks.push('all conflicts require a choice, manual edits invalidate review, stale commit preserves local and archived versions, fresh analysis can resolve with disk')

  await fillSource(page, '# 格式本地\n'); await changeDisk('\uFEFF# 格式磁盘\r\n', 'r4'); await analyze()
  await dialog().getByRole('button', { name: '采用本地', exact: true }).click()
  await dialog().getByRole('combobox', { name: '合并保存格式', exact: true }).selectOption('disk'); await confirm().check(); await apply().click()
  await dialog().waitFor({ state: 'detached' }); assert.equal(await body(), '# 格式本地\n')
  assert.equal(await page.evaluate(() => window.disk.text), '\uFEFF# 格式本地\r\n')
  report.checks.push('explicit disk BOM/CRLF policy changes bytes while preserving normalized editor content')
  await fillSource(page, '# 图片本地\n'); await changeDisk('# 有图\n\n![a](assets/img-a.png)\n', 'r5'); await analyze()
  await dialog().getByRole('button', { name: '采用本地', exact: true }).first().waitFor()
  for (const button of await dialog().getByRole('button', { name: '采用本地', exact: true }).all()) await button.click()
  await candidate().waitFor(); await confirm().check(); const beforePrepare = await page.evaluate(() => window.calls.filter(c => c.command === 'prepare_merge').length)
  await apply().click(); await dialog().getByRole('alert').filter({ hasText: '无法验证双方本地图片' }).waitFor()
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.command === 'prepare_merge').length), beforePrepare)
  assert.equal(await body(), '# 图片本地\n'); assert.match(await page.evaluate(() => window.disk.text), /img-a\.png/)
  await page.setViewportSize({ width: 430, height: 650 }); assert.equal(await dialog().evaluate(node => node.scrollWidth > node.clientWidth), false)
  await page.screenshot({ path: 'test-results/merge/compact.png' })
  report.checks.push('unverifiable disk images block prepare even when choosing local text; compact layout stays in bounds')
  assert.deepEqual(errors, []); report.passed = true
} catch (error) { report.error = error.stack; process.exitCode = 1; await page?.screenshot({ path: 'test-results/merge/failure.png' }).catch(() => {}) }
finally { await writeFile('test-results/merge-verification.json', JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2)); await browser?.close(); await server.close() }
