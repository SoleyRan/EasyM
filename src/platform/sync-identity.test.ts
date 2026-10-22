import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { syncHash } from '../core/sync-contract'
import { encodeWorkspaceIdentity } from '../core/sync-identity'
import { commitIdentity, disableIdentity, identityError, IdentityScanError, previewIdentity } from './sync-identity'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
beforeEach(() => vi.mocked(invoke).mockReset())
const workspaceId = '1358f0a2-25b8-441b-9d55-379f6ca303dc'
const A = 'a1b2c3d4-0000-4000-8000-000000000001'

describe('identity platform flow', () => {
  it('previews a first enable without writing, then writes conditionally on absence', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ identity: null, identityError: null, unreadable: [], documents: [{ path: 'a.md', historyId: A }, { path: 'b.md', historyId: null }] })
    const preview = await previewIdentity('ws')
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(preview.enabled).toBe(false)
    expect(preview.baseRevision).toBeNull()
    expect(preview.plan.added.map((d) => [d.path, d.reusedHistory])).toEqual([['a.md', true], ['b.md', false]])
    vi.mocked(invoke).mockResolvedValueOnce('sha256:new')
    await commitIdentity('ws', preview)
    const [command, args] = vi.mocked(invoke).mock.calls[1] as [string, { expected: string | null; bytes: number[] }]
    expect(command).toBe('sync_identity_write')
    expect(args.expected).toBeNull()
    expect(JSON.parse(new TextDecoder().decode(new Uint8Array(args.bytes))).documents).toHaveLength(2)
  })

  it('uses the digest of the scanned bytes as the write precondition', async () => {
    const bytes = encodeWorkspaceIdentity({ schemaVersion: 1, workspaceId, documents: [{ documentId: A, path: 'a.md' }] })
    vi.mocked(invoke).mockResolvedValueOnce({ identity: Array.from(bytes), identityError: null, unreadable: [], documents: [{ path: 'a.md', historyId: null }, { path: 'new.md', historyId: null }] })
    const preview = await previewIdentity('ws')
    expect(preview.enabled).toBe(true)
    expect(preview.baseRevision).toBe(await syncHash(bytes))
    vi.mocked(invoke).mockResolvedValueOnce('sha256:x')
    await commitIdentity('ws', preview)
    expect((vi.mocked(invoke).mock.calls[1][1] as { expected: string }).expected).toBe(await syncHash(bytes))
  })

  it('stops on incomplete scans or unreadable identity files', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ identity: null, identityError: null, unreadable: ['locked'], documents: [] })
    await expect(previewIdentity('ws')).rejects.toBeInstanceOf(IdentityScanError)
    vi.mocked(invoke).mockResolvedValueOnce({ identity: null, identityError: 'invalid_data', unreadable: [], documents: [] })
    await expect(previewIdentity('ws')).rejects.toMatchObject({ code: 'identity_unreadable' })
    vi.mocked(invoke).mockResolvedValueOnce({ identity: Array.from(new TextEncoder().encode('{"schemaVersion":2}')), identityError: null, unreadable: [], documents: [] })
    await expect(previewIdentity('ws')).rejects.toMatchObject({ code: 'unsupported_schema' })
  })

  it('applies explicit resolutions for a possible external move', async () => {
    const bytes = encodeWorkspaceIdentity({ schemaVersion: 1, workspaceId, documents: [{ documentId: A, path: 'old.md' }] })
    vi.mocked(invoke).mockResolvedValueOnce({ identity: Array.from(bytes), identityError: null, unreadable: [], documents: [{ path: 'new.md', historyId: null }] })
    const preview = await previewIdentity('ws')
    expect(preview.plan.paused).toMatchObject([{ path: 'new.md', reason: 'possible_move' }])
    vi.mocked(invoke).mockResolvedValueOnce('sha256:x')
    const identity = await commitIdentity('ws', preview, [{ kind: 'bind', path: 'new.md', documentId: A }])
    expect(identity.documents).toEqual([{ documentId: A, path: 'new.md' }])
  })

  it('removes only with the expected revision and maps errors to messages', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined)
    await disableIdentity('ws', 'sha256:x')
    expect(invoke).toHaveBeenCalledWith('sync_identity_remove', { id: 'ws', expected: 'sha256:x' })
    expect(identityError('revision_conflict')).toContain('重新预览')
    expect(identityError(new IdentityScanError('scan_incomplete'))).toContain('扫描不完整')
  })
})
