// SyncHost over a plain directory, for end-to-end checks of the real engine against real WebDAV
// servers. Mirrors the native commands' rules: complete scans, create-without-overwrite, writes
// only at the expected revision, identity writes only at the expected digest, trash instead of
// delete. It is test scaffolding, not the shipping host (that is src/platform/sync-host.ts).
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const sha = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
const IDENTITY = '.easym/sync/workspace.json'

export class FsHost {
  constructor(root, core, { workspaceId, deviceId }) {
    this.root = root; this.core = core
    this.workspaceId = workspaceId; this.deviceId = deviceId
    this.openTabs = new Set(); this.dirtyTabs = new Set(); this.trashedIds = new Map()
    /** Set to a method name to make its next call fail once (crash simulation). */
    this.failOnce = null
  }
  file(path) { return join(this.root, ...path.split('/')) }
  fail(method) { if (this.failOnce === method) { this.failOnce = null; throw Object.assign(new Error('interrupted'), { code: 'interrupted' }) } }
  async markdown(dir = '') {
    const out = []
    for (const entry of await readdir(join(this.root, dir), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'assets') continue
      const rel = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.isDirectory()) out.push(...await this.markdown(rel))
      else if (/\.(md|markdown)$/i.test(entry.name)) out.push(rel)
    }
    return out.sort()
  }
  async scan() {
    let raw = null
    try { raw = await readFile(this.file(IDENTITY)) } catch (error) { if (error.code !== 'ENOENT') throw error }
    const documents = []
    for (const path of await this.markdown()) documents.push({ path, revision: sha(await readFile(this.file(path))), historyId: null })
    return { identity: raw ? this.core.parseWorkspaceIdentity(new Uint8Array(raw)) : null, identityRevision: raw ? sha(raw) : null, documents }
  }
  async read(path) {
    const bytes = new Uint8Array(await readFile(this.file(path)))
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    let instances = []
    try { instances = JSON.parse(await readFile(join(this.root, dir, '.easym/images.json'), 'utf8')).instances } catch (error) { if (error.code !== 'ENOENT') instances = null }
    return { path, bytes, revision: sha(bytes), instances }
  }
  async readAsset(directory, asset) {
    try { return new Uint8Array(await readFile(join(this.root, directory, asset))) } catch { return null }
  }
  async open() { return { open: new Set(this.openTabs), dirty: new Set(this.dirtyTabs) } }
  async trashed() { return new Map(this.trashedIds) }
  async writeIdentity(next, expected) {
    this.fail('writeIdentity')
    let current = null
    try { current = sha(await readFile(this.file(IDENTITY))) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (current !== expected) throw Object.assign(new Error('revision_conflict'), { code: 'revision_conflict' })
    await mkdir(dirname(this.file(IDENTITY)), { recursive: true })
    await writeFile(this.file(IDENTITY), this.core.encodeWorkspaceIdentity(next))
  }
  async current(path) { try { return sha(await readFile(this.file(path))) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
  async write({ path, expected, bytes, assets, instances }) {
    this.fail('write')
    const current = await this.current(path)
    if (current !== expected) throw Object.assign(new Error('revision_conflict'), { code: 'revision_conflict' })
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    // Images are immutable: an existing file must hold the same bytes.
    for (const asset of assets) {
      const target = join(this.root, dir, asset.path)
      try { if (sha(await readFile(target)) !== sha(asset.bytes)) throw Object.assign(new Error('resource_conflict'), { code: 'resource_conflict' }); continue }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      await mkdir(dirname(target), { recursive: true }); await writeFile(target, asset.bytes)
    }
    if (instances.length) {
      const meta = join(this.root, dir, '.easym/images.json')
      let existing = []
      try { existing = JSON.parse(await readFile(meta, 'utf8')).instances } catch (error) { if (error.code !== 'ENOENT') throw error }
      const merged = [...existing.filter((i) => !instances.some((n) => n.instanceId === i.instanceId)), ...instances]
      await mkdir(dirname(meta), { recursive: true }); await writeFile(meta, JSON.stringify({ schemaVersion: 1, instances: merged }))
    }
    await mkdir(dirname(this.file(path)), { recursive: true })
    await writeFile(this.file(path), bytes, { flag: expected === null ? 'wx' : 'w' })
  }
  async move({ from, to, expected }) {
    this.fail('move')
    if (await this.current(from) !== expected) throw Object.assign(new Error('revision_conflict'), { code: 'revision_conflict' })
    if (await this.current(to) !== null) throw Object.assign(new Error('target_exists'), { code: 'target_exists' })
    await mkdir(dirname(this.file(to)), { recursive: true }); await rename(this.file(from), this.file(to))
    await this.editIdentity((docs) => docs.map((d) => (d.path === from ? { ...d, path: to } : d)))
  }
  async trash({ path, expected }) {
    this.fail('trash')
    if (await this.current(path) !== expected) throw Object.assign(new Error('revision_conflict'), { code: 'revision_conflict' })
    const scan = await this.scan()
    const entry = scan.identity?.documents.find((d) => d.path === path)
    const target = join(this.root, '.easym/trash', randomUUID())
    await mkdir(target, { recursive: true }); await rename(this.file(path), join(target, 'document.md'))
    if (entry) { this.trashedIds.set(entry.documentId, expected); await this.editIdentity((docs) => docs.filter((d) => d.path !== path)) }
  }
  async editIdentity(change) {
    const raw = await readFile(this.file(IDENTITY))
    const identity = this.core.parseWorkspaceIdentity(new Uint8Array(raw))
    await this.writeIdentity({ ...identity, documents: change(identity.documents) }, sha(raw))
  }
  /** Simulates an in-app trash on this device (the documentId leaves identity, the body is kept). */
  async userTrash(path) { await this.trash({ path, expected: await this.current(path) }) }
  async loadState() { try { return JSON.parse(await readFile(join(this.root, '.state.json'), 'utf8')) } catch { return null } }
  async saveState(state) { this.fail('saveState'); await writeFile(join(this.root, '.state.json'), JSON.stringify(state)) }
  newId() { return randomUUID() }
}

/** Creates an identity file for every Markdown file in `root` (what "enable identity" does). */
export async function enableIdentity(root, core, workspaceId, paths) {
  const identity = { schemaVersion: 1, workspaceId, documents: paths.map((path) => ({ documentId: randomUUID(), path })).sort((a, b) => (a.path < b.path ? -1 : 1)) }
  await mkdir(join(root, '.easym/sync'), { recursive: true })
  await writeFile(join(root, IDENTITY), core.encodeWorkspaceIdentity(identity))
  return identity
}
export const fileSha = async (path) => sha(await readFile(path))
export const exists = async (path) => stat(path).then(() => true, () => false)
