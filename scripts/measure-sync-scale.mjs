// v2.0 step 5B: sync cost of a large workspace against the step-1 WebDAV containers.
// Real engine + directory host; objects are cached like the native client (sync_native.rs).
// Usage: node scripts/measure-sync-scale.mjs [apache|nextcloud] [documents]
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { WebDavSyncProvider } from './webdav/webdav-provider.mjs'
import { enableIdentity, FsHost } from './webdav/fs-host.mjs'

const out = 'test-results/v2.0/step-5'
const env = Object.fromEntries((await readFile('test-results/v2.0/step-1/webdav.env', 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => line.split(/=(.*)/s, 2)))
const targets = {
  apache: { baseUrl: 'http://127.0.0.1:18081', root: '/dav/', user: env.EASYM_DAV_USER, password: env.EASYM_DAV_PASSWORD },
  nextcloud: { baseUrl: 'http://127.0.0.1:18082', root: `/remote.php/dav/files/${env.EASYM_NC_ADMIN_USER}/`, user: env.EASYM_NC_ADMIN_USER, password: env.EASYM_NC_ADMIN_PASSWORD },
}
const name = process.argv[2] ?? 'apache', count = Number(process.argv[3] ?? 2000)
const target = targets[name]

await mkdir(out, { recursive: true })
const bundle = resolve(out, 'core'), entry = resolve('scripts/webdav/core-entry.ts')
await build({ configFile: false, logLevel: 'warn', resolve: { conditions: ['worker', 'module', 'browser', 'production'] }, build: { outDir: bundle, emptyOutDir: true, target: 'node22', minify: false, lib: { entry, formats: ['es'], fileName: () => 'core.js' }, rollupOptions: { input: entry } } })
const core = await import(pathToFileURL(resolve(bundle, 'core.js')).href)
const signal = () => AbortSignal.timeout(600_000)

/** Immutable objects are cached after a verified read or a put, as the native client does. */
function cached(provider) {
  const cache = new Map()
  return new Proxy(provider, { get(t, key) {
    if (key === 'readObject') return async (ws, hash, s) => { if (cache.has(hash)) return cache.get(hash); const bytes = await t.readObject(ws, hash, s); if (bytes) cache.set(hash, bytes); return bytes }
    if (key === 'createObject') return async (ws, hash, bytes, s) => { const r = await t.createObject(ws, hash, bytes, s); cache.set(hash, bytes); return r }
    const value = t[key]; return typeof value === 'function' ? value.bind(t) : value
  } })
}
/** Counts full workspace scans and their time; each scan reads and hashes every document. */
function counted(host) {
  const stats = { scans: 0, scanMs: 0, reads: 0 }
  const scan = host.scan.bind(host), read = host.read.bind(host)
  host.scan = async () => { const t = performance.now(); try { return await scan() } finally { stats.scans++; stats.scanMs += performance.now() - t } }
  host.read = async (path) => { stats.reads++; return read(path) }
  return stats
}
async function device(workspaceId, root) {
  root ??= await mkdtemp(join(tmpdir(), 'easym-scale-'))
  const host = new FsHost(root, core, { workspaceId, deviceId: randomUUID() })
  const raw = new WebDavSyncProvider(target, core)
  await raw.prepare(workspaceId, signal())
  const stats = counted(host)
  return { root, host, raw, stats, engine: new core.SyncEngine(cached(raw), host) }
}
const report = { measuredAt: new Date().toISOString(), node: process.version, target: name, documents: count, scope: 'Loopback HTTP, real engine, directory host, native-like object cache. Not a GUI or native-command measurement.', phases: {} }
async function phase(label, d, run) {
  const requests = d.raw.stats.requests, scans = d.stats.scans, scanMs = d.stats.scanMs, reads = d.stats.reads, t = performance.now()
  const result = await run()
  report.phases[label] = { ms: Math.round(performance.now() - t), requests: d.raw.stats.requests - requests, scans: d.stats.scans - scans, scanMs: Math.round(d.stats.scanMs - scanMs), reads: d.stats.reads - reads }
  console.log(label, JSON.stringify(report.phases[label]))
  return result
}

const workspaceId = randomUUID(), a = await device(workspaceId)
try {
  const paths = []
  for (let i = 0; i < count; i++) {
    const dir = `目录-${String(i % 20).padStart(2, '0')}`, path = `${dir}/文档-${String(i).padStart(5, '0')}.md`
    if (i < 20) await mkdir(join(a.root, dir), { recursive: true })
    await writeFile(join(a.root, path), `# 文档 ${i}\n\n${'正文内容 '.repeat(80)}\n`)
    paths.push(path)
  }
  await enableIdentity(a.root, core, workspaceId, paths)
  await phase('first_publish', a, () => a.engine.pass(signal()))
  await phase('idle_pass', a, () => a.engine.pass(signal()))
  const b = await device(workspaceId)
  await enableIdentity(b.root, core, workspaceId, [])
  await phase('fresh_restore', b, () => b.engine.pass(signal()))
  await phase('idle_pass_restored', b, () => b.engine.pass(signal()))
  await writeFile(join(a.root, paths[7]), '# 改过\n')
  await phase('one_edit_publish', a, () => a.engine.pass(signal()))
  await phase('one_edit_receive', b, () => b.engine.pass(signal()))
  await rm(b.root, { recursive: true, force: true })
} finally { await rm(a.root, { recursive: true, force: true }) }
await writeFile(`${out}/scale-${name}-${count}.json`, JSON.stringify(report, null, 2) + '\n')
console.log(`Report: ${out}/scale-${name}-${count}.json`)
