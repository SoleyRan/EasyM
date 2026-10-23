import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { syncHash } from '../core/sync-contract'
import { encodeWorkspaceIdentity, type WorkspaceIdentity } from '../core/sync-identity'
import { DesktopSyncHost } from './sync-host'
import type { SyncBinding } from './sync-native'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
beforeEach(() => vi.mocked(invoke).mockReset())
const workspaceId = '1358f0a2-25b8-441b-9d55-379f6ca303dc'
const deviceId = '6f0c1c55-3c9e-4f53-9c9b-0b8f4d9f6a01'
const A = 'a1b2c3d4-0000-4000-8000-000000000001'
const binding: SyncBinding = { bindingId: 'b', workspaceId, deviceId, endpoint: 'https://dav.example.test/', username: 'u', createdAt: 1 }
const dirty = () => new Set(['s1'])
const host = () => new DesktopSyncHost('ws', binding, dirty)

describe('desktop sync host', () => {
  it('parses the identity and uses the digest of its exact bytes as the write precondition', async () => {
    // Bytes as the native side wrote them (different key order than the TS encoder).
    const raw = new TextEncoder().encode(`{"workspaceId":"${workspaceId}","schemaVersion":1,"documents":[{"path":"a.md","documentId":"${A}"}]}`)
    vi.mocked(invoke).mockResolvedValueOnce({ identity: Array.from(raw), documents: [{ path: 'a.md', revision: 'sha256:r', bytes: 1, historyId: null }] })
    const scan = await host().scan()
    expect(invoke).toHaveBeenCalledWith('sync_local_revisions', { id: 'ws' })
    expect(scan.identity!.documents).toEqual([{ documentId: A, path: 'a.md' }])
    expect(scan.identityRevision).toBe(await syncHash(raw))
    expect(scan.documents).toEqual([{ path: 'a.md', revision: 'sha256:r', historyId: null, historyUnreadable: undefined }])
    vi.mocked(invoke).mockResolvedValueOnce({ identity: null, documents: [] })
    expect((await host().scan()).identityRevision).toBeNull()
  })

  it('maps writes, moves, trash and identity updates onto the native commands', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined)
    const h = host()
    await h.write({ operationId: 'op', path: 'n/a.md', expected: null, bytes: new Uint8Array([1, 2]), assets: [{ path: 'assets/img-a-v1.png', bytes: new Uint8Array([3]) }], instances: [] })
    expect(invoke).toHaveBeenLastCalledWith('sync_local_write', { id: 'ws', request: { operationId: 'op', path: 'n/a.md', expected: null, bytes: [1, 2], assets: [{ path: 'assets/img-a-v1.png', bytes: [3] }], instances: [] } })
    vi.mocked(invoke).mockResolvedValueOnce([])
    await h.move({ operationId: 'op', from: 'a.md', to: 'd/a.md', expected: 'sha256:x', references: ['assets/img-a-v1.png'] })
    expect(invoke).toHaveBeenLastCalledWith('sync_local_move', { id: 'ws', operationId: 'op', from: 'a.md', to: 'd/a.md', expected: 'sha256:x', references: ['assets/img-a-v1.png'] })
    await h.trash({ operationId: 'op', path: 'a.md', expected: 'sha256:x' })
    expect(invoke).toHaveBeenLastCalledWith('sync_local_trash', { id: 'ws', operationId: 'op', path: 'a.md', expected: 'sha256:x' })
    const identity: WorkspaceIdentity = { schemaVersion: 1, workspaceId, documents: [{ documentId: A, path: 'a.md' }] }
    await h.writeIdentity(identity, 'sha256:prev')
    expect(invoke).toHaveBeenLastCalledWith('sync_identity_write', { id: 'ws', expected: 'sha256:prev', bytes: Array.from(encodeWorkspaceIdentity(identity)) })
  })

  it('reports trash revisions, open tabs and the binding identity', async () => {
    vi.mocked(invoke).mockResolvedValueOnce([
      { operationId: 'o1', path: 'a.md', deletedAt: 1, documentId: A, revision: 'sha256:a' },
      { operationId: 'o2', path: 'b.md', deletedAt: 2, documentId: null, revision: 'sha256:b' },
    ])
    const h = host()
    expect([...(await h.trashed())]).toEqual([[A, 'sha256:a']])
    vi.mocked(invoke).mockResolvedValueOnce([{ path: 'a.md', session: 's1' }, { path: 'n/b.md', session: 's2' }])
    expect(await h.open()).toEqual({ open: new Set(['a.md', 'n/b.md']), dirty: new Set(['a.md']) })
    expect(invoke).toHaveBeenLastCalledWith('sync_local_open', { id: 'ws' })
    vi.mocked(invoke).mockResolvedValueOnce(['s2'])
    await h.move({ operationId: 'o', from: 'n/b.md', to: 'm/b.md', expected: 'sha256:b', references: [] })
    expect(h.movedSessions).toEqual(['s2'])
    expect([h.workspaceId, h.deviceId]).toEqual([workspaceId, deviceId])
  })
})
