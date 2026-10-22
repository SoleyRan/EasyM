// v2.0 step 2A: production UI for workspace sync identity, with deterministic native IPC.
// The native scan/write/remove semantics are covered by Rust tests (src-tauri/src/sync_identity.rs).
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { serveProduction, acknowledgeGuide } from './serve-production.mjs'

const server = await serveProduction()
const report = { verifiedAt: new Date().toISOString(), passed: false, checks: [], scope: 'Production UI with deterministic IPC; native filesystem semantics are covered by Rust tests.' }
let browser
await mkdir('test-results/v2.0/step-2', { recursive: true })
try {
  browser = await chromium.launch({ channel: process.env.EASYM_TEST_BROWSER || undefined }); report.browser = browser.version()
  const page = await browser.newPage({ viewport: { width: 1200, height: 860 } })
  const errors = []; page.on('pageerror', (e) => errors.push(e.message))
  await page.addInitScript(() => {
    const A = 'a1b2c3d4-0000-4000-8000-000000000001'
    window.disk = { identity: null, documents: [{ path: 'a.md', historyId: A }, { path: '笔记/b.md', historyId: null }], unreadable: [] }
    window.writes = []; window.removes = []
    const hash = async (bytes) => 'sha256:' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))].map((b) => b.toString(16).padStart(2, '0')).join('')
    let callback = 0
    window.isTauri = true; window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' } }, transformCallback: () => ++callback, invoke: async (command, args) => {
      if (command === 'recent_state') return { entries: [], session: { tabs: [], activeDraftKey: null, workspaceId: null } }
      if (command === 'remember_session' || command === 'close_document') return
      if (command.startsWith('plugin:window|is_')) return false
      if (command.startsWith('plugin:')) return 1
      if (command === 'open_workspace') return { id: 'ws', name: '同步工作区', entries: [{ name: 'a.md', path: 'a.md', kind: 'document' }] }
      if (command === 'sync_identity_scan') return { identity: window.disk.identity, identityError: null, documents: window.disk.documents, unreadable: window.disk.unreadable }
      if (command === 'sync_identity_write') {
        const current = window.disk.identity ? await hash(window.disk.identity) : null
        if (current !== args.expected) throw 'revision_conflict'
        window.writes.push(JSON.parse(new TextDecoder().decode(new Uint8Array(args.bytes)))); window.disk.identity = args.bytes
        return hash(args.bytes)
      }
      if (command === 'sync_identity_remove') {
        if (!window.disk.identity || (await hash(window.disk.identity)) !== args.expected) throw 'revision_conflict'
        window.removes.push(args.expected); window.disk.identity = null; return
      }
      throw new Error(`Unexpected command: ${command}`)
    } }
  })
  await acknowledgeGuide(page)
  await page.goto(server.url)
  const em = page.getByRole('button', { name: 'EM 菜单', exact: true })
  await em.click()
  assert.ok(await page.getByRole('menuitem', { name: '同步身份', exact: true }).isDisabled(), 'identity requires a workspace')
  await page.getByRole('menuitem', { name: '打开工作区', exact: true }).click()
  await page.getByRole('navigation', { name: '工作区文件' }).waitFor()
  report.checks.push('identity menu disabled without a workspace')

  await em.click(); await page.getByRole('menuitem', { name: '同步身份', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '同步身份' })
  await dialog.getByText('将记录的文档（2）').waitFor()
  assert.match(await dialog.textContent(), /沿用版本历史身份/)
  assert.equal(await page.evaluate(() => window.writes.length), 0)
  report.checks.push('preview lists documents, marks reused history id and writes nothing')

  await dialog.getByRole('button', { name: '启用', exact: true }).click()
  await dialog.getByRole('status').filter({ hasText: '已启用同步身份：2 个文档' }).waitFor()
  const first = await page.evaluate(() => window.writes[0])
  assert.equal(first.documents.find((d) => d.path === 'a.md').documentId, 'a1b2c3d4-0000-4000-8000-000000000001')
  assert.equal(first.documents.length, 2)
  await dialog.getByText('身份记录与磁盘一致，无需更改。').waitFor()
  report.checks.push('enable writes once with absent precondition and rescans clean')

  // External rename: tracked a.md disappears, renamed.md appears. Must pause, then bind explicitly.
  await page.evaluate(() => { window.disk.documents = [{ path: 'renamed.md', historyId: null }, { path: '笔记/b.md', historyId: null }] })
  await dialog.getByRole('button', { name: '重新扫描', exact: true }).click()
  await dialog.getByText('需要确认（1）').waitFor()
  await dialog.getByText('已记录但找不到（1）').waitFor()
  assert.ok(await dialog.getByRole('button', { name: '应用更改', exact: true }).isDisabled(), 'nothing changes without a decision')
  await dialog.getByRole('combobox').selectOption({ label: '是 a.md 移动后的版本' })
  await dialog.getByRole('button', { name: '应用更改', exact: true }).click()
  await dialog.getByRole('status').filter({ hasText: '已更新同步身份' }).waitFor()
  const second = await page.evaluate(() => window.writes[1])
  assert.deepEqual(second.documents.find((d) => d.path === 'renamed.md'), { documentId: first.documents.find((d) => d.path === 'a.md').documentId, path: 'renamed.md' })
  report.checks.push('external rename pauses and binds only after explicit choice, keeping identity')

  // Concurrent change between preview and apply is a conflict, not an overwrite.
  await page.evaluate(() => { window.disk.documents.push({ path: 'c.md', historyId: null }) })
  await dialog.getByRole('button', { name: '重新扫描', exact: true }).click()
  await dialog.getByText('新增文档（1）').waitFor()
  await page.evaluate(() => { window.disk.identity = [...new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, workspaceId: '1358f0a2-25b8-441b-9d55-379f6ca303dc', documents: [] }))] })
  await dialog.getByRole('button', { name: '应用更改', exact: true }).click()
  await dialog.getByRole('alert').filter({ hasText: '请重新预览' }).waitFor()
  assert.equal(await page.evaluate(() => window.writes.length), 2)
  report.checks.push('stale preview is rejected as a conflict')

  // Incomplete scans never produce a plan.
  await page.evaluate(() => { window.disk.unreadable = ['locked'] })
  await dialog.getByRole('button', { name: '重新扫描', exact: true }).click()
  await dialog.getByRole('alert').filter({ hasText: '扫描不完整' }).waitFor()
  await page.evaluate(() => { window.disk.unreadable = [] })
  await dialog.getByRole('button', { name: '重新扫描', exact: true }).click()
  await dialog.getByRole('button', { name: '停用', exact: true }).waitFor()
  report.checks.push('incomplete scan stops before planning')

  page.once('dialog', (d) => d.accept())
  await dialog.getByRole('button', { name: '停用', exact: true }).click()
  await dialog.getByRole('status').filter({ hasText: '已停用同步身份' }).waitFor()
  assert.equal(await page.evaluate(() => window.removes.length), 1)
  await dialog.getByRole('button', { name: '启用', exact: true }).waitFor()
  report.checks.push('disable removes only the identity file after confirmation')

  await dialog.getByRole('button', { name: '完成', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  assert.deepEqual(errors, [])
  report.passed = true
} catch (error) { report.error = error.message; process.exitCode = 1 }
finally {
  await browser?.close(); await server.close()
  await writeFile('test-results/v2.0/step-2/sync-identity-ui.json', JSON.stringify(report, null, 2) + '\n')
}
if (report.passed) console.log(`Sync identity UI: ${report.checks.length} production checks passed`)
else console.error('Sync identity UI failed:', report.error)
