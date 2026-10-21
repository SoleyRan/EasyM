import { describe, expect, it } from 'vitest'
import { encodeSyncDeviceHead, MAX_SYNC_HEAD_BYTES, MERGE_DEVICE_ID, parseSyncDeviceHead, SyncContractError, type SyncDeviceHead } from './sync-contract'

const workspaceId = '1358f0a2-25b8-441b-9d55-379f6ca303dc'
const deviceId = '6f0c1c55-3c9e-4f53-9c9b-0b8f4d9f6a01'
const head: SyncDeviceHead = { schemaVersion: 1, workspaceId, deviceId, sequence: 3, commitHash: `sha256:${'a'.repeat(64)}` }
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const parse = (bytes: Uint8Array, ws = workspaceId, device = deviceId) => parseSyncDeviceHead(bytes, ws, device)

describe('remote device head trust boundary', () => {
  it('round-trips a versioned pointer without changing identity, sequence or digest', () => {
    expect(parse(encodeSyncDeviceHead(head))).toEqual(head)
  })

  it('rejects heads for another workspace or stored under another device name', () => {
    expect(() => parse(encode({ ...head, workspaceId: 'c888f21e-6818-42dd-b9ec-66f89f811312' }))).toThrow('workspace_mismatch')
    expect(() => parse(encode(head), workspaceId, 'c888f21e-6818-42dd-b9ec-66f89f811312')).toThrow('device_mismatch')
  })

  it('stops on future or invalid schema versions rather than treating them as empty', () => {
    for (const schemaVersion of [0, 2]) expect(() => parse(encode({ ...head, schemaVersion }))).toThrow('unsupported_schema')
    for (const schemaVersion of ['1', null, 1.5]) expect(() => parse(encode({ ...head, schemaVersion }))).toThrow('invalid_head')
  })

  it('rejects missing fields, additional fields, arrays and primitive JSON', () => {
    for (const value of [null, [], 1, 'head', {}, { ...head, commitHash: undefined }, { ...head, path: '../other' }, { ...head, credentials: 'secret' }]) {
      expect(() => parse(encode(value))).toThrow(SyncContractError)
    }
  })

  it('requires a positive integer sequence', () => {
    for (const sequence of [0, -1, 1.5, '2', null, 2 ** 53]) expect(() => parse(encode({ ...head, sequence }))).toThrow('invalid_head')
  })

  it('rejects paths, URL-like hashes, truncated and noncanonical digests', () => {
    for (const commitHash of ['../head', 'https://example.test/object', `sha256:${'a'.repeat(63)}`, `sha256:${'A'.repeat(64)}`, `sha256:${'g'.repeat(64)}`, `${head.commitHash}\n`, null]) {
      expect(() => parse(encode({ ...head, commitHash }))).toThrow('invalid_head')
    }
  })

  it('rejects malformed identifiers and the reserved merge author', () => {
    for (const id of ['', '../workspace', workspaceId.toUpperCase(), `${workspaceId}\n`]) {
      expect(() => parse(encode({ ...head, workspaceId: id }))).toThrow('invalid_head')
      expect(() => parse(encode(head), id)).toThrow('invalid_head')
      expect(() => parse(encode(head), workspaceId, id)).toThrow('invalid_head')
    }
    expect(() => parse(encode({ ...head, deviceId: MERGE_DEVICE_ID }), workspaceId, MERGE_DEVICE_ID)).toThrow('invalid_head')
  })

  it('rejects invalid UTF-8 and damaged JSON without exposing payloads in errors', () => {
    for (const bytes of [new Uint8Array([0xff]), new TextEncoder().encode('{"secret":"never-log-this"'), new Uint8Array()]) {
      expect(() => parse(bytes)).toThrow('invalid_head')
    }
  })

  it('enforces a byte budget before parsing remote data', () => {
    const valid = encodeSyncDeviceHead(head)
    const exact = new Uint8Array(MAX_SYNC_HEAD_BYTES).fill(32)
    exact.set(valid)
    expect(parse(exact)).toEqual(head)
    const excessive = new Uint8Array(MAX_SYNC_HEAD_BYTES + 1).fill(32)
    excessive.set(valid)
    expect(() => parse(excessive)).toThrow('invalid_head')
  })
})
