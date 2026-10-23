/**
 * v2 step 3C: what to do after a failed sync pass. Transient failures (network, busy server, a
 * lost reply) retry with backoff; anything that needs the user (credentials, certificates, a
 * rolled-back or cloned remote, damaged data, quota) pauses until they act. Unknown errors are
 * treated as needing action: stopping is safer than retrying something not understood.
 */
export type SyncFailure = { kind: 'retry'; code: string } | { kind: 'action'; code: string }

const RETRY = new Set(['timeout', 'connect_failed', 'transport_failed', 'unknown_outcome', 'scan_incomplete', 'revision_conflict'])

export function syncErrorCode(error: unknown): string {
  if (error instanceof Error) return (error as { code?: string }).code ?? error.message
  return String(error)
}

export function classifySyncError(error: unknown): SyncFailure {
  const code = syncErrorCode(error)
  if (RETRY.has(code) || code.startsWith('server_busy')) return { kind: 'retry', code }
  // 5xx other than the busy family: the server failed, not the request.
  const status = /^unexpected_status:(\d+)$/.exec(code)
  if (status && Number(status[1]) >= 500) return { kind: 'retry', code }
  return { kind: 'action', code }
}

/** Backoff after `attempt` consecutive transient failures (1-based): 10 s, 30 s, 2 min, then 10 min. */
export function retryDelay(attempt: number): number {
  return [10_000, 30_000, 120_000][Math.max(0, attempt - 1)] ?? 600_000
}

/** Interval between automatic passes while healthy. */
export const SYNC_INTERVAL = 60_000
