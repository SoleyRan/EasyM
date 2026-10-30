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
await mkdir('test-results/v2.0/step-5', { recursive: true })
/** In-page native mock: a remote object/head store and a local workspace, with the native rules. */
function installMock(fx) {
  const enc = (s) => [...new TextEncoder().encode(s)], dec = (b) => new TextDecoder().decode(new Uint8Array(b))
  const hash = async (bytes) => 'sha256:' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))].map((b) => b.toString(16).padStart(2, '0')).join('')
  const remote = { heads: new Map([[fx.DEVICE, { bytes: enc(fx.head), revision: '"h1"' }]]), objects: new Map(), retired: new Map(), info: new Map() }
  window.local = { files: new Map([['a.md', 'local a']]), identity: enc(fx.identity), state: null, trash: [] }
  window.calls = []; window.bound = null
  // Exposed so the test can play the other device (publish a commit) and inspect what was synced.
  window.remote = remote; window.mockHash = hash; window.mockEnc = enc; window.mockDec = dec; window.DEVICE_ID = fx.DEVICE
  // This device's published commit. Defined here because the production CSP blocks eval in the page.
  window.ownCommit = () => {
    const head = window.bound && remote.heads.get(window.bound.deviceId)
    const hash = head && JSON.parse(dec(head.bytes)).commitHash, bytes = hash && remote.objects.get(hash)
    return bytes ? { hash, commit: JSON.parse(dec(bytes)) } : null
  }
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
    if (command === 'sync_rejoin') { window.bound = { ...window.bound, deviceId: crypto.randomUUID() }; return window.bound }
    if (command === 'sync_state_read') return window.local.state
    if (command === 'sync_state_write') { window.local.state = args.bytes; return }
    if (command === 'sync_heads') return [...remote.heads].map(([deviceId, h]) => ({ deviceId, bytes: h.bytes, revision: h.revision, modified: 'Tue, 28 Oct 2026 08:30:00 GMT' }))
    // Step 5A: retirement records and device info, with the native rules (create-only record,
    // conditional head delete, own-device info only).
    if (command === 'sync_retired') return [...remote.retired.keys()].sort()
    if (command === 'sync_retire') {
      if (args.device === window.bound.deviceId) throw 'permission_denied'
      if (!remote.retired.has(args.device)) remote.retired.set(args.device, args.bytes)
      const current = remote.heads.get(args.device)
      if (current && args.revision && current.revision !== args.revision) throw 'device_changed'
      remote.heads.delete(args.device); return
    }
    if (command === 'sync_device_info') return remote.info.get(args.device) ?? null
    if (command === 'sync_publish_info') {
      if (JSON.parse(dec(args.bytes)).deviceId !== window.bound.deviceId) throw 'permission_denied'
      remote.info.set(window.bound.deviceId, args.bytes); return
    }
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
    if (command === 'sync_local_open') return []
    if (command === 'workspace_trash_list') return window.local.trash.map(({ body, ...entry }) => entry)
    // Native rules: both revisions must still match; the replaced body and the copy go to the trash.
    if (command === 'sync_local_resolve') {
      const r = args.request, current = window.local.files.get(r.path), copy = window.local.files.get(r.copy)
      if (current === undefined || copy === undefined || (await hash(enc(current))) !== r.expected || (await hash(enc(copy))) !== r.copyExpected) throw 'revision_conflict'
      const identity = JSON.parse(dec(window.local.identity))
      const copyId = identity.documents.find((d) => d.path === r.copy)?.documentId ?? null
      if (r.bytes && dec(r.bytes) !== current) {
        window.local.trash.push({ operationId: r.snapshotOperation, path: r.snapshotPath, deletedAt: Date.now(), documentId: null, revision: await hash(enc(current)), body: current })
        window.local.files.set(r.path, dec(r.bytes))
      }
      window.local.trash.push({ operationId: r.copyOperation, path: r.copy, deletedAt: Date.now(), documentId: copyId, revision: r.copyExpected, body: copy })
      window.local.files.delete(r.copy)
      identity.documents = identity.documents.filter((d) => d.path !== r.copy)
      window.local.identity = enc(JSON.stringify(identity))
      return hash(enc(window.local.files.get(r.path)))
    }
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

  // Step 4B: a merge conflict copy is listed, resolved line by line and written back; both earlier
  // versions stay in the trash, and the result plus the copy's deletion reach the server.
  const conflicts = page.getByRole('region', { name: '同步冲突' })
  assert.equal(await conflicts.count(), 0)
  await page.evaluate(() => { window.local.files.set('n.md', 'one\ntwo\nthree\n') })
  await dialog.getByRole('button', { name: '立即同步', exact: true }).click()
  await page.waitForFunction(() => window.ownCommit()?.commit.documents.some((d) => d.path === 'n.md'))
  await chip.filter({ hasText: '已同步' }).waitFor()
  // The other device edits the same line and adds one at the end.
  await page.evaluate(async (device) => {
    const { hash: parent, commit } = window.ownCommit()
    const text = window.mockEnc('one\ntwo remote\nthree\nfour remote\n'), object = await window.mockHash(text)
    window.remote.objects.set(object, text)
    const next = { ...commit, operationId: crypto.randomUUID(), deviceId: device, parents: [parent], documents: commit.documents.map((d) => (d.path === 'n.md' ? { ...d, text: { object, bytes: text.length } } : d)) }
    const bytes = window.mockEnc(JSON.stringify(next)), hash = await window.mockHash(bytes)
    window.remote.objects.set(hash, bytes)
    window.remote.heads.set(device, { bytes: window.mockEnc(JSON.stringify({ schemaVersion: 1, workspaceId: commit.workspaceId, deviceId: device, sequence: 2, commitHash: hash })), revision: '"other-2"' })
  }, fixture.DEVICE)
  await page.evaluate(() => { window.local.files.set('n.md', 'one\ntwo local\nthree\n') })
  await dialog.getByRole('button', { name: '立即同步', exact: true }).click()
  await conflicts.getByText(/n\.md 与 n \(冲突 [0-9a-f]{8}\)\.md/).waitFor()
  const copyPath = await page.evaluate(() => [...window.local.files.keys()].find((p) => /^n \(冲突 [0-9a-f]{8}\)\.md$/.test(p)))
  const before = await page.evaluate((copy) => ({ mine: window.local.files.get('n.md'), theirs: window.local.files.get(copy) }), copyPath)
  assert.deepEqual([before.mine, before.theirs].sort(), ['one\ntwo local\nthree\n', 'one\ntwo remote\nthree\nfour remote\n'])
  report.checks.push('a merge conflict copy from two devices editing one line is listed with both paths')

  await conflicts.getByRole('button', { name: '解决', exact: true }).click()
  await conflicts.getByRole('button', { name: '采用冲突副本', exact: true }).click()
  await conflicts.getByRole('checkbox', { name: /确认保存合并结果/ }).check()
  await conflicts.getByRole('button', { name: '应用合并并保存', exact: true }).click()
  await dialog.getByRole('status').filter({ hasText: '已合并 n.md' }).waitFor()
  await conflicts.waitFor({ state: 'detached' })
  // The copy's line wins the conflict; the other side's added line is kept automatically.
  const expected = `one\n${before.theirs.split('\n')[1]}\nthree\nfour remote\n`
  const resolved = await page.evaluate(() => ({ files: Object.fromEntries(window.local.files), trash: window.local.trash.map((t) => ({ path: t.path, body: t.body, documentId: t.documentId })) }))
  assert.equal(resolved.files['n.md'], expected)
  assert.equal(resolved.files[copyPath], undefined)
  const snapshot = resolved.trash.find((t) => /^n \(解决前 \d{8}-\d{6}\)\.md$/.test(t.path)), trashedCopy = resolved.trash.find((t) => t.path === copyPath)
  assert.ok(snapshot && snapshot.body === before.mine && snapshot.documentId === null, JSON.stringify(resolved.trash))
  assert.ok(trashedCopy && trashedCopy.body === before.theirs && trashedCopy.documentId)
  report.checks.push('resolving line by line writes the result and keeps the replaced body and the copy in the trash')

  await page.waitForFunction(([text, copy]) => {
    const own = window.ownCommit(); if (!own) return false
    const doc = own.commit.documents.find((d) => d.path === 'n.md')
    return !!doc && window.mockDec(window.remote.objects.get(doc.text.object)) === text
      && !own.commit.documents.some((d) => d.path === copy) && own.commit.tombstones.some((t) => t.path === copy)
  }, [expected, copyPath])
  report.checks.push('the resolved body and the copy deletion are published on the next pass')

  // Step 4C: the other device's head goes back to an older sequence (server restored from a backup).
  // Sync pauses with an explanation; rejoining under a new device id resumes without touching files.
  const recover = page.getByRole('region', { name: '恢复同步' })
  assert.equal(await recover.count(), 0)
  const oldDevice = await page.evaluate(() => window.bound.deviceId)
  const filesBeforeRollback = await page.evaluate(() => JSON.stringify([...window.local.files].sort()))
  await page.evaluate((head) => { window.remote.heads.set(window.DEVICE_ID, { bytes: window.mockEnc(head), revision: '"h1"' }) }, fixture.head)
  await dialog.getByRole('button', { name: '立即同步', exact: true }).click()
  await chip.filter({ hasText: '同步暂停' }).waitFor()
  await dialog.getByText(/服务器上的同步记录比本机记住的旧/).waitFor()
  await recover.waitFor()
  assert.equal(await page.evaluate(() => JSON.stringify([...window.local.files].sort())), filesBeforeRollback)
  report.checks.push('a rolled-back remote pauses sync with an explanation and leaves files untouched')

  await recover.getByRole('button', { name: '以新设备身份重新加入', exact: true }).click()
  await dialog.getByRole('status').filter({ hasText: '已以新的设备身份重新加入' }).waitFor()
  await chip.filter({ hasText: '已同步' }).waitFor()
  await recover.waitFor({ state: 'detached' })
  const rejoined = await page.evaluate(() => ({ device: window.bound.deviceId, files: JSON.stringify([...window.local.files].sort()), published: !!window.remote.heads.get(window.bound.deviceId) }))
  assert.notEqual(rejoined.device, oldDevice)
  assert.equal(rejoined.files, filesBeforeRollback)
  assert.ok(rejoined.published, 'the new device publishes its own head')
  report.checks.push('rejoining under a new device id resumes sync, publishes a new head and keeps every file')

  // Step 5A: after a rollback the old device id is retired automatically once the new id published.
  await page.waitForFunction((old) => !window.remote.heads.has(old) && window.remote.retired.has(old), oldDevice)
  report.checks.push('after a rollback rejoin the old device id is retired automatically')

  // Sync frequency is saved per binding; manual only explains that saves no longer upload.
  const frequency = dialog.getByRole('combobox', { name: '同步频率' })
  await frequency.selectOption('manual')
  await dialog.getByText(/仅手动同步：保存文档后不会自动上传/).waitFor()
  assert.equal(await page.evaluate(() => localStorage.getItem('easym-sync-interval:b0000000-0000-4000-8000-000000000001')), 'manual')
  await frequency.selectOption('300000')
  await dialog.getByText(/仅手动同步：保存文档后不会自动上传/).waitFor({ state: 'detached' })
  assert.equal(await page.evaluate(() => localStorage.getItem('easym-sync-interval:b0000000-0000-4000-8000-000000000001')), '300000')
  report.checks.push('sync frequency (including manual only) is saved per binding')

  // Device list: this device published its info after the pass; the other device has none.
  const devicesRegion = dialog.getByRole('region', { name: '同步设备' })
  await devicesRegion.getByRole('button', { name: '查看设备', exact: true }).click()
  await devicesRegion.getByText(/（本机）/).waitFor()
  await devicesRegion.getByText(`未命名设备 ${fixture.DEVICE.slice(0, 8)}`).waitFor()
  await devicesRegion.getByLabel('本机名称').fill('测试电脑')
  await devicesRegion.getByRole('button', { name: '保存名称', exact: true }).click()
  await dialog.getByRole('status').filter({ hasText: '已更新本机名称' }).waitFor()
  await devicesRegion.getByText(/测试电脑（本机）/).waitFor()
  const info = await page.evaluate(() => JSON.parse(window.mockDec(window.remote.info.get(window.bound.deviceId))))
  assert.deepEqual([info.name, info.deviceId === undefined], ['测试电脑', false])
  report.checks.push('the device list shows this device and others; renaming publishes the new name')

  // Deactivating the other device completes on the next pass: record written, head removed.
  const other = devicesRegion.getByRole('listitem').filter({ hasText: fixture.DEVICE.slice(0, 8) })
  page.once('dialog', (d) => d.accept())
  await other.getByRole('button', { name: '停用', exact: true }).click()
  await dialog.getByRole('status').filter({ hasText: '已安排停用' }).waitFor()
  await page.waitForFunction(() => !window.remote.heads.has(window.DEVICE_ID) && window.remote.retired.has(window.DEVICE_ID))
  await chip.filter({ hasText: '已同步' }).waitFor()
  await devicesRegion.getByRole('button', { name: '刷新', exact: true }).click()
  await devicesRegion.getByText(`未命名设备 ${fixture.DEVICE.slice(0, 8)}`).waitFor({ state: 'detached' })
  assert.equal(await page.evaluate(() => JSON.stringify([...window.local.files].sort())), filesBeforeRollback)
  report.checks.push('deactivating another device retires it on the next pass and keeps every file')

  const filesBeforeExit = await page.evaluate(() => window.local.files.size)
  page.once('dialog', (d) => d.accept())
  await dialog.getByRole('button', { name: '退出同步', exact: true }).click()
  await dialog.getByRole('status').filter({ hasText: '已退出同步' }).waitFor()
  await chip.waitFor({ state: 'detached' })
  assert.equal(await page.evaluate(() => window.bound), null)
  assert.equal(await page.evaluate(() => window.local.files.size), filesBeforeExit)
  report.checks.push('exit sync removes the binding after confirmation and keeps workspace files')

  await dialog.getByRole('button', { name: '完成', exact: true }).click()
  assert.deepEqual(errors, [])
  report.passed = true
} catch (error) { report.error = error.message; process.exitCode = 1 }
finally {
  await browser?.close(); await server.close()
  await writeFile('test-results/v2.0/step-5/sync-ui.json', JSON.stringify(report, null, 2) + '\n')
}
if (report.passed) console.log(`Sync UI: ${report.checks.length} production checks passed`)
else console.error('Sync UI failed:', report.error)
