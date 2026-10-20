import { describe, expect, it } from 'vitest'
import { MAX_SYNC_HEAD_BYTES, parseSyncHead, SyncContractError, type SyncHead } from './sync-contract'

const workspaceId = '1358f0a2-25b8-441b-9d55-379f6ca303dc'
const head: SyncHead = { schemaVersion: 1, workspaceId, commitHash: `sha256:${'a'.repeat(64)}` }
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

describe('remote sync head trust boundary', () => {
  it('accepts a versioned pointer without changing its identity or digest', () => {
    expect(parseSyncHead(encode(head), workspaceId)).toEqual(head)
  })

  it('rejects a valid head for another workspace', () => {
    expect(() => parseSyncHead(encode({ ...head, workspaceId: 'c888f21e-6818-42dd-b9ec-66f89f811312' }), workspaceId)).toThrow('workspace_mismatch')
  })

  it('stops on future or invalid schema versions rather than treating them as empty', () => {
    for (const schemaVersion of [0, 2]) expect(() => parseSyncHead(encode({ ...head, schemaVersion }), workspaceId)).toThrow('unsupported_schema')
    for (const schemaVersion of ['1', null, 1.5]) expect(() => parseSyncHead(encode({ ...head, schemaVersion }), workspaceId)).toThrow('invalid_head')
  })

  it('rejects missing fields, additional fields, arrays and primitive JSON', () => {
    for (const value of [null, [], 1, 'head', {}, { ...head, commitHash: undefined }, { ...head, path: '../other' }, { ...head, credentials: 'secret' }]) {
      expect(() => parseSyncHead(encode(value), workspaceId)).toThrow(SyncContractError)
    }
  })

  it('rejects paths, URL-like hashes, truncated and noncanonical digests', () => {
    for (const commitHash of ['../head', 'https://example.test/object', `sha256:${'a'.repeat(63)}`, `sha256:${'A'.repeat(64)}`, `sha256:${'g'.repeat(64)}`, `${head.commitHash}\n`, null]) {
      expect(() => parseSyncHead(encode({ ...head, commitHash }), workspaceId)).toThrow('invalid_head')
    }
  })

  it('rejects malformed local and remote workspace identifiers', () => {
    for (const id of ['', '../workspace', workspaceId.toUpperCase(), `${workspaceId}\n`]) {
      expect(() => parseSyncHead(encode({ ...head, workspaceId: id }), workspaceId)).toThrow('invalid_head')
      expect(() => parseSyncHead(encode(head), id)).toThrow('invalid_head')
    }
  })

  it('rejects invalid UTF-8 and damaged JSON without exposing payloads in errors', () => {
    for (const bytes of [new Uint8Array([0xff]), new TextEncoder().encode('{"secret":"never-log-this"'), new Uint8Array()]) {
      expect(() => parseSyncHead(bytes, workspaceId)).toThrow('invalid_head')
    }
  })

  it('enforces a byte budget before parsing remote data', () => {
    const valid = encode(head)
    const exact = new Uint8Array(MAX_SYNC_HEAD_BYTES).fill(32)
    exact.set(valid)
    expect(parseSyncHead(exact, workspaceId)).toEqual(head)
    const excessive = new Uint8Array(MAX_SYNC_HEAD_BYTES + 1).fill(32)
    excessive.set(valid)
    expect(() => parseSyncHead(excessive, workspaceId)).toThrow('invalid_head')
  })
})
