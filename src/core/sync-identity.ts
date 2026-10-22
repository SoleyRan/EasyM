import { isPortableSyncPath, syncPathKey } from './sync-commit'
import { isSyncId } from './sync-contract'

/**
 * v2 step 2A: persistent workspace/document identity stored at
 * `<workspace>/.easym/sync/workspace.json`. Paths only locate documents; documentIds are
 * the identity. Nothing here reads content: identity is never inferred from bytes.
 */
export const WORKSPACE_IDENTITY_SCHEMA_VERSION = 1
export const MAX_IDENTITY_DOCUMENTS = 10_000
export const MAX_IDENTITY_BYTES = 4 * 1024 * 1024

export interface IdentityDocument {
  documentId: string
  /** Workspace-relative, `/`-separated, NFC path. */
  path: string
  /**
   * Local history documentId when it differs from the sync identity (for example after a backup
   * restore duplicated it). Old snapshots keep their own identity; only this mapping links them.
   */
  historyId?: string
}
export interface WorkspaceIdentity {
  schemaVersion: 1
  workspaceId: string
  documents: IdentityDocument[]
}

export class IdentityError extends Error {
  readonly code: 'invalid_identity' | 'unsupported_schema' | 'duplicate_identity' | 'path_conflict'
  constructor(code: IdentityError['code']) {
    super(code)
    this.code = code
    this.name = 'IdentityError'
  }
}
const fail = (code: IdentityError['code'] = 'invalid_identity'): never => { throw new IdentityError(code) }

export const isMarkdownPath = (path: string) => /\.(?:md|markdown)$/i.test(path)

/** Validates untrusted identity bytes. Rejects anything ambiguous instead of repairing it. */
export function parseWorkspaceIdentity(bytes: Uint8Array): WorkspaceIdentity {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IDENTITY_BYTES) fail()
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)) }
  catch { return fail() }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  const root = value as Record<string, unknown>
  if (!Number.isSafeInteger(root.schemaVersion)) fail()
  if (root.schemaVersion !== WORKSPACE_IDENTITY_SCHEMA_VERSION) fail('unsupported_schema')
  if (Object.keys(root).length !== 3 || !isSyncId(root.workspaceId) || !Array.isArray(root.documents) || root.documents.length > MAX_IDENTITY_DOCUMENTS) fail()
  const documents = (root.documents as unknown[]).map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return fail()
    const entry = item as Record<string, unknown>
    const keys = Object.keys(entry)
    if (!keys.every((key) => ['documentId', 'path', 'historyId'].includes(key)) || !isSyncId(entry.documentId) || !isPortableSyncPath(entry.path) || !isMarkdownPath(entry.path as string)) fail()
    if ('historyId' in entry && (!isSyncId(entry.historyId) || entry.historyId === entry.documentId)) fail()
    const document: IdentityDocument = { documentId: entry.documentId as string, path: entry.path as string }
    if (entry.historyId) document.historyId = entry.historyId as string
    return document
  })
  checkUnique(documents)
  return { schemaVersion: 1, workspaceId: root.workspaceId as string, documents }
}

function checkUnique(documents: IdentityDocument[]) {
  const ids = new Set<string>(), paths = new Set<string>()
  for (const doc of documents) {
    if (ids.has(doc.documentId)) fail('duplicate_identity')
    ids.add(doc.documentId)
    const key = syncPathKey(doc.path)
    if (paths.has(key)) fail('path_conflict')
    paths.add(key)
  }
}

/** Deterministic, path-sorted encoding; validated before it is returned. */
export function encodeWorkspaceIdentity(identity: WorkspaceIdentity): Uint8Array {
  const documents = [...identity.documents].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((doc) => (doc.historyId ? { documentId: doc.documentId, path: doc.path, historyId: doc.historyId } : { documentId: doc.documentId, path: doc.path }))
  const bytes = new TextEncoder().encode(JSON.stringify({ schemaVersion: WORKSPACE_IDENTITY_SCHEMA_VERSION, workspaceId: identity.workspaceId, documents }, null, 2) + '\n')
  parseWorkspaceIdentity(bytes)
  return bytes
}
/** One Markdown file found by a complete native scan. A partial scan must never reach here. */
export interface DiskDocument {
  path: string
  /** documentId from the directory's history index, read through the native history service. */
  historyId: string | null
  /** The directory's history index exists but could not be read or validated. */
  historyUnreadable?: boolean
}

export type PauseReason =
  /** Differs from another path only by case/normalization; cannot exist on every platform. */
  | 'path_conflict'
  /** Not storable on Windows/macOS/Linux alike (reserved name, trailing dot, control character…). */
  | 'unportable_path'
  /** The same history documentId appears for several files (e.g. a copied directory). */
  | 'duplicate_history_id'
  /** The history index could not be verified, so a reusable identity cannot be confirmed. */
  | 'history_unreadable'
  /** Untracked while tracked documents are missing: may be an external move or rename. */
  | 'possible_move'

export interface ReconcilePlan {
  /** Proposed identity with only unambiguous changes applied. */
  identity: WorkspaceIdentity
  /** Newly tracked in this plan. `reusedHistory` marks identities adopted from local history. */
  added: (IdentityDocument & { reusedHistory: boolean })[]
  /** Tracked documents whose path is absent. They stay tracked until explicitly resolved. */
  missing: IdentityDocument[]
  /** Untracked files that need a decision before they get an identity. */
  paused: { path: string; reason: PauseReason; historyId: string | null }[]
  changed: boolean
}

/**
 * Compares the identity with a complete scan. Same path keeps identity; nothing is matched by
 * content; ambiguous files are paused, never guessed. Missing documents are reported, not dropped.
 */
export function reconcileIdentity(current: WorkspaceIdentity | null, disk: DiskDocument[], newWorkspaceId: () => string, newDocumentId: () => string): ReconcilePlan {
  const identity: WorkspaceIdentity = current ? { ...current, documents: [...current.documents] } : { schemaVersion: 1, workspaceId: newWorkspaceId(), documents: [] }
  const tracked = new Map(identity.documents.map((doc) => [doc.path, doc]))
  const present = new Set(disk.map((doc) => doc.path))
  const missing = identity.documents.filter((doc) => !present.has(doc.path))
  const paused: ReconcilePlan['paused'] = [], added: ReconcilePlan['added'] = []

  // Case/normalization collisions are judged across every present path, tracked or not.
  const byKey = new Map<string, string[]>()
  for (const doc of disk) byKey.set(syncPathKey(doc.path), [...(byKey.get(syncPathKey(doc.path)) ?? []), doc.path])
  const historyUse = new Map<string, number>()
  for (const doc of disk) if (doc.historyId) historyUse.set(doc.historyId, (historyUse.get(doc.historyId) ?? 0) + 1)
  const usedIds = new Set(identity.documents.map((doc) => doc.documentId))

  const untracked = [...disk].filter((doc) => !tracked.has(doc.path)).sort((a, b) => (a.path < b.path ? -1 : 1))
  for (const doc of untracked) {
    const pause = (reason: PauseReason) => paused.push({ path: doc.path, reason, historyId: doc.historyId })
    if (!isPortableSyncPath(doc.path) || !isMarkdownPath(doc.path)) { pause('unportable_path'); continue }
    if ((byKey.get(syncPathKey(doc.path)) ?? []).length > 1) { pause('path_conflict'); continue }
    if (doc.historyUnreadable) { pause('history_unreadable'); continue }
    const historyId = doc.historyId && isSyncId(doc.historyId) ? doc.historyId : null
    if (historyId && ((historyUse.get(historyId) ?? 0) > 1 || usedIds.has(historyId))) { pause('duplicate_history_id'); continue }
    if (missing.length) { pause('possible_move'); continue }
    const documentId = historyId ?? newDocumentId()
    usedIds.add(documentId)
    const entry = { documentId, path: doc.path }
    identity.documents.push(entry)
    added.push({ ...entry, reusedHistory: historyId !== null })
  }
  checkUnique(identity.documents)
  return { identity, added, missing, paused, changed: !current || added.length > 0 }
}

export type IdentityResolution =
  /** Treat an untracked file as the moved/renamed version of a missing document. */
  | { kind: 'bind'; path: string; documentId: string }
  /** Give an untracked file a new identity, mapping its local history id when it has one. */
  | { kind: 'assign'; path: string }
  /** Confirm that a missing document was deleted outside EasyM. */
  | { kind: 'forget'; documentId: string }

/** Applies explicit user decisions on top of a fresh plan. Unsafe choices are rejected. */
export function resolveIdentity(plan: ReconcilePlan, resolutions: IdentityResolution[], newDocumentId: () => string): WorkspaceIdentity {
  const documents = [...plan.identity.documents]
  const missing = new Map(plan.missing.map((doc) => [doc.documentId, doc]))
  const paused = new Map(plan.paused.map((item) => [item.path, item]))
  const resolvable = (path: string) => {
    const item = paused.get(path)
    if (!item || !['possible_move', 'duplicate_history_id'].includes(item.reason)) fail()
    paused.delete(path)
    return item as NonNullable<typeof item>
  }
  for (const resolution of resolutions) {
    if (resolution.kind === 'forget') {
      if (!missing.delete(resolution.documentId)) fail()
      documents.splice(documents.findIndex((doc) => doc.documentId === resolution.documentId), 1)
    } else if (resolution.kind === 'bind') {
      const item = resolvable(resolution.path), target = missing.get(resolution.documentId)
      if (!target || item.reason !== 'possible_move') fail()
      missing.delete(resolution.documentId)
      const index = documents.findIndex((doc) => doc.documentId === resolution.documentId)
      documents[index] = { ...documents[index], path: resolution.path }
    } else {
      const item = resolvable(resolution.path)
      const documentId = newDocumentId()
      documents.push(item.historyId && isSyncId(item.historyId) ? { documentId, path: item.path, historyId: item.historyId } : { documentId, path: item.path })
    }
  }
  checkUnique(documents)
  return { ...plan.identity, documents }
}
