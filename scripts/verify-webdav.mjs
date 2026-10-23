// v2.0 step 1: per-device log verification against real WebDAV targets (scripts/webdav/compose.yaml).
// Usage: node scripts/verify-webdav.mjs [apache|nextcloud ...]
// Raw output goes to ignored test-results/v2.0/step-1/; the redacted report is copied to Docs separately.
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { build } from 'vite'
import { request, WebDavSyncProvider } from './webdav/webdav-provider.mjs'

const out = 'test-results/v2.0/step-1'
const env = Object.fromEntries((await readFile(`${out}/webdav.env`, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => line.split(/=(.*)/s, 2)))
const targets = {
  apache: { baseUrl: 'http://127.0.0.1:18081', root: '/dav/', user: env.EASYM_DAV_USER, password: env.EASYM_DAV_PASSWORD },
  nextcloud: { baseUrl: 'http://127.0.0.1:18082', root: `/remote.php/dav/files/${env.EASYM_NC_ADMIN_USER}/`, user: env.EASYM_NC_ADMIN_USER, password: env.EASYM_NC_ADMIN_PASSWORD },
}
const selected = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(targets)

// Bundle the TypeScript core once; an in-process Vite dev server stalls node:http sockets on Windows.
const bundle = resolve(out, 'core')
const entry = resolve('scripts/webdav/core-entry.ts')
await build({ configFile: false, logLevel: 'warn', resolve: { conditions: ['worker', 'module', 'browser', 'production'] }, build: { outDir: bundle, emptyOutDir: true, target: 'node22', minify: false, lib: { entry, formats: ['es'], fileName: () => 'core.js' }, rollupOptions: { input: entry } } })
const core = await import(pathToFileURL(resolve(bundle, 'core.js')).href)
const report = { verifiedAt: new Date().toISOString(), node: process.version, design: 'per-device log (devices/<id>.json single writer, immutable content-addressed objects, deterministic merges)', scope: 'Loopback HTTP containers, isolated test namespaces. Protocol semantics only; no TLS, native credential store or editor integration.', targets: {} }
const encoder = new TextEncoder(), decoder = new TextDecoder(), signal = () => AbortSignal.timeout(60000)
const DEVICES = 4, ROUNDS = 6, SHARED = 3
const tally = (values) => values.reduce((all, v) => ({ ...all, [v]: (all[v] ?? 0) + 1 }), {})
function summary(values) {
  const sorted = [...values].sort((a, b) => a - b), at = (q) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))])
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: Math.round(sorted.at(-1)) }
}
/**
 * Independent simulated device: own provider instance (own connections), own local snapshot and
 * own persisted state file. Mirrors src/core/sync-log.test.ts but against a real server.
 */
class Device {
  constructor(target, workspaceId, name) {
    this.provider = new WebDavSyncProvider(target, core)
    this.workspaceId = workspaceId; this.name = name
    this.state = core.initialDeviceState(workspaceId, randomUUID())
    this.docs = new Map(); this.tombs = new Map(); this.passes = []; this.saved = null
  }
  edit(id, path, text) { this.docs.set(id, { path, text }); this.tombs.delete(id) }
  remove(id) { const doc = this.docs.get(id); if (!doc) return; this.docs.delete(id); this.tombs.set(id, { path: doc.path, operationId: randomUUID() }) }
  async change() {
    const uploads = [], documents = []
    for (const [documentId, doc] of [...this.docs].sort()) {
      const bytes = encoder.encode(doc.text), hash = await core.syncHash(bytes)
      uploads.push({ hash, bytes })
      documents.push({ documentId, path: doc.path, text: { object: hash, bytes: bytes.byteLength }, imageMetadata: null, resources: [] })
    }
    const tombstones = [...this.tombs].sort().map(([documentId, t]) => ({ documentId, ...t }))
    const view = (c) => JSON.stringify([c.documents.map((d) => [d.documentId, d.path, d.text.object]).sort(), c.tombstones.map((t) => [t.documentId, t.path, t.operationId]).sort()])
    const commit = { schemaVersion: 1, workspaceId: this.workspaceId, operationId: randomUUID(), deviceId: this.state.deviceId, parents: this.state.commitHash ? [this.state.commitHash] : [], documents, tombstones }
    if (this.state.commitHash) { if (view(await core.readSyncCommit(this.provider, this.workspaceId, this.state.commitHash, signal())) === view(commit)) return undefined }
    else if (!documents.length && !tombstones.length) return undefined
    return { commit, uploads }
  }
  async sync() {
    const started = performance.now(), before = this.provider.stats.requests
    const result = await core.runSyncPass(this.provider, this.state, { change: await this.change(), persist: async (s) => { this.saved = structuredClone(s) } }, signal())
    this.state = result.state
    if (result.commitHash) await this.load(result.commitHash)
    this.passes.push({ ms: performance.now() - started, requests: this.provider.stats.requests - before })
    return result
  }
  async load(hash) {
    const commit = await core.readSyncCommit(this.provider, this.workspaceId, hash, signal())
    this.docs.clear(); this.tombs.clear()
    for (const d of commit.documents) {
      const bytes = await this.provider.readObject(this.workspaceId, d.text.object, signal())
      if (!bytes || (await core.syncHash(bytes)) !== d.text.object) throw new Error('object_mismatch')
      this.docs.set(d.documentId, { path: d.path, text: decoder.decode(bytes) })
    }
    for (const t of commit.tombstones) this.tombs.set(t.documentId, { path: t.path, operationId: t.operationId })
  }
  view() { return JSON.stringify([...this.docs].sort().map(([id, d]) => [id, d.path, d.text])) }
}

/** Sync passes may legitimately fail on a transient server refusal; retry those, stop on the rest. */
async function syncRetrying(device, tries = 6) {
  for (let attempt = 0; ; attempt++) {
    try { return await device.sync() }
    catch (error) {
      const transient = error.code === 'unexpected_status' && [423, 500, 503].includes(error.status)
      if (!transient || attempt >= tries) throw error
      device.retries = (device.retries ?? 0) + 1
      await sleep(200 * (attempt + 1))
    }
  }
}
/** Sends the complete PUT, then loses the reply (after the server answered, or right after sending). */
function lossyPut(target, path, { headers = {}, body }, mode) {
  const lost = () => Object.assign(new Error('response_lost'), { code: 'response_lost' })
  return new Promise((_, reject) => {
    const req = http.request(new URL(path, target.baseUrl), { method: 'PUT', agent: false, headers: { Authorization: 'Basic ' + Buffer.from(`${target.user}:${target.password}`).toString('base64'), ...headers, 'Content-Length': body.byteLength } })
    req.on('response', (res) => { res.destroy(); req.destroy(); reject(lost()) })
    req.on('error', () => reject(lost()))
    req.end(Buffer.from(body), () => { if (mode === 'after-send') { req.destroy(); reject(lost()) } })
  })
}

async function waitReady(name, target) {
  const deadline = Date.now() + 10 * 60_000
  for (;;) {
    try {
      const res = name === 'nextcloud' ? await request(target, 'GET', '/status.php', { timeoutMs: 5000 }) : await request(target, 'OPTIONS', target.root, { timeoutMs: 5000 })
      if (res.status === 200 && (name !== 'nextcloud' || JSON.parse(decoder.decode(res.body)).installed === true)) return
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw Object.assign(new Error('not_ready'), { code: 'not_ready' })
    await sleep(3000)
  }
}

const codeOf = (promise) => promise.then(() => 'ok', (error) => error.code ?? error.message)

async function probe(name, target) {
  const result = { checks: [], observations: {}, measurements: {} }
  const check = (id, passed, detail = {}) => { result.checks.push({ id, passed, ...detail }); console.log(`${passed ? 'PASS' : 'FAIL'} ${name} ${id}`) }
  const workspace = async () => { const id = randomUUID(); await new WebDavSyncProvider(target, core).prepare(id, signal()); return id }
  const raw = (method, path, options) => request(target, method, path, options)

  const options = await raw('OPTIONS', target.root)
  result.observations.dav = options.headers.dav ?? null
  check('authenticated_options', options.status === 200 || options.status === 204, { status: options.status })
  const ws0 = await workspace()
  const wrong = new WebDavSyncProvider({ ...target, password: 'wrong-' + randomUUID() }, core)
  check('bad_credentials_are_errors_not_absent', (await codeOf(wrong.listDeviceHeads(ws0, signal()))) === 'unauthorized')
  check('cross_origin_request_refused_locally', (await codeOf(Promise.resolve().then(() => request(target, 'GET', 'http://example.invalid/x')))) === 'cross_origin')
  const empty = await new WebDavSyncProvider(target, core).listDeviceHeads(ws0, signal())
  check('empty_workspace_lists_no_heads', Array.isArray(empty) && empty.length === 0)

  // Immutable objects: create-only, and content addressing makes racing creates harmless.
  const p0 = new WebDavSyncProvider(target, core), bytes = encoder.encode('immutable ' + randomUUID()), hash = await core.syncHash(bytes)
  const creates = await Promise.all(Array.from({ length: 8 }, () => new WebDavSyncProvider(target, core).createObject(ws0, hash, bytes, signal()).catch((e) => e.code)))
  const stored = await p0.readObject(ws0, hash, signal())
  check('racing_object_creates_store_exact_bytes', creates.every((c) => c === 'created' || c === 'exists') && (await core.syncHash(stored)) === hash, { outcomes: tally(creates) })
  const overwrite = await raw('PUT', p0.path(ws0, `objects/sha256/${hash.slice(7)}`), { body: encoder.encode('tampered'), headers: { 'If-None-Match': '*' } })
  check('object_not_overwritten_sequentially', overwrite.status === 412 && (await core.syncHash(await p0.readObject(ws0, hash, signal()))) === hash, { status: overwrite.status })
  // Core scenario: DEVICES devices edit concurrently for ROUNDS rounds, syncing in parallel.
  // Every acknowledged edit must survive (in place or as a conflict copy) and all devices converge.
  {
    const ws = await workspace(), devices = Array.from({ length: DEVICES }, (_, i) => new Device(target, ws, `d${i}`))
    const shared = Array.from({ length: SHARED }, () => randomUUID())
    shared.forEach((id, i) => devices[0].edit(id, `共享/文档-${i}.md`, `base ${i}`))
    await syncRetrying(devices[0])
    await Promise.all(devices.slice(1).map(syncRetrying))
    // An edit made while the device already saw text T at that document intentionally replaces T;
    // only texts that no device knowingly replaced must survive.
    const written = new Set(), superseded = new Set(), conflicts = []
    for (let round = 0; round < ROUNDS; round++) {
      devices.forEach((d, i) => {
        const id = shared[(round + i) % SHARED], text = `r${round} d${i} ${randomUUID()}`
        if (d.docs.has(id)) superseded.add(d.docs.get(id).text)
        d.edit(id, d.docs.get(id)?.path ?? `共享/文档-${(round + i) % SHARED}.md`, text); written.add(text)
        const own = randomUUID(), ownText = `own r${round} d${i}`; d.edit(own, `设备${i}/r${round}.md`, ownText); written.add(ownText)
      })
      const results = await Promise.all(devices.map(syncRetrying))
      for (const r of results) conflicts.push(...r.conflicts.map((c) => c.reason))
    }
    for (let i = 0; i < 3; i++) for (const d of devices) await syncRetrying(d)
    const views = devices.map((d) => d.view()), texts = new Set([...devices[0].docs.values()].map((d) => d.text))
    const lost = [...written].filter((t) => !texts.has(t) && !superseded.has(t))
    check('concurrent_devices_converge', new Set(views).size === 1 && new Set(devices.map((d) => d.state.commitHash)).size === 1, { devices: DEVICES, rounds: ROUNDS, distinctViews: new Set(views).size })
    check('no_acknowledged_edit_lost', lost.length === 0, { written: written.size, knowinglyReplaced: [...written].filter((t) => superseded.has(t)).length, lost: lost.length, documents: devices[0].docs.size, conflicts: tally(conflicts) })
    const heads = await devices[0].provider.listDeviceHeads(ws, signal())
    check('one_head_per_device', heads.length === DEVICES && heads.every((h) => h.head.commitHash === devices[0].state.commitHash), { heads: heads.length })
    const passes = devices.flatMap((d) => d.passes)
    result.measurements.syncPassMs = summary(passes.map((p) => p.ms))
    result.measurements.requestsPerPass = summary(passes.map((p) => p.requests))
    result.measurements.transientRetries = devices.reduce((n, d) => n + (d.retries ?? 0), 0)
    result.observations.headEtag = heads[0]?.revision ? 'strong' : 'weak_or_missing'
  }
  // Lost reply on the own head write: the persisted pending record settles it on the next pass.
  for (const mode of ['after-response', 'after-send']) {
    const ws = await workspace(), a = new Device(target, ws, 'a'), b = new Device(target, ws, 'b')
    a.edit(randomUUID(), 'a.md', 'v1'); await syncRetrying(a)
    const text = `lost ${mode} ${randomUUID()}`; a.edit(randomUUID(), 'lost.md', text)
    const headPath = a.provider.path(ws, `devices/${a.state.deviceId}.json`)
    a.provider.target = { ...target, request: (t, method, path, opts) => (method === 'PUT' && path === headPath ? lossyPut(t, path, opts, mode) : request(t, method, path, opts)) }
    const first = await codeOf(a.sync())
    a.provider.target = target
    const pending = a.saved?.pending
    a.state = a.saved
    await sleep(500)
    const settled = await codeOf(syncRetrying(a))
    await syncRetrying(b)
    check(`lost_reply_${mode}_settles`, first === 'unknown_outcome' && !!pending && settled === 'ok' && !a.state.pending && b.view() === a.view() && [...b.docs.values()].some((d) => d.text === text), { first, settled })
  }

  // A second installation reusing a device id is refused, never merged into the first one's head.
  {
    const ws = await workspace(), a = new Device(target, ws, 'a')
    a.edit(randomUUID(), 'a.md', 'v1'); await syncRetrying(a)
    const clone = new Device(target, ws, 'clone'); clone.state = core.initialDeviceState(ws, a.state.deviceId)
    clone.edit(randomUUID(), 'b.md', 'clone')
    const outcome = await codeOf(clone.sync())
    const heads = await a.provider.listDeviceHeads(ws, signal())
    check('cloned_device_id_refused', outcome === 'device_conflict' && heads.length === 1 && heads[0].head.commitHash === a.state.commitHash, { outcome })
  }

  // Rollback of another device's head (e.g. restored server backup) stops sync instead of resurrecting state.
  {
    const ws = await workspace(), a = new Device(target, ws, 'a'), b = new Device(target, ws, 'b')
    a.edit(randomUUID(), 'a.md', 'v1'); await syncRetrying(a); await syncRetrying(b)
    const headPath = a.provider.path(ws, `devices/${a.state.deviceId}.json`), old = await raw('GET', headPath)
    a.edit(randomUUID(), 'b.md', 'v2'); await syncRetrying(a); await syncRetrying(b)
    await raw('PUT', headPath, { body: old.body })
    const rolled = await codeOf(b.sync())
    await raw('DELETE', headPath)
    const removed = await codeOf(b.sync())
    check('rollback_and_removed_head_detected', rolled === 'rollback' && removed === 'rollback', { rolled, removed })
  }

  // A head pointing at a tampered or missing commit is never applied.
  {
    const ws = await workspace(), a = new Device(target, ws, 'a'), b = new Device(target, ws, 'b')
    a.edit(randomUUID(), 'a.md', 'v1'); await syncRetrying(a)
    const objectPath = a.provider.path(ws, `objects/sha256/${a.state.commitHash.slice(7)}`)
    await raw('DELETE', objectPath)
    const missing = await codeOf(b.sync())
    await raw('PUT', objectPath, { body: encoder.encode('{"schemaVersion":1}') })
    const tampered = await codeOf(b.sync())
    check('tampered_or_missing_commit_rejected', missing === 'missing_object' && tampered === 'hash_mismatch' && b.docs.size === 0, { missing, tampered })
  }

  // Cancelling during a large upload never advances the head; the next pass completes.
  {
    const ws = await workspace(), a = new Device(target, ws, 'a')
    a.edit(randomUUID(), 'big.md', 'x'.repeat(8 * 1024 * 1024))
    const controller = new AbortController(); setTimeout(() => controller.abort(), 5)
    const change = await a.change()
    const outcome = await codeOf(core.runSyncPass(a.provider, a.state, { change, persist: async () => {} }, controller.signal))
    const heads = await a.provider.listDeviceHeads(ws, signal())
    const retried = await codeOf(syncRetrying(a))
    check('cancel_never_advances_head', outcome !== 'ok' && heads.length === 0 && retried === 'ok', { outcome })
  }

  // Unexpected entries in devices/ stop sync rather than being silently ignored.
  {
    const ws = await workspace(), a = new Device(target, ws, 'a')
    await raw('PUT', a.provider.path(ws, 'devices/not-a-device.json'), { body: encoder.encode('{}') })
    check('unknown_device_entry_rejected', (await codeOf(a.sync())) === 'invalid_listing')
  }

  // Loopback transfer cost.
  const p1 = new WebDavSyncProvider(target, core), mib = encoder.encode('m'.repeat(1024 * 1024)), mibHash = await core.syncHash(mib), t0 = performance.now()
  await p1.createObject(ws0, mibHash, mib, signal())
  const t1 = performance.now(); await p1.readObject(ws0, mibHash, signal())
  Object.assign(result.measurements, { upload1MiBMs: Math.round(t1 - t0), download1MiBMs: Math.round(performance.now() - t1) })
  result.passed = result.checks.every((c) => c.passed)
  return result
}

await mkdir(out, { recursive: true })
try {
  for (const name of selected) {
    if (!targets[name]) throw new Error(`Unknown target ${name}`)
    try { await waitReady(name, targets[name]); report.targets[name] = await probe(name, targets[name]) }
    catch (error) { report.targets[name] = { passed: false, error: error.code ?? error.message }; console.error(`ERROR ${name}`, error.code ?? error.message, error.status ?? '') }
  }
  report.passed = selected.every((name) => report.targets[name]?.passed)
} finally {
  await writeFile(`${out}/webdav-report.json`, JSON.stringify(report, null, 2) + '\n')
}
console.log(`\nReport: ${out}/webdav-report.json  passed=${report.passed}`)
if (!report.passed) process.exitCode = 1
