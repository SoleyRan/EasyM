import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { encodeSyncCommit, type SyncCommit } from '../core/sync-commit'
import { encodeSyncDeviceHead, syncHash } from '../core/sync-contract'
import { encodeWorkspaceIdentity, type WorkspaceIdentity } from '../core/sync-identity'
import { pairWorkspace, previewRemote } from './sync-pairing'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
beforeEach(() => vi.mocked(invoke).mockReset())
const remoteId = '1358f0a2-25b8-441b-9d55-379f6ca303dc'
const localId = 'c888f21e-6818-42dd-b9ec-66f89f811312'
const device = '6f0c1c55-3c9e-4f53-9c9b-0b8f4d9f6a01'
const id = (n: number) => `a1b2c3d4-0000-4000-8000-${String(n).padStart(12, '0')}`
const credentials = { endpoint: 'https://dav.example.test/', username: 'u', password: 'p' }
const identity: WorkspaceIdentity = { schemaVersion: 1, workspaceId: localId, documents: [{ documentId: id(1), path: 'a.md' }, { documentId: id(9), path: 'mine.md' }] }

async function probed(paths: [number, string][]) {
  const commit: SyncCommit = { schemaVersion: 1, workspaceId: remoteId, operationId: id(50), deviceId: device, parents: [],
    documents: paths.map(([n, path]) => ({ documentId: id(n), path, text: { object: `sha256:${'a'.repeat(64)}`, bytes: 1 }, imageMetadata: null, resources: [] })), tombstones: [] }
  const bytes = encodeSyncCommit(commit)
  const head = encodeSyncDeviceHead({ schemaVersion: 1, workspaceId: remoteId, deviceId: device, sequence: 1, commitHash: await syncHash(bytes) })
  return { deviceId: device, head: Array.from(head), commit: Array.from(bytes) }
}

describe('pairing', () => {
  it('previews a join from verified remote heads without writing anything', async () => {
    vi.mocked(invoke).mockResolvedValueOnce([await probed([[1, 'a.md'], [2, 'b.md'], [3, 'Mine.md']])])
    const preview = await previewRemote(credentials, remoteId, identity)
    expect(preview).toMatchObject({ workspaceId: remoteId, devices: 1, download: 2, upload: 1, collisions: ['Mine.md'] })
    expect(preview.commits).toHaveLength(1)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('sync_probe_workspace', { ...credentials, workspaceId: remoteId })
  })

  it('links same-named documents only when chosen, keeping the old id as history mapping', async () => {
    const remote = await probed([[1, 'a.md'], [3, 'Mine.md']])
    vi.mocked(invoke).mockResolvedValueOnce([remote])
    const preview = await previewRemote(credentials, remoteId, identity)
    vi.mocked(invoke).mockResolvedValueOnce('sha256:joined').mockResolvedValueOnce({ bindingId: 'b' })
    await pairWorkspace('ws', credentials, identity, 'sha256:r', { workspaceId: remoteId, link: preview.commits })
    const written = JSON.parse(new TextDecoder().decode(new Uint8Array((vi.mocked(invoke).mock.calls[1][1] as { bytes: number[] }).bytes)))
    expect(written.workspaceId).toBe(remoteId)
    // a.md already had the remote id; mine.md matches Mine.md case-insensitively and takes id 3.
    expect(written.documents).toEqual([{ documentId: id(1), path: 'a.md' }, { documentId: id(3), path: 'mine.md', historyId: id(9) }])
  })

  it('rejects heads whose commit is missing or does not match', async () => {
    const good = await probed([[1, 'a.md']])
    vi.mocked(invoke).mockResolvedValueOnce([{ ...good, commit: null }])
    await expect(previewRemote(credentials, remoteId, identity)).rejects.toThrow('missing_object')
    vi.mocked(invoke).mockResolvedValueOnce([{ ...good, commit: Array.from(new TextEncoder().encode('{}')) }])
    await expect(previewRemote(credentials, remoteId, identity)).rejects.toThrow('hash_mismatch')
  })

  it('binds directly for a new remote workspace', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ bindingId: 'b' })
    await pairWorkspace('ws', credentials, identity, 'sha256:r', null)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('sync_bind', { id: 'ws', ...credentials })
  })

  it('adopts the remote workspace id before binding and restores it if binding fails', async () => {
    vi.mocked(invoke).mockResolvedValueOnce('sha256:joined').mockResolvedValueOnce({ bindingId: 'b' })
    await pairWorkspace('ws', credentials, identity, 'sha256:r', { workspaceId: remoteId, link: null })
    const [command, args] = vi.mocked(invoke).mock.calls[0] as [string, { expected: string; bytes: number[] }]
    expect(command).toBe('sync_identity_write')
    expect(args.expected).toBe('sha256:r')
    expect(JSON.parse(new TextDecoder().decode(new Uint8Array(args.bytes))).workspaceId).toBe(remoteId)

    vi.mocked(invoke).mockReset()
    vi.mocked(invoke).mockResolvedValueOnce('sha256:joined').mockRejectedValueOnce('unauthorized').mockResolvedValueOnce('sha256:back')
    await expect(pairWorkspace('ws', credentials, identity, 'sha256:r', { workspaceId: remoteId, link: null })).rejects.toBe('unauthorized')
    const restore = vi.mocked(invoke).mock.calls[2] as [string, { expected: string; bytes: number[] }]
    expect(restore[0]).toBe('sync_identity_write')
    expect(restore[1].expected).toBe('sha256:joined')
    expect(new Uint8Array(restore[1].bytes)).toEqual(encodeWorkspaceIdentity(identity))
  })
})
