/** Experimental v2 contract. Not connected to the editor or a network adapter. */
export const SYNC_SCHEMA_VERSION = 1
export const MAX_SYNC_HEAD_BYTES = 4096
/** Remote device directory budget; more heads than this stops sync instead of truncating. */
export const MAX_SYNC_DEVICES = 64
/** Author of content-deterministic merge commits; never a real device and never a head. */
export const MERGE_DEVICE_ID = '00000000-0000-4000-8000-000000000000'

/**
 * Per-device head, stored at `devices/<deviceId>.json` and written only by its owner.
 * Step 1 measured that WebDAV servers do not provide an atomic compare-and-swap on a
 * shared file, so no file is shared between writers; devices converge by merging.
 */
export interface SyncDeviceHead {
  schemaVersion: 1
  workspaceId: string
  deviceId: string
  /** Increases by one per publication; a lower remote value means a rollback or a cloned device. */
  sequence: number
  commitHash: string
}

/** `revision` is a provider-issued strong validator, or null when the server gave none. */
export interface VersionedDeviceHead {
  head: SyncDeviceHead
  revision: string | null
}

/**
 * `owned` writes without a precondition. It is only valid for the caller's own device head after
 * reading it back, when the server offers no strong validator (Apache: weak ETag for 1 s).
 */
export type ExpectedSyncHead = { kind: 'absent' } | { kind: 'match'; revision: string } | { kind: 'owned' }
export type PublishSyncHeadResult =
  | { kind: 'committed'; revision: string | null }
  | { kind: 'conflict' }
  // The request might have committed. Read the device head back before retrying.
  | { kind: 'unknown' }

/**
 * Credentials, endpoint configuration and HTTP remain in the platform adapter.
 * Implementations verify object hashes/limits and support cancellation. A cancelled
 * publication may have committed and must be reported as unknown, not rolled back.
 * Authentication, transport and quota failures are explicit errors, never absence.
 */
export interface SyncProvider {
  /** Complete listing of device heads; a partial listing must be an error, not a shorter array. */
  listDeviceHeads(workspaceId: string, signal: AbortSignal): Promise<VersionedDeviceHead[]>
  /** Returns a strong revision; null only for a genuinely missing head. */
  readDeviceHead(workspaceId: string, deviceId: string, signal: AbortSignal): Promise<VersionedDeviceHead | null>
  /** Conditional where the server supports it; correctness does not depend on it (single writer). */
  publishDeviceHead(head: SyncDeviceHead, expected: ExpectedSyncHead, signal: AbortSignal): Promise<PublishSyncHeadResult>
  readObject(workspaceId: string, hash: string, signal: AbortSignal): Promise<Uint8Array | null>
  /** Create-only; existing bytes must be checked, never silently overwritten. */
  createObject(workspaceId: string, hash: string, bytes: Uint8Array, signal: AbortSignal): Promise<'created' | 'exists'>
}

export class SyncContractError extends Error {
  readonly code: 'invalid_head' | 'unsupported_schema' | 'workspace_mismatch' | 'device_mismatch'
  constructor(code: SyncContractError['code']) {
    super(code)
    this.code = code
    this.name = 'SyncContractError'
  }
}

// A negative lookahead enforces the absolute end; `$` also accepts a final newline.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/
const sha256 = /^sha256:[0-9a-f]{64}(?![\s\S])/
export const isSyncId = (value: unknown): value is string => typeof value === 'string' && uuid.test(value)
export const isSyncHash = (value: unknown): value is string => typeof value === 'string' && sha256.test(value)

export async function syncHash(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return 'sha256:' + Array.from(digest, (v) => v.toString(16).padStart(2, '0')).join('')
}

export const encodeSyncDeviceHead = (head: SyncDeviceHead): Uint8Array => new TextEncoder().encode(JSON.stringify({
  schemaVersion: SYNC_SCHEMA_VERSION, workspaceId: head.workspaceId, deviceId: head.deviceId, sequence: head.sequence, commitHash: head.commitHash,
}))

/**
 * Treat remote JSON as untrusted. Validates a pointer, not its referenced objects.
 * `expectedDeviceId` is the device named by the head's location, which must match its content.
 */
export function parseSyncDeviceHead(bytes: Uint8Array, expectedWorkspaceId: string, expectedDeviceId: string): SyncDeviceHead {
  if (!uuid.test(expectedWorkspaceId) || !uuid.test(expectedDeviceId) || bytes.byteLength === 0 || bytes.byteLength > MAX_SYNC_HEAD_BYTES) throw new SyncContractError('invalid_head')
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)) }
  catch { throw new SyncContractError('invalid_head') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SyncContractError('invalid_head')
  const head = value as Record<string, unknown>
  if (!Number.isSafeInteger(head.schemaVersion)) throw new SyncContractError('invalid_head')
  if (head.schemaVersion !== SYNC_SCHEMA_VERSION) throw new SyncContractError('unsupported_schema')
  if (Object.keys(head).length !== 5 || !isSyncId(head.workspaceId) || !isSyncId(head.deviceId) || head.deviceId === MERGE_DEVICE_ID || !isSyncHash(head.commitHash)) throw new SyncContractError('invalid_head')
  if (!Number.isSafeInteger(head.sequence) || (head.sequence as number) < 1) throw new SyncContractError('invalid_head')
  if (head.workspaceId !== expectedWorkspaceId) throw new SyncContractError('workspace_mismatch')
  if (head.deviceId !== expectedDeviceId) throw new SyncContractError('device_mismatch')
  return { schemaVersion: 1, workspaceId: head.workspaceId, deviceId: head.deviceId, sequence: head.sequence as number, commitHash: head.commitHash }
}
