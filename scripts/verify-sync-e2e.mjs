// v2.0 step 3C: end-to-end sync against real WebDAV targets (scripts/webdav/compose.yaml).
// Drives the shipping core engine (src/core/sync-engine.ts) with a directory-backed host and the
// step-1 WebDAV client. Usage: node scripts/verify-sync-e2e.mjs [apache|nextcloud ...]
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { WebDavSyncProvider } from './webdav/webdav-provider.mjs'
import { enableIdentity, exists, FsHost } from './webdav/fs-host.mjs'

const out = 'test-results/v2.0/step-3'
const env = Object.fromEntries((await readFile('test-results/v2.0/step-1/webdav.env', 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => line.split(/=(.*)/s, 2)))
const targets = {
  apache: { baseUrl: 'http://127.0.0.1:18081', root: '/dav/', user: env.EASYM_DAV_USER, password: env.EASYM_DAV_PASSWORD },
  nextcloud: { baseUrl: 'http://127.0.0.1:18082', root: `/remote.php/dav/files/${env.EASYM_NC_ADMIN_USER}/`, user: env.EASYM_NC_ADMIN_USER, password: env.EASYM_NC_ADMIN_PASSWORD },
}
const selected = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(targets)

await mkdir(out, { recursive: true })
const bundle = resolve(out, 'core'), entry = resolve('scripts/webdav/core-entry.ts')
await build({ configFile: false, logLevel: 'warn', resolve: { conditions: ['worker', 'module', 'browser', 'production'] }, build: { outDir: bundle, emptyOutDir: true, target: 'node22', minify: false, lib: { entry, formats: ['es'], fileName: () => 'core.js' }, rollupOptions: { input: entry } } })
const core = await import(pathToFileURL(resolve(bundle, 'core.js')).href)
const signal = () => AbortSignal.timeout(300_000)
const png = await readFile('src-tauri/icons/32x32.png')
const report = { verifiedAt: new Date().toISOString(), node: process.version, scope: 'Real engine and WebDAV servers on loopback HTTP; directory-backed host mirrors the native commands. No GUI, TLS or OS credential store.', targets: {} }

/** Every file under a workspace except sync bookkeeping, as relative path → bytes (hex digest). */
async function tree(root, dir = '') {
  const out = {}
  for (const item of await readdir(join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${item.name}` : item.name
    if (rel === '.state.json' || rel.startsWith('.easym/sync') || rel.startsWith('.easym/trash') || rel.startsWith('.easym/operations')) continue
    if (item.isDirectory()) Object.assign(out, await tree(root, rel))
    else out[rel] = (await readFile(join(root, rel))).toString('base64')
  }
  return out
}
/**
 * images.json as comparable data: the process-local documentId is cleared and keys are sorted.
 * Its bytes legitimately differ per device (whoever wrote it, in which order).
 */
const sortKeys = (value) => Array.isArray(value) ? value.map(sortKeys) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])])) : value
async function instances(root, dir) {
  try { return JSON.stringify(JSON.parse(await readFile(join(root, dir, '.easym/images.json'), 'utf8')).instances.map((i) => sortKeys({ ...i, documentId: null })).sort((a, b) => (a.instanceId < b.instanceId ? -1 : 1))) } catch { return null }
}
/** Workspace files compared by bytes, except images.json (compared via `instances`) and sync bookkeeping. */
const bodies = (files) => Object.fromEntries(Object.entries(files).filter(([k]) => !k.endsWith('.easym/images.json') && !k.startsWith('.easym/sync')))
/** A simulated installation: its own directory, device id, provider connection and engine. */
async function device(target, workspaceId, root) {
  root ??= await mkdtemp(join(tmpdir(), 'easym-e2e-'))
  const host = new FsHost(root, core, { workspaceId, deviceId: randomUUID() })
  const provider = new WebDavSyncProvider(target, core)
  await provider.prepare(workspaceId, signal())
  return { root, host, provider, engine: new core.SyncEngine(provider, host), pass: () => new core.SyncEngine(provider, host).pass(signal()) }
}
const imageMeta = (doc) => ({ schemaVersion: 1, instances: [{ instanceId: 'img-e2e', documentId: 'process-local', sourcePath: 'assets/.originals/img-e2e-source.png', sourceHash: 'sha256:x', displayPath: 'assets/img-e2e-v1.png', recipe: { version: 1, orientationNormalized: true, rotateDegrees: 0, flipHorizontal: false, flipVertical: false, output: { mime: 'image/png' } }, referenceRevision: 1, doc }] })

async function roundTrip(name, target) {
  const checks = [], check = (id, passed, detail = {}) => { checks.push({ id, passed, ...detail }); console.log(`${passed ? 'PASS' : 'FAIL'} ${name} ${id}`) }
  const workspaceId = randomUUID()
  const a = await device(target, workspaceId)
  // CRLF, BOM, emoji and a CJK path: bytes must survive unchanged.
  await mkdir(join(a.root, '笔记/assets/.originals'), { recursive: true }); await mkdir(join(a.root, '笔记/.easym'), { recursive: true })
  await writeFile(join(a.root, '笔记/图文.md'), '﻿# 图文\r\n\r\n![图](assets/img-e2e-v1.png)\r\n😀\r\n')
  await writeFile(join(a.root, '笔记/assets/img-e2e-v1.png'), png); await writeFile(join(a.root, '笔记/assets/.originals/img-e2e-source.png'), png)
  await writeFile(join(a.root, '笔记/.easym/images.json'), JSON.stringify(imageMeta('a')))
  await writeFile(join(a.root, 'plain.md'), 'plain\n')
  await enableIdentity(a.root, core, workspaceId, ['plain.md', '笔记/图文.md'])
  const first = await a.pass()
  check('device_a_publishes', first.published && first.failed.length === 0, { requests: a.provider.stats.requests })
  const expected = await tree(a.root)

  // Device B: a fresh installation that only knows the endpoint (A's config is wiped below).
  const b = await device(target, workspaceId)
  await enableIdentity(b.root, core, workspaceId, [])
  const restore = await b.pass()
  const restored = await tree(b.root)
  const same = JSON.stringify(bodies(expected)) === JSON.stringify(bodies(restored))
  check('fresh_device_restores_bodies_and_images', same && restore.downloaded === 2, { downloaded: restore.downloaded, files: Object.keys(bodies(restored)).length })
  const metaA = await instances(a.root, '笔记'), metaB = await instances(b.root, '笔记')
  check('image_metadata_restored', metaA !== null && metaA === metaB)
  // A loses its sync state and even its identity file (reinstall plus a copied workspace); files
  // stay. Rejoining with "link same-named documents" (the pairing choice) must neither duplicate
  // nor overwrite anything: same bytes are recognized, not copied.
  await rm(join(a.root, '.state.json'), { force: true }); await rm(join(a.root, '.easym/sync'), { recursive: true, force: true })
  const again = await device(target, workspaceId, a.root)
  const fresh = await enableIdentity(again.root, core, workspaceId, ['plain.md', '笔记/图文.md'])
  const remoteHeads = await again.provider.listDeviceHeads(workspaceId, signal())
  const remoteCommits = await Promise.all(remoteHeads.map((h) => core.readSyncCommit(again.provider, workspaceId, h.head.commitHash, signal())))
  const linked = core.linkSameNamed(fresh, remoteCommits)
  await writeFile(join(again.root, '.easym/sync/workspace.json'), core.encodeWorkspaceIdentity(linked.identity))
  const rejoin = await again.pass()
  const afterRejoin = await tree(again.root)
  check('wiped_device_rejoins_without_copies', rejoin.copies.length === 0 && rejoin.failed.length === 0 && JSON.stringify(bodies(afterRejoin)) === JSON.stringify(bodies(expected)), { copies: rejoin.copies.length, linked: linked.linked.length })

  // Edits travel B → A.
  await writeFile(join(b.root, 'plain.md'), 'plain edited on B\n')
  await b.pass(); await again.pass()
  check('edit_travels_back', (await readFile(join(again.root, 'plain.md'), 'utf8')) === 'plain edited on B\n')

  // Concurrent edits of the same document keep both versions.
  await writeFile(join(again.root, 'plain.md'), 'from A\n'); await writeFile(join(b.root, 'plain.md'), 'from B\n')
  await again.pass(); await b.pass(); await again.pass(); await b.pass()
  const texts = async (root) => Promise.all((await readdir(root)).filter((f) => f.endsWith('.md')).map((f) => readFile(join(root, f), 'utf8')))
  const aTexts = (await texts(again.root)).sort(), bTexts = (await texts(b.root)).sort()
  check('concurrent_edits_keep_both', aTexts.includes('from A\n') && aTexts.includes('from B\n') && JSON.stringify(aTexts) === JSON.stringify(bTexts), { files: aTexts.length })

  // Step 4A: concurrent edits of different lines merge into one file on both devices, no copy.
  await writeFile(join(again.root, 'lines.md'), '# 标题\r\n\r\n正文\r\n\r\n结尾\r\n')
  await again.pass(); await b.pass()
  await writeFile(join(again.root, 'lines.md'), '# 标题 A\r\n\r\n正文\r\n\r\n结尾\r\n'); await writeFile(join(b.root, 'lines.md'), '# 标题\r\n\r\n正文\r\n\r\n结尾 B\r\n')
  await again.pass(); const lineMerge = await b.pass(); await again.pass()
  const mergedA = await readFile(join(again.root, 'lines.md'), 'utf8'), mergedB = await readFile(join(b.root, 'lines.md'), 'utf8')
  const lineCopies = (await readdir(b.root)).filter((f) => f.startsWith('lines') && f !== 'lines.md')
  check('different_lines_merge_without_copy', mergedA === '# 标题 A\r\n\r\n正文\r\n\r\n结尾 B\r\n' && mergedB === mergedA && lineCopies.length === 0 && lineMerge.conflicts.some((c) => c.reason === 'merged'), { copies: lineCopies.length })

  // Interrupted local writes on B are completed on retry, never duplicated.
  await writeFile(join(again.root, 'new.md'), 'new on A\n')
  await again.pass()
  b.host.failOnce = 'write'
  const broken = await b.pass()
  const retried = await b.pass()
  const newCopies = (await readdir(b.root)).filter((f) => f.startsWith('new'))
  check('interrupted_apply_retries_without_duplicates', broken.failed.length === 1 && retried.failed.length === 0 && newCopies.length === 1 && (await readFile(join(b.root, 'new.md'), 'utf8')) === 'new on A\n')

  // A deletion on A reaches B's in-app trash, never a hard delete.
  await again.host.userTrash('new.md')
  await again.pass(); await b.pass()
  const trashed = await exists(join(b.root, '.easym/trash'))
  check('deletion_reaches_other_device_as_trash', !(await exists(join(b.root, 'new.md'))) && trashed)

  for (const root of [a.root, b.root]) await rm(root, { recursive: true, force: true })
  return { passed: checks.every((c) => c.passed), checks, requests: { a: a.provider.stats.requests + again.provider.stats.requests, b: b.provider.stats.requests } }
}

let ok = true
for (const name of selected) {
  try { report.targets[name] = await roundTrip(name, targets[name]) }
  catch (error) { report.targets[name] = { passed: false, error: error.code ?? error.message }; console.error(`ERROR ${name}`, error.code ?? error.message) }
  ok &&= report.targets[name].passed
}
report.passed = ok
await writeFile(`${out}/sync-e2e.json`, JSON.stringify(report, null, 2) + '\n')
console.log(`Report: ${out}/sync-e2e.json  passed=${ok}`)
if (!ok) process.exitCode = 1
