// v2.0 step 1: protocol probe against real WebDAV targets started from scripts/webdav/compose.yaml.
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
await build({ configFile: false, logLevel: 'warn', build: { outDir: bundle, emptyOutDir: true, target: 'node22', minify: false, lib: { entry, formats: ['es'], fileName: () => 'core.js' }, rollupOptions: { input: entry } } })
const core = await import(pathToFileURL(resolve(bundle, 'core.js')).href), contract = core
const report = { verifiedAt: new Date().toISOString(), node: process.version, scope: 'Loopback HTTP containers, isolated test namespace. Protocol semantics only; no TLS, native credential store or editor integration.', targets: {} }
const encoder = new TextEncoder(), signal = () => AbortSignal.timeout(30000)
const ROUNDS = 20, CREATE_ROUNDS = 10, RACERS = 8

async function body(text) { const bytes = encoder.encode(text); return { bytes, hash: await contract.syncHash(bytes) } }
async function commit(workspaceId, text, parents, deviceId = randomUUID()) {
  const doc = await body(text)
  return {
    uploads: [doc],
    commit: { schemaVersion: 1, workspaceId, operationId: randomUUID(), deviceId, parents, documents: [{ documentId: randomUUID(), path: '笔记/同步.md', text: { object: doc.hash, bytes: doc.bytes.byteLength }, imageMetadata: null, resources: [] }], tombstones: [] },
  }
}
const tally = (values) => values.reduce((all, v) => ({ ...all, [v]: (all[v] ?? 0) + 1 }), {})
const etagForm = (etag) => (etag == null ? 'missing' : etag.startsWith('W/') ? 'weak' : 'strong')
const etagValue = (etag) => etag?.replace(/^W\//, '') ?? null
function summary(values) {
  const sorted = [...values].sort((a, b) => a - b), at = (q) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))])
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: Math.round(sorted.at(-1)) }
}

/**
 * Sends the complete PUT, then loses the reply. `after-response` waits until the server has
 * answered (committed, reply lost); `after-send` hangs up as soon as the body is flushed.
 */
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
      if (res.status === 200 && (name !== 'nextcloud' || JSON.parse(new TextDecoder().decode(res.body)).installed === true)) return
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw Object.assign(new Error('not_ready'), { code: 'not_ready' })
    await sleep(3000)
  }
}
async function probe(name, target) {
  const result = { checks: [], observations: {}, measurements: {} }
  const check = (id, passed, detail = {}) => { result.checks.push({ id, passed, ...detail }); console.log(`${passed ? 'PASS' : 'FAIL'} ${name} ${id}`) }
  const workspaceId = randomUUID()
  const provider = new WebDavSyncProvider(target, contract.parseSyncHead)
  const headPath = provider.path(workspaceId, 'head.json')
  const raw = (method, path, options) => request(target, method, path, options)
  const readHead = () => provider.readHead(workspaceId, signal())
  const publish = (x, expected, uploads = x.uploads, existing = new Set()) => core.publishSyncCommit(provider, x.commit, uploads, existing, expected, signal())
  const match = (head) => ({ kind: 'match', revision: head.revision })
  // `unknown` is a legal Provider answer; settle it through ancestry as the sync engine will.
  let unknownOutcomes = 0
  const settle = async (x, outcome) => {
    if (outcome.result.kind !== 'unknown') return outcome.result.kind
    unknownOutcomes++
    const resolved = await core.resolveSyncPublication(provider, workspaceId, { operationId: x.commit.operationId, commitHash: outcome.commitHash }, signal())
    return resolved.kind === 'committed' || resolved.kind === 'superseded' ? 'committed' : resolved.kind === 'absent' ? 'conflict' : 'undetermined'
  }

  const options = await raw('OPTIONS', target.root)
  result.observations.dav = options.headers.dav ?? null
  result.observations.allow = options.headers.allow ?? null
  check('authenticated_options', options.status === 200 || options.status === 204, { status: options.status })
  let unauthorized = 'none'
  try { await new WebDavSyncProvider({ ...target, password: 'wrong-' + randomUUID() }, contract.parseSyncHead).readHead(workspaceId, signal()) } catch (error) { unauthorized = error.code }
  check('bad_credentials_are_errors_not_absent', unauthorized === 'unauthorized', { code: unauthorized })
  const crossOrigin = await Promise.resolve().then(() => request(target, 'GET', 'http://example.invalid/x')).then(() => 'sent', (error) => error.code)
  check('cross_origin_request_refused_locally', crossOrigin === 'cross_origin')

  await provider.prepare(workspaceId, signal())
  check('missing_head_is_absent', (await readHead()) === null)

  // Immutable objects: create-only, verified on collision.
  const object = await body('immutable ' + randomUUID())
  const objectPath = provider.path(workspaceId, `objects/sha256/${object.hash.slice(7)}`)
  const created = await provider.createObject(workspaceId, object.hash, object.bytes, signal())
  const again = await provider.createObject(workspaceId, object.hash, object.bytes, signal())
  const overwrite = await raw('PUT', objectPath, { body: encoder.encode('tampered'), headers: { 'If-None-Match': '*' } })
  const stored = await provider.readObject(workspaceId, object.hash, signal())
  check('object_create_only', created === 'created' && again === 'exists' && overwrite.status === 412 && (await contract.syncHash(stored)) === object.hash, { overwriteStatus: overwrite.status })
  const objectGet = await raw('GET', objectPath)
  result.observations.objectEtag = etagForm(objectGet.headers.etag)
  // First-commit race: RACERS clients create the head with If-None-Match: *.
  const first = await Promise.all(Array.from({ length: RACERS }, () => commit(workspaceId, 'first ' + randomUUID(), [])))
  const firstResults = await Promise.all(first.map((x) => publish(x, { kind: 'absent' })))
  const firstKinds = await Promise.all(firstResults.map((r, i) => settle(first[i], r)))
  let head = await readHead()
  const winner = firstResults[firstKinds.indexOf('committed')]
  // Count server acknowledgements, not settled outcomes: ancestry resolution can hide a
  // writer that was told 2xx but whose head was then overwritten by a concurrent 2xx.
  const acked = (outcomes) => outcomes.filter((o) => o.result.httpStatus === 201 || o.result.httpStatus === 204).length
  // One round rarely exposes a non-atomic create; repeat on fresh workspaces.
  const createStatuses = firstResults.map((r) => r.result.httpStatus); let createMultiAck = acked(firstResults) > 1 ? 1 : 0
  for (let round = 1; round < CREATE_ROUNDS; round++) {
    const ws = randomUUID(), other = new WebDavSyncProvider(target, contract.parseSyncHead)
    await other.prepare(ws, signal())
    const racers = await Promise.all(Array.from({ length: RACERS }, () => commit(ws, `create ${round} ` + randomUUID(), [])))
    const outcomes = await Promise.all(racers.map((x) => core.publishSyncCommit(other, x.commit, x.uploads, new Set(), { kind: 'absent' }, signal())))
    createStatuses.push(...outcomes.map((o) => o.result.httpStatus))
    if (acked(outcomes) > 1) createMultiAck++
  }
  check('absent_create_race_single_winner', createMultiAck === 0 && firstKinds.filter((k) => k === 'committed').length === 1 && head?.head.commitHash === winner?.commitHash, { rounds: CREATE_ROUNDS, racers: RACERS, multiAck: createMultiAck, statuses: tally(createStatuses) })
  const headGet = await raw('GET', headPath)
  result.observations.headEtag = etagForm(headGet.headers.etag)
  result.observations.putReturnsEtag = winner?.result.kind === 'committed'
  check('strong_etag_on_head', result.observations.headEtag === 'strong', { form: result.observations.headEtag })
  const weakMatch = await raw('PUT', headPath, { body: headGet.body, headers: { 'If-Match': `W/${etagValue(headGet.headers.etag)}` } })
  result.observations.weakIfMatchStatus = weakMatch.status
  check('weak_if_match_never_writes', weakMatch.status === 412 || weakMatch.status === 400, { status: weakMatch.status })

  // Conditional update races on the same revision, repeated to catch intermittent lost updates.
  const rounds = [], statuses = []; let lostUpdates = 0, multiAck = 0, noWinner = 0, undetermined = 0
  for (let round = 0; round < ROUNDS; round++) {
    const base = await readHead()
    const racers = await Promise.all(Array.from({ length: RACERS }, () => commit(workspaceId, `r${round} ` + randomUUID(), [base.head.commitHash])))
    const started = performance.now()
    const outcomes = await Promise.all(racers.map((x) => publish(x, match(base))))
    rounds.push(performance.now() - started)
    const kinds = await Promise.all(outcomes.map((o, i) => settle(racers[i], o)))
    const after = await readHead()
    const committed = outcomes.filter((_, i) => kinds[i] === 'committed')
    statuses.push(...outcomes.map((o) => o.result.httpStatus))
    undetermined += kinds.filter((k) => k === 'undetermined').length
    if (acked(outcomes) > 1) multiAck++
    if (committed.length === 0) noWinner++
    else if (committed.length !== 1 || committed[0].commitHash !== after.head.commitHash) lostUpdates++
  }
  check('if_match_race_single_winner', multiAck === 0 && lostUpdates === 0 && undetermined === 0, { rounds: ROUNDS, racers: RACERS, multiAck, lostUpdates, undetermined })
  // Zero winners (e.g. every racer refused with 423 Locked) is safe but costs liveness; record it separately.
  check('if_match_race_progress', noWinner === 0, { roundsWithoutWinner: noWinner, statuses: tally(statuses) })
  result.measurements.raceRoundMs = summary(rounds)

  // Head JSON has a fixed length, so consecutive heads are same-size rewrites milliseconds apart.
  head = await readHead()
  const sameSize = await Promise.all([0, 1].map(() => commit(workspaceId, 'same-size ' + randomUUID(), [head.head.commitHash])))
  await settle(sameSize[0], await publish(sameSize[0], match(head)))
  const mid = await readHead()
  await settle(sameSize[1], await publish(sameSize[1], match(mid)))
  const end = await readHead()
  const stale = await publish(sameSize[0], match(mid), [], core.commitObjects(sameSize[0].commit))
  check('etag_changes_on_same_size_rewrite', head.revision !== mid.revision && mid.revision !== end.revision && stale.result.kind === 'conflict', { stale: stale.result.kind })
  // Response loss, two variants: reply lost after the server answered, and hang-up right after sending.
  for (const mode of ['after-response', 'after-send']) {
    const base = await readHead()
    const lost = await commit(workspaceId, `lost ${mode} ` + randomUUID(), [base.head.commitHash])
    const dropping = new WebDavSyncProvider({ ...target, request: (t, method, path, opts) => (method === 'PUT' && path === headPath ? lossyPut(t, path, opts, mode) : request(t, method, path, opts)) }, contract.parseSyncHead)
    const lostResult = await core.publishSyncCommit(dropping, lost.commit, lost.uploads, new Set(), match(base), signal())
    await sleep(1000)
    const publication = { operationId: lost.commit.operationId, commitHash: lostResult.commitHash }
    const resolved = await core.resolveSyncPublication(provider, workspaceId, publication, signal())
    const after = await readHead()
    // Either outcome is legal for a hang-up; what matters is that resolution matches the actual head.
    const consistent = resolved.kind === 'committed' ? after.head.commitHash === lostResult.commitHash : resolved.kind === 'absent' && after.head.commitHash === base.head.commitHash
    check(`lost_response_${mode}_resolved_consistently`, lostResult.result.kind === 'unknown' && consistent && (mode !== 'after-response' || resolved.kind === 'committed'), { publish: lostResult.result.kind, resolved: resolved.kind })
    // Retrying a committed publication with its old revision must conflict, never duplicate.
    const retry = await publish(lost, match(base), [], core.commitObjects(lost.commit))
    const settledRetry = resolved.kind === 'committed' ? retry.result.kind : await settle(lost, retry)
    check(`lost_response_${mode}_retry_safe`, resolved.kind === 'committed' ? retry.result.kind === 'conflict' : settledRetry === 'committed', { retry: retry.result.kind })
  }

  // Another device builds on an earlier commit; resolution must report superseded, not absent.
  const current = await readHead()
  const anchor = { operationId: (await core.readSyncCommit(provider, workspaceId, current.head.commitHash, signal())).operationId, commitHash: current.head.commitHash }
  const next = await commit(workspaceId, 'next ' + randomUUID(), [current.head.commitHash])
  await settle(next, await publish(next, match(current)))
  const superseded = await core.resolveSyncPublication(provider, workspaceId, anchor, signal())
  check('superseded_after_other_device', superseded.kind === 'superseded', { resolved: superseded.kind })

  // Cancelling during an object upload never moves the head.
  const before = await readHead()
  const big = await commit(workspaceId, 'x'.repeat(8 * 1024 * 1024), [before.head.commitHash])
  const controller = new AbortController(); setTimeout(() => controller.abort(), 5)
  let cancelled = 'completed'
  try { await core.publishSyncCommit(provider, big.commit, big.uploads, new Set(), match(before), controller.signal) } catch (error) { cancelled = error.code ?? error.name }
  check('cancel_before_head_keeps_head', cancelled !== 'completed' && (await readHead()).head.commitHash === before.head.commitHash, { outcome: cancelled })

  // Read-after-write on fresh connections.
  const visible = []
  for (let i = 0; i < 10; i++) {
    const base = await readHead(), x = await commit(workspaceId, `raw ${i} ` + randomUUID(), [base.head.commitHash])
    const published = await publish(x, match(base))
    await settle(x, published)
    visible.push((await readHead()).head.commitHash === published.commitHash)
  }
  check('read_after_write_visible', visible.every(Boolean), { samples: visible.length })

  // Objects whose bytes do not match their address are rejected on read.
  const forged = await body('{"schemaVersion":1}')
  const forgedHash = `sha256:${'e'.repeat(64)}`
  await raw('PUT', provider.path(workspaceId, `objects/sha256/${forgedHash.slice(7)}`), { body: forged.bytes, headers: { 'If-None-Match': '*' } })
  let tamper = 'accepted'
  try { await core.readSyncCommit(provider, workspaceId, forgedHash, signal()) } catch (error) { tamper = error.code }
  check('mismatched_object_rejected', tamper === 'hash_mismatch', { code: tamper })

  // Transfer cost for a 1 MiB object and a head round trip on loopback.
  const mib = await body('m'.repeat(1024 * 1024)), t0 = performance.now()
  await provider.createObject(workspaceId, mib.hash, mib.bytes, signal())
  const t1 = performance.now(); await provider.readObject(workspaceId, mib.hash, signal())
  const t2 = performance.now(); await readHead()
  Object.assign(result.measurements, { upload1MiBMs: Math.round(t1 - t0), download1MiBMs: Math.round(t2 - t1), readHeadMs: Math.round(performance.now() - t2), unknownOutcomesSettled: unknownOutcomes, provider: provider.stats })
  result.passed = result.checks.every((c) => c.passed)
  return result
}

await mkdir(out, { recursive: true })
try {
  for (const name of selected) {
    if (!targets[name]) throw new Error(`Unknown target ${name}`)
    try { await waitReady(name, targets[name]); report.targets[name] = await probe(name, targets[name]) }
    catch (error) { report.targets[name] = { passed: false, error: error.code ?? error.message }; console.error(`ERROR ${name}`, error.code ?? error.message) }
  }
  report.passed = selected.every((name) => report.targets[name]?.passed)
} finally {
  await writeFile(`${out}/webdav-report.json`, JSON.stringify(report, null, 2) + '\n')
}
console.log(`\nReport: ${out}/webdav-report.json  passed=${report.passed}`)
if (!report.passed) process.exitCode = 1
