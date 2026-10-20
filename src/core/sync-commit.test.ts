import { describe, expect, it } from 'vitest'
import { encodeSyncCommit, isPortableSyncPath, parseSyncCommit, publishSyncCommit, readSyncCommit, resolveSyncPublication, SyncCommitError, type SyncCommit } from './sync-commit'
import { syncHash } from './sync-contract'
import { MemorySyncProvider } from './sync-memory-provider'

const workspaceId = '1358f0a2-25b8-441b-9d55-379f6ca303dc'
const deviceA = '6f0c1c55-3c9e-4f53-9c9b-0b8f4d9f6a01'
const deviceB = '6f0c1c55-3c9e-4f53-9c9b-0b8f4d9f6a02'
const documentId = 'a1b2c3d4-0000-4000-8000-000000000001'
const op = (n: number) => `0b0b0b0b-0000-4000-8000-${String(n).padStart(12, '0')}`
const encode = (value: unknown) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))
const signal = () => new AbortController().signal

async function text(content: string) {
  const bytes = encode(content)
  return { bytes, hash: await syncHash(bytes) }
}
async function commitFor(content: string, operationId: string, parents: string[] = [], deviceId = deviceA) {
  const body = await text(content)
  const commit: SyncCommit = {
    schemaVersion: 1, workspaceId, operationId, deviceId, parents,
    documents: [{ documentId, path: '笔记/第一篇.md', text: { object: body.hash, bytes: body.bytes.byteLength }, imageMetadata: null, resources: [] }],
    tombstones: [],
  }
  return { commit, uploads: [body] }
}
const parse = (value: unknown) => parseSyncCommit(encode(value), workspaceId)
const code = (fn: () => unknown) => { try { fn(); return 'none' } catch (error) { return error instanceof SyncCommitError ? error.code : String(error) } }

describe('sync commit manifest', () => {
  it('round-trips deterministically regardless of entry order', async () => {
    const { commit } = await commitFor('# 你好 😀\r\n', op(1))
    const second = { ...commit.documents[0], documentId: 'a1b2c3d4-0000-4000-8000-000000000002', path: 'a.md' }
    const one = encodeSyncCommit({ ...commit, documents: [commit.documents[0], second] })
    const two = encodeSyncCommit({ ...commit, documents: [second, commit.documents[0]] })
    expect(one).toEqual(two)
    expect(parseSyncCommit(one, workspaceId).documents.map((d) => d.path)).toEqual(['a.md', '笔记/第一篇.md'])
  })

  it('rejects unknown schema, other workspaces and extra fields', async () => {
    const { commit } = await commitFor('x', op(1))
    expect(code(() => parse({ ...commit, schemaVersion: 2 }))).toBe('unsupported_schema')
    expect(code(() => parse({ ...commit, workspaceId: deviceA }))).toBe('workspace_mismatch')
    expect(code(() => parse({ ...commit, endpoint: 'https://example.test' }))).toBe('invalid_commit')
    expect(code(() => parse({ ...commit, documents: [{ ...commit.documents[0], absolutePath: 'C:/x.md' }] }))).toBe('invalid_commit')
    expect(code(() => parse({ ...commit, parents: [commit.documents[0].text.object, commit.documents[0].text.object] }))).toBe('invalid_commit')
  })

  it('rejects traversal, absolute, Windows-reserved and non-NFC paths', () => {
    for (const path of ['../a.md', '/a.md', 'C:/a.md', 'a\\b.md', 'con.md', 'dir/aux', 'a./b.md', 'a /b.md', 'x\u0000.md', 'e\u0301.md', '', 'a//b.md']) {
      expect(isPortableSyncPath(path)).toBe(false)
    }
    for (const path of ['笔记/第一篇.md', 'é.md', 'a b/c-d_e.md', 'console.md']) expect(isPortableSyncPath(path)).toBe(true)
  })

  it('rejects case-folded path collisions and duplicate identities', async () => {
    const { commit } = await commitFor('x', op(1))
    const other = { ...commit.documents[0], documentId: 'a1b2c3d4-0000-4000-8000-000000000003' }
    expect(code(() => parse({ ...commit, documents: [{ ...other, path: 'Readme.md' }, { ...commit.documents[0], path: 'README.md' }] }))).toBe('path_conflict')
    expect(code(() => parse({ ...commit, documents: [commit.documents[0], { ...commit.documents[0], path: 'b.md' }] }))).toBe('duplicate_identity')
    expect(code(() => parse({ ...commit, tombstones: [{ documentId, path: 'old.md', operationId: op(9) }] }))).toBe('duplicate_identity')
  })

  it('bounds resource paths and sizes to the 1.0 image contract', async () => {
    const { commit } = await commitFor('x', op(1))
    const resource = { path: 'assets/img-1.png', object: commit.documents[0].text.object, bytes: 1 }
    expect(parse({ ...commit, documents: [{ ...commit.documents[0], resources: [resource] }] }).documents[0].resources).toHaveLength(1)
    for (const bad of [{ ...resource, path: '../secret.png' }, { ...resource, path: 'assets/img-1.svg' }, { ...resource, bytes: 20 * 1024 * 1024 + 1 }, { ...resource, bytes: -1 }]) {
      expect(code(() => parse({ ...commit, documents: [{ ...commit.documents[0], resources: [bad] }] }))).toBe('invalid_commit')
    }
  })

  it('verifies commit bytes against the content address', async () => {
    const provider = new MemorySyncProvider(), { commit } = await commitFor('x', op(1))
    const bytes = encodeSyncCommit(commit), hash = await syncHash(bytes)
    provider.objects.set(`${workspaceId}/${hash}`, encode({ ...commit, operationId: op(2) }))
    await expect(readSyncCommit(provider, workspaceId, hash, signal())).rejects.toThrow('hash_mismatch')
    await expect(readSyncCommit(provider, workspaceId, `sha256:${'0'.repeat(64)}`, signal())).rejects.toThrow('missing_object')
  })
})
describe('conditional publication against a fault-injecting provider', () => {
  it('uploads objects before the commit and moves the head last', async () => {
    const provider = new MemorySyncProvider(), { commit, uploads } = await commitFor('x', op(1))
    const { result } = await publishSyncCommit(provider, commit, uploads, new Set(), { kind: 'absent' }, signal())
    expect(result.kind).toBe('committed')
    expect(provider.requests).toEqual(['createObject', 'createObject', 'publishHead'])
  })

  it('never moves the head when an object upload fails', async () => {
    const provider = new MemorySyncProvider(), { commit, uploads } = await commitFor('x', op(1))
    provider.failNextObject = true
    await expect(publishSyncCommit(provider, commit, uploads, new Set(), { kind: 'absent' }, signal())).rejects.toThrow('transport_failed')
    expect(provider.head).toBeNull()
  })

  it('refuses to publish a commit that references objects neither uploaded nor known remote', async () => {
    const provider = new MemorySyncProvider(), { commit } = await commitFor('x', op(1))
    await expect(publishSyncCommit(provider, commit, [], new Set(), { kind: 'absent' }, signal())).rejects.toThrow('missing_object')
    expect(provider.requests).toEqual([])
  })

  it('rejects upload bytes that do not match their hash', async () => {
    const provider = new MemorySyncProvider(), { commit, uploads } = await commitFor('x', op(1))
    await expect(publishSyncCommit(provider, commit, [{ ...uploads[0], bytes: encode('y') }], new Set(), { kind: 'absent' }, signal())).rejects.toThrow('hash_mismatch')
  })

  it('lets exactly one of two racing first commits win and keeps both object sets', async () => {
    const provider = new MemorySyncProvider()
    const a = await commitFor('A', op(1), [], deviceA), b = await commitFor('B', op(2), [], deviceB)
    const results = await Promise.all([a, b].map((x) => publishSyncCommit(provider, x.commit, x.uploads, new Set(), { kind: 'absent' }, signal())))
    expect(results.map((r) => r.result.kind).sort()).toEqual(['committed', 'conflict'])
    for (const r of results) expect(provider.objects.has(`${workspaceId}/${r.commitHash}`)).toBe(true)
  })

  it('rejects a stale revision instead of overwriting a newer head', async () => {
    const provider = new MemorySyncProvider(), first = await commitFor('1', op(1))
    const base = await publishSyncCommit(provider, first.commit, first.uploads, new Set(), { kind: 'absent' }, signal())
    if (base.result.kind !== 'committed') throw new Error('setup')
    const expected = { kind: 'match' as const, revision: base.result.value.revision }
    const a = await commitFor('A', op(2), [base.commitHash]), b = await commitFor('B', op(3), [base.commitHash], deviceB)
    expect((await publishSyncCommit(provider, a.commit, a.uploads, new Set(), expected, signal())).result.kind).toBe('committed')
    expect((await publishSyncCommit(provider, b.commit, b.uploads, new Set(), expected, signal())).result.kind).toBe('conflict')
    expect((await provider.readHead(workspaceId, signal()))?.head.commitHash).not.toBe(base.commitHash)
  })

  it('resolves a lost response as committed, then superseded after another device builds on it', async () => {
    const provider = new MemorySyncProvider(), first = await commitFor('1', op(1))
    provider.loseNextPublishResponse = true
    const lost = await publishSyncCommit(provider, first.commit, first.uploads, new Set(), { kind: 'absent' }, signal())
    expect(lost.result.kind).toBe('unknown')
    const publication = { operationId: op(1), commitHash: lost.commitHash }
    const resolved = await resolveSyncPublication(provider, workspaceId, publication, signal())
    expect(resolved.kind).toBe('committed')
    if (resolved.kind !== 'committed') throw new Error('setup')
    const next = await commitFor('2', op(2), [lost.commitHash], deviceB)
    await publishSyncCommit(provider, next.commit, next.uploads, new Set(), { kind: 'match', revision: resolved.value.revision }, signal())
    expect((await resolveSyncPublication(provider, workspaceId, publication, signal())).kind).toBe('superseded')
  })

  it('reports absent only after a complete ancestry walk and undetermined on gaps or budget', async () => {
    const provider = new MemorySyncProvider(), first = await commitFor('1', op(1))
    const published = await publishSyncCommit(provider, first.commit, first.uploads, new Set(), { kind: 'absent' }, signal())
    const other = { operationId: op(7), commitHash: `sha256:${'f'.repeat(64)}` }
    expect((await resolveSyncPublication(provider, workspaceId, other, signal())).kind).toBe('absent')
    expect((await resolveSyncPublication(provider, workspaceId, other, signal(), 0)).kind).toBe('undetermined')
    provider.objects.delete(`${workspaceId}/${published.commitHash}`)
    expect((await resolveSyncPublication(provider, workspaceId, other, signal())).kind).toBe('undetermined')
  })

  it('stops before the head request once cancelled', async () => {
    const provider = new MemorySyncProvider(), { commit, uploads } = await commitFor('x', op(1)), controller = new AbortController()
    controller.abort()
    await expect(publishSyncCommit(provider, commit, uploads, new Set(), { kind: 'absent' }, controller.signal)).rejects.toThrow()
    expect(provider.head).toBeNull()
  })
})
