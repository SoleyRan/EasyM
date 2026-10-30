/**
 * v2 step 5B: a sync diagnostics report the user can copy into a support request. RFC 0 rule:
 * only error codes, ids, counts, sizes and phases. No document names or bodies, no endpoint,
 * username or password, no local paths. Ids are shortened to their first 8 characters.
 */
export interface SyncDiagnosticsInput {
  appVersion: string
  platform: string
  status: { kind: string; code?: string | null; attempt?: number }
  endpoint: string
  interval: number | null
  state: {
    sequence: number
    commitHash: string | null
    applied: string | null
    pending: boolean
    seenDevices: number
    deferred: number
    conflicts: number
    retiring: number
    rebased: boolean
  } | null
  report: {
    published: boolean
    downloaded: number
    conflicts: Record<string, number>
    copies: number
    keptDeletes: number
    restored: number
    deferred: number
    skipped: Record<string, number>
    failed: Record<string, number>
    openConflicts: number
  } | null
  quota: { available: number | null; used: number | null } | null
  devices: number | null
  workspaceId: string
  deviceId: string
  generatedAt: Date
}

const short = (value: string | null | undefined) => (value ? value.replace(/^sha256:/, '').slice(0, 8) : null)

/** Kind of endpoint without revealing it: scheme, and whether it is this machine. */
export function endpointKind(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    return `${url.protocol.replace(':', '')}${local ? ' (本机)' : ''}`
  } catch { return 'invalid' }
}

/** Counts of an error-code list, e.g. failed operations; codes only, never the paths. */
export function tally(codes: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const code of codes) out[safeCode(code)] = (out[safeCode(code)] ?? 0) + 1
  return out
}
/** Error codes are short identifiers; anything else (a message with a path) becomes `other`. */
export function safeCode(code: string | null | undefined): string {
  if (!code) return 'none'
  return /^[a-z_]+(?::\d{3})?$/.test(code) && code.length <= 48 ? code : 'other'
}

export function syncDiagnostics(input: SyncDiagnosticsInput): string {
  const report = {
    schema: 'easym-sync-diagnostics/1',
    generatedAt: input.generatedAt.toISOString(),
    app: { version: input.appVersion, platform: input.platform },
    connection: { endpoint: endpointKind(input.endpoint), workspace: short(input.workspaceId), device: short(input.deviceId), interval: input.interval === null ? 'manual' : `${input.interval / 60_000} min` },
    status: { kind: input.status.kind, code: safeCode(input.status.code), attempt: input.status.attempt ?? null },
    state: input.state && { ...input.state, commitHash: short(input.state.commitHash), applied: short(input.state.applied) },
    lastPass: input.report,
    quota: input.quota,
    devices: input.devices,
  }
  return JSON.stringify(report, null, 2)
}
