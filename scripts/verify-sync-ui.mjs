// v2.0 step 3C: production UI for sync pairing, status, pause/resume and exit, with deterministic
// native IPC. Real-server behaviour is covered by scripts/verify-sync-e2e.mjs and Rust tests.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { serveProduction, acknowledgeGuide } from './serve-production.mjs'

const sha = (text) => 'sha256:' + createHash('sha256').update(text).digest('hex')
const LOCAL = 'c888f21e-6818-42dd-b9ec-66f89f811312', REMOTE = '1358f0a2-25b8-441b-9d55-379f6ca303dc'
const A_LOCAL = 'a1b2c3d4-0000-4000-8000-000000000001', A_REMOTE = 'a1b2c3d4-0000-4000-8000-000000000002'
const DEVICE = '6f0c1c55-3c9e-4f53-9c9b-0b8f4d9f6a01', PASSWORD = 'pw-never-stored-' + Date.now()
const identity = JSON.stringify({ schemaVersion: 1, workspaceId: LOCAL, documents: [{ documentId: A_LOCAL, path: 'a.md' }] })
const commit = JSON.stringify({ schemaVersion: 1, workspaceId: REMOTE, operationId: 'b0b0b0b0-0000-4000-8000-000000000001', deviceId: DEVICE, parents: [],
  documents: [{ documentId: A_REMOTE, path: 'a.md', text: { object: sha('remote a'), bytes: 8 }, imageMetadata: null, resources: [] }], tombstones: [] })
const head = JSON.stringify({ schemaVersion: 1, workspaceId: REMOTE, deviceId: DEVICE, sequence: 1, commitHash: sha(commit) })
const fixture = { identity, commit, head, REMOTE, DEVICE, PASSWORD }

const server = await serveProduction()
const report = { verifiedAt: new Date().toISOString(), passed: false, checks: [], scope: 'Production UI with deterministic IPC; real servers are covered by verify-sync-e2e.' }
let browser
await mkdir('test-results/v2.0/step-3', { recursive: true })
/** In-page native mock: a remote object/head store and a local workspace, with the native rules. */
function installMock(fx) {
  const enc = (s) => [...new TextEncoder().encode(s)], dec = (b) => new TextDecoder().decode(new Uint8Array(b))
  const hash = async (bytes) => 'sha256:' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))].map((b) => b.toString(16).padStart(2, '0')).join('')
  const remote = { heads: new Map([[fx.DEVICE, { bytes: enc(fx.head), revision: '"h1"' }]]), objects: new Map() }
  window.local = { files: new Map([['a.md', 'local a']]), identity: enc(fx.identity), state: null }
  window.calls = []; window.bound = null
  const ready = (async () => { for (const text of [fx.commit, 'remote a']) remote.objects.set(await hash(enc(text)), enc(text)) })()
  let callback = 0, revisions = 1
  window.isTauri = true; window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
  window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' } }, transformCallback: () => ++callback, invoke: async (command, args) => {
    await ready
    if (command === 'recent_state') return { entries: [], session: { tabs: [], activeDraftKey: null, workspaceId: null } }
    if (command === 'remember_session' || command === 'close_document') return
    if (command.startsWith('plugin:window|is_')) return false
    if (command.startsWith('plugin:')) return 1
    window.calls.push({ command, args: JSON.stringify(args ?? {}) })
    if (command === 'open_workspace') return { id: 'ws', name: '同步工作区', entries: [{ name: 'a.md', path: 'a.md', kind: 'document' }] }
    if (command === 'list_workspace') return [...window.local.files.keys()].map((p) => ({ name: p, path: p, kind: 'document' }))
    if (command === 'sync_binding') return window.bound
    const docs = () => [...window.local.files.keys()].sort()
    if (command === 'sync_identity_scan') return { identity: window.local.identity, identityError: null, documents: docs().map((path) => ({ path, historyId: null })), unreadable: [] }
    if (command === 'sync_identity_write') {
      if ((await hash(window.local.identity)) !== args.expected) throw 'revision_conflict'
      window.local.identity = args.bytes; return hash(args.bytes)
    }
    if (command === 'sync_probe') { if (args.password !== fx.PASSWORD) throw 'unauthorized'; return [fx.REMOTE] }
    if (command === 'sync_probe_workspace') {
      if (args.password !== fx.PASSWORD) throw 'unauthorized'
      return [...remote.heads].map(([deviceId, h]) => ({ deviceId, head: h.bytes, commit: remote.objects.get(JSON.parse(dec(h.bytes)).commitHash) ?? null }))
    }
    if (command === 'sync_bind') {
      if (args.password !== fx.PASSWORD) throw 'unauthorized'
      const workspaceId = JSON.parse(dec(window.local.identity)).workspaceId
      window.bound = { bindingId: 'b0000000-0000-4000-8000-000000000001', workspaceId, deviceId: 'd0000000-0000-4000-8000-000000000009', endpoint: args.endpoint, username: args.username, createdAt: 1 }
      return window.bound
    }
    if (command === 'sync_unbind') { window.bound = null; window.local.state = null; return }
    if (command === 'sync_state_read') return window.local.state
    if (command === 'sync_state_write') { window.local.state = args.bytes; return }
    if (command === 'sync_heads') return [...remote.heads].map(([deviceId, h]) => ({ deviceId, bytes: h.bytes, revision: h.revision }))
    if (command === 'sync_head') { const h = remote.heads.get(args.device); return h ? { deviceId: args.device, bytes: h.bytes, revision: h.revision } : null }
    if (command === 'sync_publish') {
      const device = JSON.parse(dec(args.bytes)).deviceId, current = remote.heads.get(device)
      if (args.expected === null ? current : args.expected && current?.revision !== args.expected) return { kind: 'conflict', revision: null }
      const revision = `"h${++revisions}"`; remote.heads.set(device, { bytes: args.bytes, revision }); return { kind: 'committed', revision }
    }
    if (command === 'sync_object') return remote.objects.get(args.hash) ?? null
    if (command === 'sync_put_object') { const had = remote.objects.has(args.hash); remote.objects.set(args.hash, args.bytes); return had ? 'exists' : 'created' }
    if (command === 'sync_local_revisions') return { identity: window.local.identity, documents: await Promise.all(docs().map(async (path) => ({ path, revision: await hash(enc(window.local.files.get(path))), bytes: 1, historyId: null }))) }
    if (command === 'sync_local_read') { const text = window.local.files.get(args.path); return { bytes: enc(text), revision: await hash(enc(text)), instances: [] } }
    if (command === 'sync_local_asset') return null
    if (command === 'sync_local_open' || command === 'workspace_trash_list') return []
    if (command === 'sync_local_write') {
      const r = args.request, current = window.local.files.get(r.path)
      if (r.expected === null ? current !== undefined : (await hash(enc(current ?? ''))) !== r.expected) throw 'revision_conflict'
      window.local.files.set(r.path, dec(r.bytes)); return null
    }
    throw new Error(`Unexpected command: ${command}`)
  } }
}

try {
  browser = await chromium.launch({ channel: process.env.EASYM_TEST_BROWSER || undefined }); report.browser = browser.version()
  const page = await browser.newPage({ viewport: { width: 1200, height: 860 } })
  const errors = []; page.on('pageerror', (e) => errors.push(e.message))
  await page.addInitScript(installMock, fixture)
  await acknowledgeGuide(page)
  await page.goto(server.url)
  const em = page.getByRole('button', { name: 'EM 菜单', exact: true })
  await em.click()
  assert.ok(await page.getByRole('menuitem', { name: '同步…', exact: true }).isDisabled(), 'sync requires a workspace')
  await page.getByRole('menuitem', { name: '打开工作区', exact: true }).click()
  await page.getByRole('navigation', { name: '工作区文件' }).waitFor()
  await em.click(); await page.getByRole('menuitem', { name: '同步…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '同步', exact: true })
  await dialog.getByLabel('WebDAV 地址').fill('https://dav.example.test/files/u/')
  await dialog.getByLabel('用户名').fill('u')
  await dialog.getByLabel('密码或应用密码').fill('wrong')
  await dialog.getByRole('button', { name: '检查连接', exact: true }).click()
  await dialog.getByRole('alert').filter({ hasText: '用户名或密码不正确' }).waitFor()
  report.checks.push('wrong credentials are reported and nothing is bound')

  await dialog.getByLabel('密码或应用密码').fill(fixture.PASSWORD)
  await dialog.getByRole('button', { name: '检查连接', exact: true }).click()
  await dialog.getByRole('radio', { name: /加入服务器上已有的工作区 1358f0a2/ }).click()
  const preview = dialog.getByRole('status').filter({ hasText: '将下载 1 个文档、上传 1 个' })
  await preview.waitFor()
  await dialog.getByText('两边都有同名文档：a.md').waitFor()
  const untouched = await page.evaluate(() => ({ bound: window.bound, identity: new TextDecoder().decode(new Uint8Array(window.local.identity)), binds: window.calls.filter((c) => c.command === 'sync_bind').length }))
  assert.deepEqual(untouched, { bound: null, identity: fixture.identity, binds: 0 })
  report.checks.push('join preview counts downloads, uploads and same-named documents without writing')

  await dialog.getByRole('button', { name: '连接并同步', exact: true }).click()
  await page.waitForFunction(() => [...window.local.files.values()].includes('remote a'))
  const after = await page.evaluate(() => ({ files: Object.fromEntries(window.local.files), workspaceId: JSON.parse(new TextDecoder().decode(new Uint8Array(window.local.identity))).workspaceId }))
  assert.equal(after.workspaceId, fixture.REMOTE)
  assert.equal(after.files['a.md'], 'local a')
  assert.equal(Object.keys(after.files).length, 2)
  report.checks.push('connecting joins the remote workspace; the local file stays and the remote one arrives beside it')

  const chip = page.locator('.sync-chip')
  await chip.filter({ hasText: '已同步' }).waitFor()
  await dialog.getByText(/已上传本机修改，下载 1 个文档/).waitFor()
  report.checks.push('status chip and last-pass report reflect the completed sync')

  const secrets = await page.evaluate((password) => ({
    storage: JSON.stringify(localStorage).includes(password),
    state: window.local.state ? new TextDecoder().decode(new Uint8Array(window.local.state)).includes(password) : false,
    calls: [...new Set(window.calls.filter((c) => c.args.includes(password)).map((c) => c.command))].sort(),
  }), fixture.PASSWORD)
  assert.deepEqual(secrets, { storage: false, state: false, calls: ['sync_bind', 'sync_probe', 'sync_probe_workspace'] })
  report.checks.push('the password only crosses IPC for probe and bind; never stored by the webview')

  await dialog.getByRole('button', { name: '暂停', exact: true }).click()
  await chip.filter({ hasText: '同步暂停' }).waitFor()
  assert.equal(await page.evaluate(() => localStorage.getItem('easym-sync-paused:b0000000-0000-4000-8000-000000000001')), 'true')
  await dialog.getByRole('button', { name: '继续同步', exact: true }).click()
  await chip.filter({ hasText: '已同步' }).waitFor()
  report.checks.push('pause is persisted per binding and resume syncs again')

  page.once('dialog', (d) => d.accept())
  await dialog.getByRole('button', { name: '退出同步', exact: true }).click()
  await dialog.getByRole('status').filter({ hasText: '已退出同步' }).waitFor()
  await chip.waitFor({ state: 'detached' })
  assert.equal(await page.evaluate(() => window.bound), null)
  assert.equal(await page.evaluate(() => window.local.files.size), 2)
  report.checks.push('exit sync removes the binding after confirmation and keeps workspace files')

  await dialog.getByRole('button', { name: '完成', exact: true }).click()
  assert.deepEqual(errors, [])
  report.passed = true
} catch (error) { report.error = error.message; process.exitCode = 1 }
finally {
  await browser?.close(); await server.close()
  await writeFile('test-results/v2.0/step-3/sync-ui.json', JSON.stringify(report, null, 2) + '\n')
}
if (report.passed) console.log(`Sync UI: ${report.checks.length} production checks passed`)
else console.error('Sync UI failed:', report.error)
