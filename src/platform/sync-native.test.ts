import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { encodeSyncDeviceHead, syncHash } from '../core/sync-contract'
import { NativeSyncProvider, readSyncState, syncError, writeSyncState, type SyncBinding } from './sync-native'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
beforeEach(() => vi.mocked(invoke).mockReset())
const workspaceId = '1358f0a2-25b8-441b-9d55-379f6ca303dc'
const deviceId = '6f0c1c55-3c9e-4f53-9c9b-0b8f4d9f6a01'
const other = '6f0c1c55-3c9e-4f53-9c9b-0b8f4d9f6a02'
const binding: SyncBinding = { bindingId: 'b', workspaceId, deviceId, endpoint: 'https://dav.example.test/', username: 'u', createdAt: 1 }
const signal = () => new AbortController().signal
const head = (id: string, sequence = 1) => ({ schemaVersion: 1 as const, workspaceId, deviceId: id, sequence, commitHash: `sha256:${'a'.repeat(64)}` })

describe('native sync provider adapter', () => {
  it('parses device heads through the core trust boundary', async () => {
    vi.mocked(invoke).mockResolvedValueOnce([{ deviceId: other, bytes: Array.from(encodeSyncDeviceHead(head(other, 3))), revision: '"e"' }])
    const provider = new NativeSyncProvider('ws', binding)
    expect(await provider.listDeviceHeads(workspaceId, signal())).toEqual([{ head: head(other, 3), revision: '"e"' }])
    expect(invoke).toHaveBeenCalledWith('sync_heads', { id: 'ws' })
    // A head stored under another device's name is rejected, not trusted.
    vi.mocked(invoke).mockResolvedValueOnce([{ deviceId, bytes: Array.from(encodeSyncDeviceHead(head(other))), revision: null }])
    await expect(provider.listDeviceHeads(workspaceId, signal())).rejects.toThrow('device_mismatch')
  })

  it('refuses other namespaces, other devices and aborted calls before any IPC', async () => {
    const provider = new NativeSyncProvider('ws', binding)
    await expect(provider.listDeviceHeads('c888f21e-6818-42dd-b9ec-66f89f811312', signal())).rejects.toThrow('workspace_mismatch')
    await expect(provider.publishDeviceHead(head(other), { kind: 'absent' }, signal())).rejects.toThrow('permission_denied')
    const controller = new AbortController(); controller.abort()
    await expect(provider.readObject(workspaceId, `sha256:${'a'.repeat(64)}`, controller.signal)).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('maps publish preconditions and results', async () => {
    const provider = new NativeSyncProvider('ws', binding)
    for (const [expected, condition] of [[{ kind: 'absent' }, null], [{ kind: 'owned' }, ''], [{ kind: 'match', revision: '"r"' }, '"r"']] as const) {
      vi.mocked(invoke).mockResolvedValueOnce({ kind: 'committed', revision: '"n"' })
      expect(await provider.publishDeviceHead(head(deviceId), expected, signal())).toEqual({ kind: 'committed', revision: '"n"' })
      expect((vi.mocked(invoke).mock.lastCall![1] as { expected: string | null }).expected).toBe(condition)
    }
    vi.mocked(invoke).mockResolvedValueOnce({ kind: 'conflict', revision: null })
    expect(await provider.publishDeviceHead(head(deviceId), { kind: 'absent' }, signal())).toEqual({ kind: 'conflict' })
    vi.mocked(invoke).mockResolvedValueOnce({ kind: 'unknown', revision: null })
    expect(await provider.publishDeviceHead(head(deviceId), { kind: 'absent' }, signal())).toEqual({ kind: 'unknown' })
  })

  it('re-verifies object bytes against their hash', async () => {
    const provider = new NativeSyncProvider('ws', binding)
    const value = new TextEncoder().encode('对象'), hash = await syncHash(value)
    vi.mocked(invoke).mockResolvedValueOnce(Array.from(value))
    expect(await provider.readObject(workspaceId, hash, signal())).toEqual(value)
    vi.mocked(invoke).mockResolvedValueOnce(Array.from(new TextEncoder().encode('other')))
    await expect(provider.readObject(workspaceId, hash, signal())).rejects.toThrow('hash_mismatch')
    vi.mocked(invoke).mockResolvedValueOnce(null)
    expect(await provider.readObject(workspaceId, hash, signal())).toBeNull()
    vi.mocked(invoke).mockResolvedValueOnce('exists')
    expect(await provider.createObject(workspaceId, hash, value, signal())).toBe('exists')
  })

  it('round-trips persisted state and maps errors to actionable messages', async () => {
    const device = { workspaceId, deviceId, sequence: 2, commitHash: `sha256:${'b'.repeat(64)}`, seen: { [other]: 1 } }
    const conflict = { documentId: other, copyId: deviceId, kind: 'local' as const, base: `sha256:${'c'.repeat(64)}` }
    const state = { device, applied: `sha256:${'b'.repeat(64)}`, deferred: [], conflicts: [conflict] }
    vi.mocked(invoke).mockResolvedValueOnce(undefined)
    await writeSyncState('ws', state)
    const written = (vi.mocked(invoke).mock.lastCall![1] as { bytes: number[] }).bytes
    const stored = JSON.parse(new TextDecoder().decode(new Uint8Array(written)))
    expect([stored.workspaceId, stored.deviceId]).toEqual([workspaceId, deviceId])
    vi.mocked(invoke).mockResolvedValueOnce(written)
    expect(await readSyncState('ws')).toEqual(state)
    // State written before step 4B has no conflict list; malformed entries are dropped, not trusted.
    const older = { ...stored }; delete older.conflicts
    vi.mocked(invoke).mockResolvedValueOnce(Array.from(new TextEncoder().encode(JSON.stringify(older))))
    expect((await readSyncState('ws'))?.conflicts).toEqual([])
    vi.mocked(invoke).mockResolvedValueOnce(Array.from(new TextEncoder().encode(JSON.stringify({ ...stored, conflicts: [conflict, { documentId: 1 }, { ...conflict, kind: 'other' }] }))))
    expect((await readSyncState('ws'))?.conflicts).toEqual([conflict])
    vi.mocked(invoke).mockResolvedValueOnce(Array.from(new TextEncoder().encode(JSON.stringify({ ...stored, deviceId: other }))))
    await expect(readSyncState('ws')).rejects.toThrow('sync_state_invalid')
    vi.mocked(invoke).mockResolvedValueOnce(null)
    expect(await readSyncState('ws')).toBeNull()
    vi.mocked(invoke).mockResolvedValueOnce(Array.from(new TextEncoder().encode('{"sequence":"x"}')))
    await expect(readSyncState('ws')).rejects.toThrow('sync_state_invalid')
    expect(syncError('endpoint_insecure')).toContain('HTTPS')
    expect(syncError('server_busy:423')).toContain('稍后')
    expect(syncError('certificate_invalid')).toContain('不会跳过')
  })
})
