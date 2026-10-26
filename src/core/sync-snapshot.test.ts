import { describe, expect, it } from 'vitest'
import { defaultRecipe, type ImageInstance } from './images'
import type { SyncCommit, SyncDocumentEntry } from './sync-commit'
import { syncHash } from './sync-contract'
import type { WorkspaceIdentity } from './sync-identity'
import { buildEntry, canonicalJson, documentMetadata, localChange, managedReferences, planApply, previewJoin, type LocalDocument } from './sync-snapshot'

const workspaceId = '1358f0a2-25b8-441b-9d55-379f6ca303dc'
const deviceId = '6f0c1c55-3c9e-4f53-9c9b-0b8f4d9f6a01'
const id = (n: number) => `a1b2c3d4-0000-4000-8000-${String(n).padStart(12, '0')}`
const op = (n: number) => `0b0b0b0b-0000-4000-8000-${String(n).padStart(12, '0')}`
const enc = (s: string) => new TextEncoder().encode(s)
const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3])
const instance = (n: string): ImageInstance => ({ instanceId: `img-${n}`, documentId: 'process-local', sourcePath: `assets/.originals/img-${n}-source.png`, sourceHash: 'sha256:x', displayPath: `assets/img-${n}-v1.png`, recipe: defaultRecipe(), referenceRevision: 1 })
const identity = (docs: [number, string][]): WorkspaceIdentity => ({ schemaVersion: 1, workspaceId, documents: docs.map(([n, path]) => ({ documentId: id(n), path })) })
const doc = (path: string, text: string, instances: ImageInstance[] | null = []): LocalDocument => ({ path, bytes: enc(text), instances })
const assets = async (_dir: string, path: string) => (path.includes('missing') ? null : png)
let counter = 100
const copyId = (documentId: string, object: string) => `c0c0c0c0-0000-4000-8000-${(documentId.slice(-4) + object.slice(7, 15)).padStart(12, '0').slice(-12)}`

async function change(docs: LocalDocument[], ident: WorkspaceIdentity, base: SyncCommit | null = null, deleted: [string, string][] = []) {
  return localChange({ workspaceId, deviceId, operationId: op(counter++), identity: ident, base, baseHash: base ? `sha256:${'b'.repeat(64)}` : null, disk: new Map(docs.map((d) => [d.path, d])), deleted: new Map(deleted), readAsset: assets })
}

describe('local snapshot', () => {
  it('collects managed image references, ignoring code, external and unmanaged links', () => {
    const text = '![a](assets/img-a-v1.png) ![b](./assets/img-b-v1.png?x#y) ![c](photo.png) ![d](https://x.test/assets/img-d-v1.png)\n\n```\n![e](assets/img-e-v1.png)\n```\n'
    expect(managedReferences(enc(text))).toEqual(['assets/img-a-v1.png', 'assets/img-b-v1.png'])
    expect(managedReferences(new Uint8Array([0xff, 0xfe]))).toEqual([])
  })

  it('keeps only referenced instances in deterministic, process-independent metadata', () => {
    const a = documentMetadata([instance('b'), instance('a'), instance('z')], ['assets/img-a-v1.png', 'assets/img-b-v1.png'])!
    const b = documentMetadata([instance('a'), instance('b')], ['assets/img-b-v1.png', 'assets/img-a-v1.png'])!
    expect(new TextDecoder().decode(a)).toBe(new TextDecoder().decode(b))
    expect(JSON.parse(new TextDecoder().decode(a)).instances.map((i: ImageInstance) => [i.instanceId, i.documentId])).toEqual([['img-a', null], ['img-b', null]])
    expect(documentMetadata([instance('a')], [])).toBeNull()
    expect(documentMetadata(null, ['assets/img-a-v1.png'])).toBeNull()
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}')
  })

  it('builds entries with body, metadata, display and source images', async () => {
    const built = await buildEntry(id(1), doc('notes/a.md', '![a](assets/img-a-v1.png)', [instance('a')]), (path) => assets('notes', path))
    expect(built.entry.resources.map((r) => r.path)).toEqual(['assets/.originals/img-a-source.png', 'assets/img-a-v1.png'])
    expect(built.entry.text.object).toBe(await syncHash(enc('![a](assets/img-a-v1.png)')))
    expect(built.entry.imageMetadata).not.toBeNull()
    expect(built.missingAssets).toEqual([])
    const missing = await buildEntry(id(1), doc('a.md', '![m](assets/img-missing-v1.png)'), (path) => assets('', path))
    expect(missing.missingAssets).toEqual(['assets/img-missing-v1.png'])
  })

  it('publishes nothing when unchanged and carries forward missing files instead of deleting them', async () => {
    const ident = identity([[1, 'a.md'], [2, 'b.md']])
    const first = await change([doc('a.md', 'A'), doc('b.md', 'B')], ident)
    expect(first.commit!.documents.map((d) => d.path)).toEqual(['a.md', 'b.md'])
    expect(first.commit!.parents).toEqual([])
    expect((await change([doc('a.md', 'A'), doc('b.md', 'B')], ident, first.commit)).commit).toBeNull()
    const missing = await change([doc('a.md', 'A')], ident, first.commit)
    expect(missing.commit).toBeNull()
    expect(missing.carried).toEqual(['b.md'])
    const edited = await change([doc('a.md', 'A2'), doc('b.md', 'B')], ident, first.commit)
    expect(edited.commit!.parents).toEqual([`sha256:${'b'.repeat(64)}`])
    expect(edited.uploads.length).toBe(1)
  })

  it('turns only explicitly confirmed deletions into tombstones', async () => {
    const ident = identity([[1, 'a.md'], [2, 'b.md']])
    const base = (await change([doc('a.md', 'A'), doc('b.md', 'B')], ident)).commit!
    const deleted = await change([doc('a.md', 'A')], identity([[1, 'a.md']]), base, [[id(2), base.documents[1].text.object]])
    expect(deleted.commit!.documents.map((d) => d.path)).toEqual(['a.md'])
    expect(deleted.commit!.tombstones.map((t) => [t.documentId, t.path])).toEqual([[id(2), 'b.md']])
    // Untracked by identity but not confirmed: kept as it was.
    expect((await change([doc('a.md', 'A')], identity([[1, 'a.md']]), base)).commit).toBeNull()
  })

  it('does not publish documents whose referenced images are missing', async () => {
    const result = await change([doc('a.md', '![m](assets/img-missing-v1.png)'), doc('b.md', 'B')], identity([[1, 'a.md'], [2, 'b.md']]))
    expect(result.commit!.documents.map((d) => d.path)).toEqual(['b.md'])
    expect(result.skipped).toEqual([{ path: 'a.md', reason: 'missing_assets' }])
  })
})

function entry(n: number, path: string, text: string): SyncDocumentEntry {
  return { documentId: id(n), path, text: { object: `sha256:${text.padEnd(64, '0')}`, bytes: 1 }, imageMetadata: null, resources: [] }
}
const commit = (documents: SyncDocumentEntry[], tombstones: SyncCommit['tombstones'] = []): SyncCommit => ({ schemaVersion: 1, workspaceId, operationId: op(1), deviceId, parents: [], documents, tombstones })
const rev = (text: string) => `sha256:${text.padEnd(64, '0')}`

describe('apply plan', () => {
  it('creates new documents and overwrites only files still at their base revision', () => {
    const base = commit([entry(1, 'a.md', 'a1'), entry(2, 'b.md', 'b1')])
    const target = commit([entry(1, 'a.md', 'a2'), entry(2, 'b.md', 'b2'), entry(3, 'c.md', 'c1')])
    const plan = planApply({ target, base, identity: identity([[1, 'a.md'], [2, 'b.md']]), disk: new Map([['a.md', rev('a1')], ['b.md', rev('bx')]]), dirty: new Set(), deleted: new Map(), copyId })
    expect(plan.ops.map((o) => [o.kind, 'path' in o ? o.path : o.to, 'expected' in o ? o.expected : null])).toEqual([
      ['write', 'a.md', rev('a1')], ['write', 'b (同步副本).md', null], ['write', 'c.md', null],
    ])
    expect(plan.conflicts).toEqual([{ documentId: id(2), path: 'b.md', copy: 'b (同步副本).md' }])
    const copy = plan.ops[1] as Extract<typeof plan.ops[number], { kind: 'write' }>
    expect(copy.copy).toBe(true); expect(copy.entry.documentId).not.toBe(id(2))
  })

  it('treats open documents with unsaved edits as locally changed', () => {
    const base = commit([entry(1, 'a.md', 'a1')])
    const plan = planApply({ target: commit([entry(1, 'a.md', 'a2')]), base, identity: identity([[1, 'a.md']]), disk: new Map([['a.md', rev('a1')]]), dirty: new Set(['a.md']), deleted: new Map(), copyId })
    expect(plan.conflicts.map((c) => c.copy)).toEqual(['a (同步副本).md'])
  })

  it('applies remote deletions only to unchanged files and moves renamed ones', () => {
    const base = commit([entry(1, 'a.md', 'a1'), entry(2, 'b.md', 'b1'), entry(3, 'old/c.md', 'c1')])
    const target = commit([entry(3, 'new/c.md', 'c1')], [{ documentId: id(1), path: 'a.md', operationId: op(9) }, { documentId: id(2), path: 'b.md', operationId: op(9) }])
    const plan = planApply({ target, base, identity: identity([[1, 'a.md'], [2, 'b.md'], [3, 'old/c.md']]), disk: new Map([['a.md', rev('a1')], ['b.md', rev('b2')], ['old/c.md', rev('c1')]]), dirty: new Set(), deleted: new Map(), copyId })
    expect(plan.ops.map((o) => o.kind)).toEqual(['trash', 'move'])
    expect(plan.ops[0]).toMatchObject({ path: 'a.md', expected: rev('a1') })
    expect(plan.ops[1]).toMatchObject({ from: 'old/c.md', to: 'new/c.md' })
    expect(plan.keptDeletes).toEqual(['b.md'])
  })

  it('recreates tracked documents that are missing locally and never overwrites untracked files', () => {
    const base = commit([entry(1, 'a.md', 'a1')])
    const plan = planApply({ target: commit([entry(1, 'a.md', 'a1'), entry(2, 'x.md', 'x1')]), base: null, identity: identity([[1, 'a.md']]), disk: new Map([['x.md', rev('zz')]]), dirty: new Set(), deleted: new Map(), copyId })
    expect(plan.ops.map((o) => 'path' in o && o.path)).toEqual(['a.md', 'x (同步副本).md'])
    expect(planApply({ target: base, base, identity: identity([[1, 'a.md']]), disk: new Map([['a.md', rev('a1')]]), dirty: new Set(), deleted: new Map(), copyId }).ops).toEqual([])
  })

  it('previews a join: downloads, uploads and same-path collisions', () => {
    const preview = previewJoin([commit([entry(1, 'a.md', 'a'), entry(2, 'Shared.md', 's')])], identity([[3, 'shared.md'], [4, 'mine.md'], [1, 'a.md']]))
    expect(preview).toEqual({ download: 1, upload: 2, collisions: ['Shared.md'] })
  })

  it('keeps a confirmed deletion only while the remote version is the one deleted', async () => {
    const ident = identity([[1, 'a.md'], [2, 'b.md']])
    const base = (await change([doc('a.md', 'A'), doc('b.md', 'B')], ident)).commit!
    const stale = await change([doc('a.md', 'A')], identity([[1, 'a.md']]), base, [[id(2), rev('other')]])
    expect(stale.commit).toBeNull()
  })

  it('does not recreate a pending local deletion, but restores it after a newer remote edit', () => {
    const target = commit([entry(1, 'a.md', 'a1'), entry(2, 'b.md', 'b1')])
    const pending = planApply({ target, base: target, identity: identity([[1, 'a.md']]), disk: new Map([['a.md', rev('a1')]]), dirty: new Set(), deleted: new Map([[id(2), rev('b1')]]), copyId })
    expect(pending.ops).toEqual([])
    const edited = planApply({ target: commit([entry(1, 'a.md', 'a1'), entry(2, 'b.md', 'b2')]), base: target, identity: identity([[1, 'a.md']]), disk: new Map([['a.md', rev('a1')]]), dirty: new Set(), deleted: new Map([[id(2), rev('b1')]]), copyId })
    expect(edited.ops.map((o) => 'path' in o && o.path)).toEqual(['b.md'])
    expect(edited.restored).toEqual(['b.md'])
  })
})
