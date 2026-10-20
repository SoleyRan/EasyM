/** Experimental v2 contract. Not connected to the editor or a network adapter. */
export const SYNC_SCHEMA_VERSION = 1
export const MAX_SYNC_HEAD_BYTES = 4096

export interface SyncHead {
  schemaVersion: 1
  workspaceId: string
  commitHash: string
}

/** Provider-issued, opaque concurrency token; never synthesized from local time or hashes. */
export interface VersionedSyncHead {
  head: SyncHead
  revision: string
}

export type ExpectedSyncHead = { kind: 'absent' } | { kind: 'match'; revision: string }
export type PublishSyncHeadResult =
  | { kind: 'committed'; value: VersionedSyncHead }
  | { kind: 'conflict' }
  // The request might have committed. Inspect the head/commit ancestry before retrying.
  | { kind: 'unknown' }

/**
 * Credentials, endpoint configuration and HTTP remain in the platform adapter.
 * Implementations verify object hashes/limits and support cancellation. A cancelled
 * publication may have committed and must be reported as unknown, not rolled back.
 * Authentication, transport and quota failures are explicit errors, never absence.
 */
export interface SyncProvider {
  readHead(workspaceId: string, signal: AbortSignal): Promise<VersionedSyncHead | null>
  publishHead(head: SyncHead, expected: ExpectedSyncHead, signal: AbortSignal): Promise<PublishSyncHeadResult>
  readObject(workspaceId: string, hash: string, signal: AbortSignal): Promise<Uint8Array | null>
  /** Create-only; existing bytes must be checked, never silently overwritten. */
  createObject(workspaceId: string, hash: string, bytes: Uint8Array, signal: AbortSignal): Promise<'created' | 'exists'>
}

export class SyncContractError extends Error {
  constructor(public readonly code: 'invalid_head' | 'unsupported_schema' | 'workspace_mismatch') {
    super(code)
    this.name = 'SyncContractError'
  }
}

// A negative lookahead enforces the absolute end; `$` also accepts a final newline.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/
const sha256 = /^sha256:[0-9a-f]{64}(?![\s\S])/

/** Treat remote JSON as untrusted. This validates a pointer, not its referenced objects. */
export function parseSyncHead(bytes: Uint8Array, expectedWorkspaceId: string): SyncHead {
  if (!uuid.test(expectedWorkspaceId) || bytes.byteLength === 0 || bytes.byteLength > MAX_SYNC_HEAD_BYTES) throw new SyncContractError('invalid_head')
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)) }
  catch { throw new SyncContractError('invalid_head') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SyncContractError('invalid_head')
  const head = value as Record<string, unknown>
  if (!Number.isSafeInteger(head.schemaVersion)) throw new SyncContractError('invalid_head')
  if (head.schemaVersion !== SYNC_SCHEMA_VERSION) throw new SyncContractError('unsupported_schema')
  if (Object.keys(head).length !== 3 || typeof head.workspaceId !== 'string' || !uuid.test(head.workspaceId) || typeof head.commitHash !== 'string' || !sha256.test(head.commitHash)) throw new SyncContractError('invalid_head')
  if (head.workspaceId !== expectedWorkspaceId) throw new SyncContractError('workspace_mismatch')
  return { schemaVersion: 1, workspaceId: head.workspaceId, commitHash: head.commitHash }
}
