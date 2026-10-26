import { describe, expect, it } from 'vitest'
import { classifySyncError, retryDelay, syncErrorCode } from './sync-schedule'
import { SyncLogError } from './sync-log'

describe('sync failure policy', () => {
  it('retries transient network and server failures', () => {
    for (const code of ['timeout', 'connect_failed', 'transport_failed', 'server_busy:423', 'server_busy:503', 'unexpected_status:500', 'scan_incomplete', 'revision_conflict']) {
      expect(classifySyncError(code)).toEqual({ kind: 'retry', code })
    }
    expect(classifySyncError(new SyncLogError('unknown_outcome')).kind).toBe('retry')
  })

  it('pauses for anything the user must resolve, including unknown errors', () => {
    for (const code of ['unauthorized', 'certificate_invalid', 'endpoint_redirected', 'credential_missing', 'quota_exceeded', 'invalid_listing', 'hash_mismatch', 'missing_object', 'unexpected_status:418', 'something_new']) {
      expect(classifySyncError(code).kind).toBe('action')
    }
    for (const code of ['rollback', 'device_conflict', 'too_many_devices', 'not_descendant'] as const) expect(classifySyncError(new SyncLogError(code))).toEqual({ kind: 'action', code })
  })

  it('backs off and caps the delay', () => {
    expect([1, 2, 3, 4, 9].map(retryDelay)).toEqual([10_000, 30_000, 120_000, 600_000, 600_000])
    expect(syncErrorCode(Object.assign(new Error('x'), { code: 'y' }))).toBe('y')
  })
})
