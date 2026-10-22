// v2.0 step 2B: production UI for workspace rename (with link preview) and in-app trash,
// using deterministic native IPC. Native rename/trash/rollback semantics are covered by
// Rust tests in src-tauri/src/workspace_ops.rs.
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
    const enc = (s) => [...new TextEncoder().encode(s)]
    window.files = { 'notes/a.md': '# A\r\n[自身](a.md#x)\r\n', 'notes/index.md': '﻿[去 A](a.md)\r\n', 'other.md': '无关' }
    window.trash = []; window.calls = []; window.moves = []; window.sessions = {}
    let callback = 0
    window.isTauri = true; window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
    const entries = (dir) => Object.keys(window.files).filter((p) => (p.includes('/') ? p.split('/').slice(0, -1).join('/') : '') === dir).map((p) => ({ name: p.split('/').at(-1), path: p, kind: 'document' }))
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' } }, transformCallback: () => ++callback, invoke: async (command, args) => {
      if (command === 'recent_state') return { entries: [], session: { tabs: [], activeDraftKey: null, workspaceId: null } }
      if (command === 'remember_session' || command === 'close_document') return
      if (command.startsWith('plugin:window|is_')) return false
      if (command.startsWith('plugin:')) return 1
      window.calls.push({ command, args })
      if (command === 'open_workspace') return { id: 'ws', name: '工作区', entries: [{ name: 'notes', path: 'notes', kind: 'directory' }, ...entries('')] }
      if (command === 'list_workspace') return args.relativePath ? entries(args.relativePath) : [{ name: 'notes', path: 'notes', kind: 'directory' }, ...entries('')]
      if (command === 'workspace_rename_prepare') {
        if (window.files[args.to]) throw 'target_exists'
        return { from: args.from, to: args.to, candidates: Object.entries(window.files).sort().map(([path, text]) => ({ path, bytes: enc(text), revision: 'r:' + path })) }
      }
      if (command === 'workspace_rename') {
        for (const rewrite of args.rewrites) window.files[rewrite.path] = new TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array(rewrite.bytes))
        window.files[args.to] = window.files[args.from]; delete window.files[args.from]
        window.moves.push({ from: args.from, to: args.to, images: args.resources?.references ?? [] })
        const sessions = Object.entries(window.sessions).filter(([, p]) => p === args.from).map(([id]) => id)
        for (const id of sessions) window.sessions[id] = args.to
        return { path: args.to, warnings: [], sessions }
      }
      if (command === 'workspace_directories') return ['', 'archive', 'notes']
      if (command === 'open_workspace_document') {
        const id = 'session-' + args.relativePath; window.sessions[id] = args.relativePath
        return { id, name: args.relativePath.split('/').at(-1), bytes: enc(window.files[args.relativePath]), revision: 'r:' + args.relativePath, metadata: null, warning: null, recentId: null }
      }
      if (command === 'reload_document') {
        const path = window.sessions[args.id]
        return { id: args.id, name: path.split('/').at(-1), bytes: enc(window.files[path]), revision: 'r2:' + path, metadata: null, warning: null, recentId: null }
      }
      if (command === 'inspect_document') { const path = window.sessions[args.id]; return { revision: args.expectedRevision ?? 'r:' + path } }
      if (command === 'history_operation') return { enabled: false, documentId: null, readOnly: false, usedBytes: 0, budgetBytes: 1, paused: false, snapshots: [], orphans: [] }
      if (command === 'workspace_trash') {
        window.trash.push({ operationId: args.operationId, path: args.path, deletedAt: Date.now(), documentId: null, text: window.files[args.path] })
        delete window.files[args.path]
        return { operationId: args.operationId, path: args.path, documentId: null, warning: null }
      }
      if (command === 'workspace_trash_list') return window.trash.map(({ text, ...entry }) => entry)
      if (command === 'workspace_trash_restore') {
        const index = window.trash.findIndex((e) => e.operationId === args.operationId)
        const [entry] = window.trash.splice(index, 1)
        window.files[entry.path] = entry.text
        return { path: entry.path, warning: null }
      }
      throw new Error(`Unexpected command: ${command}`)
    } }
  })
  await acknowledgeGuide(page)
  await page.goto(server.url)
  await page.getByRole('button', { name: 'EM 菜单' }).click()
  await page.getByRole('menuitem', { name: '打开工作区', exact: true }).click()
  const tree = page.getByRole('navigation', { name: '工作区文件' })
  await tree.getByRole('button', { name: 'notes' }).click()

  await tree.getByRole('button', { name: 'a.md', exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '重命名…' }).click()
  const dialog = page.getByRole('dialog', { name: '重命名文档' })
  await dialog.getByRole('textbox').fill('con')
  await dialog.getByRole('button', { name: '预览', exact: true }).click()
  await dialog.getByRole('alert').filter({ hasText: '文件名无效' }).waitFor()
  assert.equal(await page.evaluate(() => window.calls.filter((c) => c.command.startsWith('workspace_rename')).length), 0)
  report.checks.push('unportable names are refused locally before any native call')

  await dialog.getByRole('textbox').fill('甲')
  await dialog.getByRole('button', { name: '预览', exact: true }).click()
  const status = dialog.getByRole('status')
  await status.filter({ hasText: 'notes/甲.md' }).waitFor()
  assert.match(await status.textContent(), /notes\/index\.md\s*1 处链接/)
  assert.match(await status.textContent(), /文档自身有 1 处链接/)
  assert.equal(await page.evaluate(() => window.calls.filter((c) => c.command === 'workspace_rename').length), 0)
  report.checks.push('preview lists incoming and self links without changing anything')

  await dialog.getByRole('button', { name: '确认重命名', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  assert.equal(await page.evaluate(() => window.files['notes/index.md']), '﻿[去 A](%E7%94%B2.md)\r\n')
  assert.equal(await page.evaluate(() => window.files['notes/甲.md']), '# A\r\n[自身](%E7%94%B2.md#x)\r\n')
  // The refreshed tree starts collapsed; expanding it must show the new name only.
  await tree.getByRole('button', { name: 'notes' }).click()
  await tree.getByRole('button', { name: '甲.md' }).waitFor()
  assert.equal(await tree.getByRole('button', { name: 'a.md', exact: true }).count(), 0)
  report.checks.push('confirmed rename rewrites links byte-exactly and refreshes the tree')

  await tree.getByRole('button', { name: 'other.md' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '重命名…' }).click()
  const second = page.getByRole('dialog', { name: '重命名文档' })
  await second.getByRole('textbox').fill('甲')
  await page.evaluate(() => { window.files['甲.md'] = '占用' })
  await second.getByRole('button', { name: '预览', exact: true }).click()
  await second.getByRole('alert').filter({ hasText: '同名文档已存在' }).waitFor()
  await second.getByRole('button', { name: '取消', exact: true }).click()
  report.checks.push('existing target is refused before any change')

  page.once('dialog', (d) => d.accept())
  await tree.getByRole('button', { name: 'other.md' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '移到回收站' }).click()
  await page.waitForFunction(() => !window.files['other.md'])
  assert.equal(await page.evaluate(() => window.trash.length), 1)
  report.checks.push('trash requires confirmation and removes the entry from the tree')

  await page.getByRole('button', { name: '工作区回收站' }).click()
  const bin = page.getByRole('dialog', { name: '工作区回收站' })
  await bin.getByRole('button', { name: '恢复 other.md' }).click()
  await bin.getByRole('status').filter({ hasText: '已恢复 other.md' }).waitFor()
  await bin.getByText('回收站为空。').waitFor()
  assert.equal(await page.evaluate(() => window.files['other.md']), '无关')
  await bin.getByRole('button', { name: '完成', exact: true }).click()
  report.checks.push('trash lists and restores the document')

  // Cross-directory move of an open, saved document: images travel, links update both ways,
  // and the tab reloads from the moved session instead of being refused.
  await page.evaluate(() => { window.files['notes/甲.md'] = '# A\r\n![图](assets/img-x-v1.png) [索引](index.md)\r\n' })
  const notes = tree.getByRole('button', { name: 'notes' })
  if (await notes.getAttribute('aria-expanded') !== 'true') await notes.click()
  await tree.locator('button[title="notes/甲.md"]').click()
  await page.getByRole('tab', { name: '甲.md' }).waitFor()
  // Opening a document may re-mount the tree collapsed; expand again before the context menu.
  if (await notes.getAttribute('aria-expanded') !== 'true') await notes.click()
  await tree.locator('button[title="notes/甲.md"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: '移动到…' }).click()
  const move = page.getByRole('dialog', { name: '移动文档' })
  await move.getByRole('combobox').selectOption('archive')
  await move.getByRole('button', { name: '预览', exact: true }).click()
  const plan = move.getByRole('status')
  await plan.filter({ hasText: 'archive/甲.md' }).waitFor()
  assert.match(await plan.textContent(), /notes\/index\.md\s*1 处链接/)
  assert.match(await plan.textContent(), /1 张图片会复制到目标目录/)
  report.checks.push('move preview lists the target, incoming links and copied images')

  await move.getByRole('button', { name: '确认移动', exact: true }).click()
  await move.waitFor({ state: 'detached' })
  const done = await page.evaluate(() => ({ moves: window.moves.at(-1), index: window.files['notes/index.md'], body: window.files['archive/甲.md'] }))
  assert.deepEqual(done.moves, { from: 'notes/甲.md', to: 'archive/甲.md', images: ['assets/img-x-v1.png'] })
  assert.equal(done.index, '﻿[去 A](../archive/%E7%94%B2.md)\r\n')
  assert.equal(done.body, '# A\r\n![图](assets/img-x-v1.png) [索引](../notes/index.md)\r\n')
  await page.locator('.document-panel:not([hidden]) .cm-content').filter({ hasText: '../notes/index.md' }).waitFor()
  assert.ok(await page.evaluate(() => window.calls.some((c) => c.command === 'reload_document')))
  report.checks.push('confirmed move copies images, rewrites links both ways and reloads the open tab')

  assert.deepEqual(errors, [])
  report.passed = true
} catch (error) { report.error = error.message; process.exitCode = 1 }
finally {
  await browser?.close(); await server.close()
  await writeFile('test-results/v2.0/step-2/workspace-ops-ui.json', JSON.stringify(report, null, 2) + '\n')
}
if (report.passed) console.log(`Workspace operations UI: ${report.checks.length} production checks passed`)
else console.error('Workspace operations UI failed:', report.error)
