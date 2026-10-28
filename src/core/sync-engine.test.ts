import { describe, expect, it } from 'vitest'
import { defaultRecipe, type ImageInstance } from './images'
import { syncHash } from './sync-contract'
import { encodeWorkspaceIdentity, type WorkspaceIdentity } from './sync-identity'
import { MemorySyncProvider } from './sync-memory-provider'
import { SyncEngine, type EngineState, type LocalScan, type SyncHost } from './sync-engine'

const workspaceId = '1358f0a2-25b8-441b-9d55-379f6ca303dc'
const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)
const png = (n: number) => new Uint8Array([137, 80, 78, 71, n])
const signal = () => new AbortController().signal
let ids = 0
const uuid = () => `a1b2c3d4-0000-4000-8000-${String(++ids).padStart(12, '0')}`

/** A device's workspace in memory, with the same contracts as the native commands. */
class MemoryWorkspace implements SyncHost {
  files = new Map<string, Uint8Array>()
  assets = new Map<string, Uint8Array>()
  /** directory → images.json instances */
  metadata = new Map<string, ImageInstance[]>()
  identity: WorkspaceIdentity | null = { schemaVersion: 1, workspaceId, documents: [] }
  trashBin = new Map<string, { path: string; bytes: Uint8Array }>()
  tabs = new Map<string, boolean>()
  state: EngineState | null = null
  /** Throws once when the next matching host call happens (crash/interrupt simulation). */
  failOn: { method: string; path?: string } | null = null
  readonly deviceId = uuid()
  readonly workspaceId = workspaceId
  newId = uuid

  private trip(method: string, path?: string) {
    if (this.failOn && this.failOn.method === method && (!this.failOn.path || this.failOn.path === path)) { this.failOn = null; throw new Error('interrupted') }
  }
  private dir = (path: string) => path.split('/').slice(0, -1).join('/')
  private join = (dir: string, rel: string) => (dir ? `${dir}/${rel}` : rel)
  async revision(path: string) { return syncHash(this.files.get(path)!) }
  async scan(): Promise<LocalScan> {
    const documents = await Promise.all([...this.files.keys()].sort().map(async (path) => ({ path, revision: await this.revision(path), historyId: null })))
    return { identity: this.identity && structuredClone(this.identity), identityRevision: this.identity ? await syncHash(encodeWorkspaceIdentity(this.identity)) : null, documents }
  }
  async read(path: string) { const bytes = this.files.get(path)!; return { path, bytes, revision: await syncHash(bytes), instances: this.metadata.get(this.dir(path)) ?? [] } }
  async readAsset(directory: string, asset: string) { return this.assets.get(this.join(directory, asset)) ?? null }
  async open() { return { open: new Set(this.tabs.keys()), dirty: new Set([...this.tabs].filter(([, d]) => d).map(([p]) => p)) } }
  async trashed() {
    const map = new Map<string, string>()
    for (const [documentId, item] of this.trashBin) map.set(documentId, await syncHash(item.bytes))
    return map
  }
  async writeIdentity(next: WorkspaceIdentity, expected: string | null) {
    this.trip('writeIdentity')
    const current = this.identity ? await syncHash(encodeWorkspaceIdentity(this.identity)) : null
    if (current !== expected) throw new Error('revision_conflict')
    this.identity = structuredClone(next)
  }
  async write(op: Parameters<SyncHost['write']>[0]) {
    this.trip('write', op.path)
    const existing = this.files.get(op.path)
    if (op.expected === null ? existing !== undefined : !existing || (await syncHash(existing)) !== op.expected) throw new Error('revision_conflict')
    const dir = this.dir(op.path)
    for (const asset of op.assets) {
      const key = this.join(dir, asset.path), current = this.assets.get(key)
      if (current && dec(current) !== dec(asset.bytes)) throw new Error('resource_conflict')
      this.assets.set(key, asset.bytes)
    }
    const merged = (this.metadata.get(dir) ?? []).filter((i) => !op.instances.some((n) => n.displayPath === i.displayPath))
    this.metadata.set(dir, [...merged, ...op.instances])
    this.files.set(op.path, op.bytes)
  }
  async move(op: Parameters<SyncHost['move']>[0]) {
    this.trip('move', op.from)
    if (this.files.has(op.to) || (await this.revision(op.from)) !== op.expected) throw new Error('revision_conflict')
    this.files.set(op.to, this.files.get(op.from)!); this.files.delete(op.from)
    for (const ref of op.references) { const bytes = this.assets.get(this.join(this.dir(op.from), ref)); if (bytes) this.assets.set(this.join(this.dir(op.to), ref), bytes) }
    this.identity!.documents = this.identity!.documents.map((d) => (d.path === op.from ? { ...d, path: op.to } : d))
  }
  async trash(op: Parameters<SyncHost['trash']>[0]) {
    this.trip('trash', op.path)
    if ((await this.revision(op.path)) !== op.expected) throw new Error('revision_conflict')
    const doc = this.identity!.documents.find((d) => d.path === op.path)
    this.trashBin.set(doc?.documentId ?? uuid(), { path: op.path, bytes: this.files.get(op.path)! })
    this.files.delete(op.path)
    this.identity!.documents = this.identity!.documents.filter((d) => d.path !== op.path)
  }
  async loadState() { return this.state && structuredClone(this.state) }
  async saveState(state: EngineState) { this.trip('saveState'); this.state = structuredClone(state) }

  // User actions.
  edit(path: string, text: string) { this.files.set(path, enc(text)) }
  userTrash(path: string) {
    const doc = this.identity!.documents.find((d) => d.path === path)!
    this.trashBin.set(doc.documentId, { path, bytes: this.files.get(path)! })
    this.files.delete(path); this.identity!.documents = this.identity!.documents.filter((d) => d.path !== path)
  }
  addImage(dir: string, name: string, bytes: Uint8Array) {
    const displayPath = `assets/img-${name}-v1.png`, sourcePath = `assets/.originals/img-${name}-source.png`
    this.assets.set(this.join(dir, displayPath), bytes); this.assets.set(this.join(dir, sourcePath), bytes)
    const instance: ImageInstance = { instanceId: `img-${name}`, documentId: 'local-handle', sourcePath, sourceHash: 'sha256:x', displayPath, recipe: defaultRecipe(), referenceRevision: 1 }
    this.metadata.set(dir, [...(this.metadata.get(dir) ?? []), instance])
    return displayPath
  }
  text(path: string) { const b = this.files.get(path); return b && dec(b) }
  view() { return [...this.files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, b]) => `${p}=${dec(b)}`) }
}

function pair() {
  const server = new MemorySyncProvider()
  const a = new MemoryWorkspace(), b = new MemoryWorkspace()
  return { server, a, b, ea: new SyncEngine(server, a), eb: new SyncEngine(server, b) }
}
const docId = (w: MemoryWorkspace, path: string) => w.identity!.documents.find((d) => d.path === path)?.documentId

describe('single-device round trip', () => {
  it('device A uploads; a fresh device B restores bodies, images and metadata completely', async () => {
    const { a, b, ea, eb } = pair()
    a.edit('a.md', '# 甲\r\n😀')
    const img = a.addImage('notes', 'pic', png(1))
    a.edit('notes/b.md', `![图](${img})\n`)
    a.edit('empty.md', '')
    const first = await ea.pass(signal())
    expect(first.published).toBe(true)
    expect(a.identity!.documents.map((d) => d.path)).toEqual(['a.md', 'empty.md', 'notes/b.md'])

    const restored = await eb.pass(signal())
    expect(restored.downloaded).toBe(3)
    expect(b.view()).toEqual(a.view())
    expect(b.files.get('a.md')).toEqual(enc('# 甲\r\n😀'))
    expect(b.assets.get('notes/assets/img-pic-v1.png')).toEqual(png(1))
    expect(b.assets.get('notes/assets/.originals/img-pic-source.png')).toEqual(png(1))
    expect(b.metadata.get('notes')!.map((i) => [i.instanceId, i.documentId])).toEqual([['img-pic', null]])
    expect(docId(b, 'notes/b.md')).toBe(docId(a, 'notes/b.md'))
    // A second pass on either side changes nothing.
    expect((await eb.pass(signal())).published).toBe(false)
    expect((await ea.pass(signal())).published).toBe(false)
  })

  it('edits, renames and deletions travel both ways', async () => {
    const { a, b, ea, eb } = pair()
    a.edit('a.md', 'v1'); a.edit('b.md', 'B'); a.edit('c.md', 'C')
    await ea.pass(signal()); await eb.pass(signal())
    b.edit('a.md', 'v2 from B')
    await eb.pass(signal()); await ea.pass(signal())
    expect(a.text('a.md')).toBe('v2 from B')
    // Rename on A via identity (as step 2 does), delete on B.
    a.files.set('dir/b2.md', a.files.get('b.md')!); a.files.delete('b.md')
    a.identity!.documents = a.identity!.documents.map((d) => (d.path === 'b.md' ? { ...d, path: 'dir/b2.md' } : d))
    b.userTrash('c.md')
    await ea.pass(signal()); await eb.pass(signal()); await ea.pass(signal())
    expect(a.view()).toEqual(['a.md=v2 from B', 'dir/b2.md=B'])
    expect(b.view()).toEqual(a.view())
    expect(a.trashBin.size).toBe(1)
  })

  it('a missing local file is never published as a deletion', async () => {
    const { a, b, ea, eb } = pair()
    a.edit('a.md', 'A'); a.edit('b.md', 'B')
    await ea.pass(signal()); await eb.pass(signal())
    a.files.delete('b.md')
    expect((await ea.pass(signal())).published).toBe(false)
    await eb.pass(signal())
    expect(b.text('b.md')).toBe('B')
    // A gets its missing file back from the converged snapshot on a later pass.
    a.state = { ...a.state!, applied: null }
    await ea.pass(signal())
    expect(a.text('b.md')).toBe('B')
  })
})

describe('conflicts', () => {
  it('distinct documents created at the same path on both devices both survive', async () => {
    // Whichever side the merge renames, its apply moves a local file away from a path and creates
    // the other document there in the same pass.
    for (let round = 0; round < 6; round++) {
      const { a, b, ea, eb } = pair()
      a.edit('same.md', 'from A'); b.edit('same.md', 'from B')
      await ea.pass(signal())
      const report = await eb.pass(signal())
      expect(report.failed).toEqual([])
      await ea.pass(signal()); await eb.pass(signal())
      const texts = (w: MemoryWorkspace) => w.view().map((l) => l.split('=')[1]).sort()
      expect(texts(a)).toEqual(['from A', 'from B'])
      expect(a.view()).toEqual(b.view())
      expect(new Set(a.identity!.documents.map((d) => d.path)).size).toBe(2)
    }
  })

  it('concurrent edits keep both versions; neither side loses text', async () => {
    const { a, b, ea, eb } = pair()
    a.edit('n.md', 'base'); await ea.pass(signal()); await eb.pass(signal())
    a.edit('n.md', 'from A'); b.edit('n.md', 'from B')
    await ea.pass(signal()); await eb.pass(signal()); await ea.pass(signal()); await eb.pass(signal())
    const texts = (w: MemoryWorkspace) => w.view().map((l) => l.split('=')[1]).sort()
    expect(texts(a)).toEqual(['from A', 'from B'])
    expect(a.view()).toEqual(b.view())
    expect(a.files.size).toBe(2)
  })

  it('concurrent edits of different lines merge into one file on both devices, with images from both', async () => {
    const { a, b, ea, eb } = pair()
    a.edit('notes/n.md', '# 标题\n\n正文\n\n结尾\n'); await ea.pass(signal()); await eb.pass(signal())
    const imgA = a.addImage('notes', 'a', png(1)), imgB = b.addImage('notes', 'b', png(2))
    a.edit('notes/n.md', `# 新标题\n\n![甲](${imgA})\n\n正文\n\n结尾\n`); b.edit('notes/n.md', `# 标题\n\n正文\n\n结尾\n\n![乙](${imgB})\n`)
    await ea.pass(signal())
    const merged = await eb.pass(signal())
    await ea.pass(signal())
    const expected = `# 新标题\n\n![甲](${imgA})\n\n正文\n\n结尾\n\n![乙](${imgB})\n`
    expect(merged.conflicts).toMatchObject([{ reason: 'merged', path: 'notes/n.md', copy: null }])
    expect(merged.copies).toEqual([])
    for (const w of [a, b]) {
      expect(w.view()).toEqual([`notes/n.md=${expected}`])
      expect(w.assets.get(`notes/${imgA}`)).toEqual(png(1))
      expect(w.assets.get(`notes/${imgB}`)).toEqual(png(2))
      expect(w.metadata.get('notes')?.map((i) => i.displayPath).sort()).toEqual([imgA, imgB].sort())
    }
  })

  it('a line merge never overwrites an open tab with unsaved edits; the merged version lands as a copy', async () => {
    const { a, b, ea, eb } = pair()
    a.edit('n.md', 'a\nb\nc'); await ea.pass(signal()); await eb.pass(signal())
    a.edit('n.md', 'A\nb\nc'); await ea.pass(signal())
    b.edit('n.md', 'a\nb\nC'); b.tabs.set('n.md', true)
    await eb.pass(signal())
    expect(b.text('n.md')).toBe('a\nb\nC')
    expect(b.text('n (同步副本).md')).toBe('A\nb\nC')
  })

  it('a remote edit never overwrites unsaved editor changes; the remote version lands as a copy', async () => {
    const { a, b, ea, eb } = pair()
    a.edit('n.md', 'base'); await ea.pass(signal()); await eb.pass(signal())
    a.edit('n.md', 'remote edit'); await ea.pass(signal())
    b.tabs.set('n.md', true)
    const report = await eb.pass(signal())
    expect(b.text('n.md')).toBe('base')
    expect(report.copies).toEqual([{ path: 'n.md', copy: 'n (同步副本).md' }])
    expect(b.text('n (同步副本).md')).toBe('remote edit')
  })

  it('edit beats delete on either side', async () => {
    const { a, b, ea, eb } = pair()
    a.edit('n.md', 'base'); await ea.pass(signal()); await eb.pass(signal())
    a.userTrash('n.md'); b.edit('n.md', 'kept by B')
    await ea.pass(signal()); await eb.pass(signal()); await ea.pass(signal())
    expect(a.text('n.md')).toBe('kept by B')
    expect(b.text('n.md')).toBe('kept by B')
  })

  it('a remote deletion of an open document waits for the tab, then applies if unchanged', async () => {
    const { a, b, ea, eb } = pair()
    a.edit('n.md', 'base'); await ea.pass(signal()); await eb.pass(signal())
    a.userTrash('n.md'); await ea.pass(signal())
    b.tabs.set('n.md', false)
    expect((await eb.pass(signal())).deferred).toEqual(['n.md'])
    expect(b.text('n.md')).toBe('base')
    b.tabs.clear()
    await eb.pass(signal())
    expect(b.text('n.md')).toBeUndefined()
    expect(b.trashBin.size).toBe(1)
  })

  it('a user can trash an edited document and the deletion still publishes', async () => {
    const { a, b, ea, eb } = pair()
    a.edit('n.md', 'base'); await ea.pass(signal()); await eb.pass(signal())
    a.edit('n.md', 'edited then deleted'); a.userTrash('n.md')
    await ea.pass(signal()); await eb.pass(signal())
    expect(b.text('n.md')).toBeUndefined()
  })
})

describe('interruptions', () => {
  it('a crash before files are written is finished on retry without duplicates', async () => {
    const { a, b, ea, eb } = pair()
    a.edit('a.md', 'A'); a.edit('b.md', 'B'); await ea.pass(signal())
    b.failOn = { method: 'write', path: 'b.md' }
    const partial = await eb.pass(signal())
    expect(partial.failed.map((f) => f.path)).toEqual(['b.md'])
    expect(b.identity!.documents.map((d) => d.path)).toEqual(['a.md', 'b.md'])
    await eb.pass(signal())
    expect(b.view()).toEqual(['a.md=A', 'b.md=B'])
  })

  it('local edits are not published while remote changes have not reached disk', async () => {
    const { a, b, ea, eb } = pair()
    a.edit('a.md', 'v1'); await ea.pass(signal()); await eb.pass(signal())
    a.edit('a.md', 'v2'); await ea.pass(signal())
    b.failOn = { method: 'write', path: 'a.md' }
    await eb.pass(signal())
    expect(b.text('a.md')).toBe('v1')
    await eb.pass(signal())
    expect(b.text('a.md')).toBe('v2')
    expect(a.text('a.md')).toBe('v2')
  })

  it('an interrupted conflict copy is completed, not duplicated', async () => {
    const { a, b, ea, eb } = pair()
    a.edit('n.md', 'base'); await ea.pass(signal()); await eb.pass(signal())
    a.edit('n.md', 'A'); await ea.pass(signal())
    b.edit('n.md', 'B')
    b.failOn = { method: 'write', path: 'n (同步副本).md' }
    await eb.pass(signal()).catch(() => undefined)
    await eb.pass(signal()); await eb.pass(signal()); await ea.pass(signal())
    const copies = (w: MemoryWorkspace) => [...w.files.keys()].filter((p) => p.includes('同步副本'))
    expect(copies(b).length).toBeLessThanOrEqual(1)
    expect(b.view().map((l) => l.split('=')[1]).sort()).toEqual(['A', 'B'])
  })

  it('a lost head reply and a crash while saving state are both recovered', async () => {
    const { server, a, ea } = pair()
    a.edit('a.md', 'A')
    server.loseNextPublishResponse = true
    await expect(ea.pass(signal())).rejects.toThrow('unknown_outcome')
    expect((await ea.pass(signal())).published).toBe(false)
    a.edit('a.md', 'A2')
    a.failOn = { method: 'saveState' }
    await expect(ea.pass(signal())).rejects.toThrow('interrupted')
    await ea.pass(signal())
    const b = new MemoryWorkspace()
    await new SyncEngine(server, b).pass(signal())
    expect(b.text('a.md')).toBe('A2')
  })
})
