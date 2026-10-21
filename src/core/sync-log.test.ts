import { describe, expect, it } from 'vitest'
import { readSyncCommit, type SyncCommit, type SyncDocumentEntry, type SyncUpload } from './sync-commit'
import { encodeSyncDeviceHead, syncHash } from './sync-contract'
import { initialDeviceState, runSyncPass, type SyncDeviceState } from './sync-log'
import { MemorySyncProvider } from './sync-memory-provider'

const workspaceId = '1358f0a2-25b8-441b-9d55-379f6ca303dc'
const uuid = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`
const signal = () => new AbortController().signal

/** A simulated device: local snapshot (path + text per documentId) and persisted sync state. */
class Device {
  state: SyncDeviceState
  docs = new Map<string, { path: string; text: string }>()
  tombs = new Map<string, { path: string; operationId: string }>()
  persisted: SyncDeviceState[] = []
  private ops = 0
  constructor(readonly provider: MemorySyncProvider, readonly n: number) { this.state = initialDeviceState(workspaceId, uuid('d0d0d0d0', n)) }
  edit(id: string, path: string, text: string) { this.docs.set(id, { path, text }); this.tombs.delete(id) }
  remove(id: string) { const doc = this.docs.get(id); if (!doc) return; this.docs.delete(id); this.tombs.set(id, { path: doc.path, operationId: uuid(`0e0e${String(this.n).padStart(4, '0')}`, ++this.ops) }) }

  /** Builds a commit from the local snapshot if it differs from the last converged one. */
  private async change(): Promise<{ commit: SyncCommit; uploads: SyncUpload[] } | undefined> {
    const uploads: SyncUpload[] = [], documents: SyncDocumentEntry[] = []
    for (const [documentId, doc] of [...this.docs].sort()) {
      const bytes = new TextEncoder().encode(doc.text), hash = await syncHash(bytes)
      uploads.push({ hash, bytes })
      documents.push({ documentId, path: doc.path, text: { object: hash, bytes: bytes.byteLength }, imageMetadata: null, resources: [] })
    }
    const tombstones = [...this.tombs].sort().map(([documentId, t]) => ({ documentId, ...t }))
    const commit: SyncCommit = { schemaVersion: 1, workspaceId, operationId: uuid(`0c0c${String(this.n).padStart(4, '0')}`, ++this.ops), deviceId: this.state.deviceId, parents: this.state.commitHash ? [this.state.commitHash] : [], documents, tombstones }
    if (this.state.commitHash) {
      const base = await readSyncCommit(this.provider, workspaceId, this.state.commitHash, signal())
      const view = (c: Pick<SyncCommit, 'documents' | 'tombstones'>) => JSON.stringify([c.documents.map((d) => [d.documentId, d.path, d.text.object]).sort(), c.tombstones.map((t) => [t.documentId, t.path, t.operationId]).sort()])
      if (view(base) === view(commit)) return undefined
    } else if (!documents.length && !tombstones.length) return undefined
    return { commit, uploads }
  }

  async sync() {
    const result = await runSyncPass(this.provider, this.state, { change: await this.change(), persist: async (s) => { this.persisted.push(s) } }, signal())
    this.state = result.state
    if (result.commitHash) await this.load(result.commitHash)
    return result
  }

  /** Applies the converged snapshot locally (step 3 will do this through the native layer). */
  async load(hash: string) {
    const commit = await readSyncCommit(this.provider, workspaceId, hash, signal())
    this.docs.clear(); this.tombs.clear()
    for (const d of commit.documents) {
      const bytes = await this.provider.readObject(workspaceId, d.text.object, signal())
      this.docs.set(d.documentId, { path: d.path, text: new TextDecoder().decode(bytes as Uint8Array) })
    }
    for (const t of commit.tombstones) this.tombs.set(t.documentId, { path: t.path, operationId: t.operationId })
  }
  view() { return [...this.docs].sort().map(([id, d]) => `${id} ${d.path} ${d.text}`) }
  texts() { return [...this.docs.values()].map((d) => d.text).sort() }
}

const docId = (n: number) => uuid('a1b2c3d4', n)
async function devices(count: number, provider = new MemorySyncProvider()) {
  return { provider, list: Array.from({ length: count }, (_, i) => new Device(provider, i + 1)) }
}
async function settle(list: Device[], rounds = 3) { for (let i = 0; i < rounds; i++) for (const d of list) await d.sync() }
describe('per-device log convergence', () => {
  it('propagates an edit from A to B and back without merge commits', async () => {
    const { list: [a, b] } = await devices(2)
    a.edit(docId(1), '笔记/一.md', '# A\r\n😀')
    await a.sync(); await b.sync()
    expect(b.view()).toEqual(a.view())
    b.edit(docId(1), '笔记/一.md', '# A\r\n😀 B')
    await b.sync(); await a.sync()
    expect(a.view()).toEqual(b.view())
    expect(a.state.commitHash).toBe(b.state.commitHash)
  })

  it('merges concurrent edits of different documents cleanly', async () => {
    const { list: [a, b] } = await devices(2)
    a.edit(docId(1), 'a.md', 'one'); await a.sync(); await b.sync()
    a.edit(docId(1), 'a.md', 'one A'); b.edit(docId(2), 'b.md', 'two B')
    await a.sync(); const result = await b.sync(); await a.sync()
    expect(result.conflicts).toEqual([])
    expect(a.view()).toEqual(b.view())
    expect(a.texts()).toEqual(['one A', 'two B'])
  })

  it('keeps both versions of a concurrently edited document', async () => {
    const { list: [a, b] } = await devices(2)
    a.edit(docId(1), 'a.md', 'base'); await a.sync(); await b.sync()
    a.edit(docId(1), 'a.md', 'from A'); b.edit(docId(1), 'a.md', 'from B')
    await a.sync(); const merged = await b.sync(); await a.sync()
    expect(merged.conflicts).toMatchObject([{ reason: 'both_changed', path: 'a.md' }])
    expect(a.texts()).toEqual(['from A', 'from B'])
    expect(a.view()).toEqual(b.view())
    expect([...a.docs.values()].some((d) => /^a \(冲突 [0-9a-f]{8}\)\.md$/.test(d.path))).toBe(true)
  })

  it('merges a rename on one device with an edit on the other', async () => {
    const { list: [a, b] } = await devices(2)
    a.edit(docId(1), 'old.md', 'v1'); await a.sync(); await b.sync()
    a.edit(docId(1), 'dir/new.md', 'v1'); b.edit(docId(1), 'old.md', 'v2')
    await a.sync(); const merged = await b.sync(); await a.sync()
    expect(merged.conflicts).toEqual([])
    expect(a.view()).toEqual([`${docId(1)} dir/new.md v2`])
    expect(b.view()).toEqual(a.view())
  })

  it('keeps an edit that races a delete, and applies an uncontested delete', async () => {
    const { list: [a, b] } = await devices(2)
    a.edit(docId(1), 'keep.md', 'v1'); a.edit(docId(2), 'gone.md', 'v1'); await a.sync(); await b.sync()
    a.remove(docId(1)); b.edit(docId(1), 'keep.md', 'v2'); a.remove(docId(2))
    await a.sync(); const merged = await b.sync(); await a.sync()
    expect(merged.conflicts).toMatchObject([{ reason: 'edit_vs_delete', documentId: docId(1) }])
    expect(a.view()).toEqual([`${docId(1)} keep.md v2`])
    expect(a.tombs.has(docId(2))).toBe(true)
    expect(b.view()).toEqual(a.view())
  })

  it('renames distinct documents created at the same path (case-insensitively)', async () => {
    const { list: [a, b] } = await devices(2)
    a.edit(docId(1), 'Readme.md', 'A'); b.edit(docId(2), 'README.md', 'B')
    await a.sync(); const merged = await b.sync(); await a.sync()
    expect(merged.conflicts).toMatchObject([{ reason: 'path_collision', documentId: docId(2) }])
    expect(a.texts()).toEqual(['A', 'B'])
    expect(new Set([...a.docs.values()].map((d) => d.path.toLowerCase())).size).toBe(2)
  })

  it('converges four devices that all edit concurrently, regardless of merge order', async () => {
    for (const order of [[0, 1, 2, 3], [3, 1, 0, 2]]) {
      const { list } = await devices(4)
      list[0].edit(docId(1), 'shared.md', 'base'); await settle(list, 1)
      list.forEach((d, i) => { d.edit(docId(1), 'shared.md', `edit ${i}`); d.edit(docId(10 + i), `own-${i}.md`, `own ${i}`) })
      for (let round = 0; round < 3; round++) for (const i of order) await list[i].sync()
      const views = list.map((d) => JSON.stringify(d.view()))
      expect(new Set(views).size).toBe(1)
      expect(new Set(list.map((d) => d.state.commitHash)).size).toBe(1)
      expect(list[0].texts().filter((t) => t.startsWith('edit'))).toEqual(['edit 0', 'edit 1', 'edit 2', 'edit 3'])
      expect(list[0].texts().filter((t) => t.startsWith('own'))).toHaveLength(4)
    }
  })

  it('produces byte-identical merges on different devices', async () => {
    const { provider, list: [a, b, c] } = await devices(3)
    a.edit(docId(1), 'a.md', 'A'); b.edit(docId(2), 'b.md', 'B')
    await a.sync(); await b.sync()
    // C has no local change; it merges the same two tips B already merged.
    const before = provider.objects.size
    await c.sync()
    expect(c.state.commitHash).toBe(b.state.commitHash)
    expect(provider.objects.size).toBe(before)
  })

  it('stays correct when the server acknowledges every conditional write (Apache behaviour)', async () => {
    const provider = new MemorySyncProvider(); provider.nonAtomic = true
    const { list } = await devices(3, provider)
    await Promise.all(list.map((d, i) => { d.edit(docId(i + 1), `${i}.md`, `v${i}`); return d.sync() }))
    await settle(list)
    expect(new Set(list.map((d) => JSON.stringify(d.view()))).size).toBe(1)
    expect(list[0].texts()).toEqual(['v0', 'v1', 'v2'])
  })
})
describe('per-device log faults', () => {
  const key = (d: Device) => `${workspaceId}/devices/${d.state.deviceId}`

  it('persists the pending head before the request and settles a lost reply on the next pass', async () => {
    const { provider, list: [a, b] } = await devices(2)
    a.edit(docId(1), 'a.md', 'v1')
    provider.loseNextPublishResponse = true
    await expect(a.sync()).rejects.toThrow('unknown_outcome')
    // The crash-safe record was written before the head request.
    expect(a.persisted.at(-1)?.pending?.sequence).toBe(1)
    a.state = a.persisted.at(-1) as SyncDeviceState
    // The retried change was built on the pre-settle head, so it is merged with the settled one.
    const retry = await a.sync()
    expect(retry.state.pending).toBeUndefined()
    expect(retry.state.sequence).toBeGreaterThanOrEqual(1)
    expect(a.view()).toEqual([`${docId(1)} a.md v1`])
    await b.sync()
    expect(b.view()).toEqual(a.view())
  })

  it('discards a pending write that never reached the server and republishes', async () => {
    const { provider, list: [a] } = await devices(1)
    a.edit(docId(1), 'a.md', 'v1'); await a.sync()
    a.edit(docId(1), 'a.md', 'v2')
    provider.loseNextPublishResponse = true
    await expect(a.sync()).rejects.toThrow('unknown_outcome')
    const stale = a.persisted.at(-1) as SyncDeviceState
    // Simulate the request never landing: restore the previous head bytes.
    const head = { schemaVersion: 1 as const, workspaceId, deviceId: a.state.deviceId, sequence: 1, commitHash: a.state.commitHash as string }
    provider.heads.set(key(a), { bytes: encodeSyncDeviceHead(head), revision: '"restored"' })
    a.state = stale
    const result = await a.sync()
    expect(result.published).toBe(true)
    expect(result.state.sequence).toBe(2)
  })

  it('stops when another installation writes under the same device id', async () => {
    const { provider, list: [a] } = await devices(1)
    a.edit(docId(1), 'a.md', 'v1'); await a.sync()
    const clone = new Device(provider, 1)
    clone.edit(docId(2), 'b.md', 'clone')
    await expect(clone.sync()).rejects.toThrow('device_conflict')
    const head = { schemaVersion: 1 as const, workspaceId, deviceId: a.state.deviceId, sequence: 2, commitHash: a.state.commitHash as string }
    provider.heads.set(key(a), { bytes: encodeSyncDeviceHead(head), revision: '"foreign"' })
    await expect(a.sync()).rejects.toThrow('device_conflict')
  })

  it('detects a rolled-back or removed remote head instead of resurrecting old state', async () => {
    const { provider, list: [a, b] } = await devices(2)
    a.edit(docId(1), 'a.md', 'v1'); await a.sync(); await b.sync()
    a.edit(docId(1), 'a.md', 'v2'); await a.sync(); await b.sync()
    const old = { schemaVersion: 1 as const, workspaceId, deviceId: a.state.deviceId, sequence: 1, commitHash: (await readSyncCommit(provider, workspaceId, a.state.commitHash as string, signal())).parents[0] }
    const saved = provider.heads.get(key(a))
    provider.heads.set(key(a), { bytes: encodeSyncDeviceHead(old), revision: '"old"' })
    await expect(b.sync()).rejects.toThrow('rollback')
    provider.heads.delete(key(a))
    await expect(b.sync()).rejects.toThrow('rollback')
    provider.heads.set(key(a), saved as { bytes: Uint8Array; revision: string })
    await expect(b.sync()).resolves.toBeTruthy()
  })

  it('never advances the head when an object upload fails, and recovers on retry', async () => {
    const { provider, list: [a, b] } = await devices(2)
    a.edit(docId(1), 'a.md', 'v1')
    provider.failNextObject = true
    await expect(a.sync()).rejects.toThrow('transport_failed')
    expect(provider.heads.size).toBe(0)
    await a.sync(); await b.sync()
    expect(b.view()).toEqual(a.view())
  })

  it('refuses a head that points at a missing or tampered commit', async () => {
    const { provider, list: [a, b] } = await devices(2)
    a.edit(docId(1), 'a.md', 'v1'); await a.sync()
    provider.objects.set(`${workspaceId}/${a.state.commitHash}`, new TextEncoder().encode('{}'))
    await expect(b.sync()).rejects.toThrow('hash_mismatch')
    provider.objects.delete(`${workspaceId}/${a.state.commitHash}`)
    await expect(b.sync()).rejects.toThrow('missing_object')
  })
})
