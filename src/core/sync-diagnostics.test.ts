import { describe, expect, it } from 'vitest'
import { endpointKind, safeCode, syncDiagnostics, tally, type SyncDiagnosticsInput } from './sync-diagnostics'

const input = (patch: Partial<SyncDiagnosticsInput> = {}): SyncDiagnosticsInput => ({
  appVersion: '1.0.0', platform: 'windows',
  status: { kind: 'paused', code: 'rollback' },
  endpoint: 'https://secret-host.example.com/remote.php/dav/files/alice/',
  interval: 300_000,
  state: { sequence: 7, commitHash: `sha256:${'b'.repeat(64)}`, applied: `sha256:${'c'.repeat(64)}`, pending: false, seenDevices: 2, deferred: 1, conflicts: 1, retiring: 0, rebased: false },
  report: { published: true, downloaded: 3, conflicts: { merged: 1 }, copies: 0, keptDeletes: 0, restored: 0, deferred: 1, skipped: tally(['missing_assets']), failed: tally(['revision_conflict', 'C:\\Users\\alice\\私人日记.md failed']), openConflicts: 1 },
  quota: { available: null, used: 460 },
  devices: 3,
  workspaceId: '1358f0a2-25b8-441b-9d55-379f6ca303dc', deviceId: 'd0d0d0d0-0000-4000-8000-000000000001',
  generatedAt: new Date('2026-10-29T08:00:00Z'),
  ...patch,
})

describe('sync diagnostics', () => {
  it('contains codes, counts and short ids, never the endpoint, user, paths or full ids', () => {
    const text = syncDiagnostics(input())
    for (const secret of ['secret-host', 'alice', 'remote.php', '私人日记', 'Users', '1358f0a2-25b8', 'b'.repeat(16), 'c'.repeat(16)]) expect(text, secret).not.toContain(secret)
    const value = JSON.parse(text)
    expect(value.connection).toEqual({ endpoint: 'https', workspace: '1358f0a2', device: 'd0d0d0d0', interval: '5 min' })
    expect(value.status).toEqual({ kind: 'paused', code: 'rollback', attempt: null })
    expect(value.state.commitHash).toBe('bbbbbbbb')
    expect(value.lastPass.failed).toEqual({ revision_conflict: 1, other: 1 })
    expect(value.quota).toEqual({ available: null, used: 460 })
  })
  it('reports manual sync, a loopback endpoint and a missing state', () => {
    const value = JSON.parse(syncDiagnostics(input({ interval: null, endpoint: 'http://127.0.0.1:18081/dav/', state: null, report: null, quota: null, devices: null })))
    expect(value.connection.interval).toBe('manual')
    expect(value.connection.endpoint).toBe('http (本机)')
    expect([value.state, value.lastPass, value.quota, value.devices]).toEqual([null, null, null, null])
  })
  it('keeps only identifier-shaped error codes', () => {
    expect(['rollback', 'server_busy:423', 'unexpected_status:418'].map(safeCode)).toEqual(['rollback', 'server_busy:423', 'unexpected_status:418'])
    expect(['open D:/x.md failed', 'Error: something', 'a'.repeat(60), '', null].map(safeCode)).toEqual(['other', 'other', 'other', 'none', 'none'])
    expect(endpointKind('not a url')).toBe('invalid')
  })
})
