import { describe, expect, it } from 'vitest'
import { encodeSyncCommit, isPortableSyncPath, parseSyncCommit, readSyncCommit, SyncCommitError, uploadSyncCommit, type SyncCommit } from './sync-commit'
import { MERGE_DEVICE_ID, syncHash } from './sync-contract'
import { MemorySyncProvider } from './sync-memory-provider'

const workspaceId = '1358f0a2-25b8-441b-9d55-379f6ca303dc'
const deviceA = '6f0c1c55-3c9e-4f53-9c9b-0b8f4d9f6a01'
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

describe('commit upload', () => {
  it('uploads referenced objects before the commit object', async () => {
    const provider = new MemorySyncProvider(), { commit, uploads } = await commitFor('x', op(1))
    const hash = await uploadSyncCommit(provider, commit, uploads, new Set(), signal())
    expect(hash).toBe(await syncHash(encodeSyncCommit(commit)))
    expect(provider.requests).toEqual(['createObject', 'createObject'])
  })

  it('refuses commits referencing objects neither uploaded nor known remote', async () => {
    const provider = new MemorySyncProvider(), { commit } = await commitFor('x', op(1))
    await expect(uploadSyncCommit(provider, commit, [], new Set(), signal())).rejects.toThrow('missing_object')
    expect(provider.requests).toEqual([])
  })

  it('rejects upload bytes that do not match their hash and stops when cancelled', async () => {
    const provider = new MemorySyncProvider(), { commit, uploads } = await commitFor('x', op(1))
    await expect(uploadSyncCommit(provider, commit, [{ ...uploads[0], bytes: encode('y') }], new Set(), signal())).rejects.toThrow('hash_mismatch')
    const controller = new AbortController(); controller.abort()
    await expect(uploadSyncCommit(provider, commit, uploads, new Set(), controller.signal)).rejects.toThrow()
    expect(provider.objects.size).toBe(0)
  })

  it('accepts at most one parent for device commits and two sorted parents for merges', async () => {
    const { commit } = await commitFor('x', op(1)), a = `sha256:${'a'.repeat(64)}`, b = `sha256:${'b'.repeat(64)}`
    expect(code(() => parse({ ...commit, parents: [a, b] }))).toBe('invalid_commit')
    expect(parse({ ...commit, deviceId: MERGE_DEVICE_ID, parents: [a, b] }).parents).toEqual([a, b])
    for (const parents of [[b, a], [a], [a, a]]) expect(code(() => parse({ ...commit, deviceId: MERGE_DEVICE_ID, parents }))).toBe('invalid_commit')
  })
})
