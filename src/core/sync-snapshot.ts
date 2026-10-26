import { assetPath, type ImageInstance } from './images'
import { linkUrls } from './link-rewrite'
import { isPortableSyncPath, syncPathKey, type SyncCommit, type SyncDocumentEntry, type SyncUpload } from './sync-commit'
import { syncHash } from './sync-contract'
import type { WorkspaceIdentity } from './sync-identity'

/**
 * v2 step 3B: local workspace ↔ commit snapshot. Pure functions; I/O is injected.
 * Three invariants:
 *  - a tracked document that is missing on disk is carried forward, never treated as deleted;
 *  - a local file is only overwritten when its bytes are unchanged since the last apply or are
 *    preserved elsewhere in the target snapshot;
 *  - when a remote edit meets an unsynchronized local edit, both are kept.
 */
export interface LocalDocument {
  path: string
  bytes: Uint8Array
  /** Image instances of the document's directory `images.json`; null when it is unreadable. */
  instances: ImageInstance[] | null
}

/** JSON with recursively sorted keys, so equal metadata always has equal bytes and hash. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value ?? null)
}

/** EasyM-managed images a document body references (links, images and definitions; code excluded). */
export function managedReferences(bytes: Uint8Array): string[] {
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { return [] }
  const found = new Set<string>()
  for (const url of linkUrls(text)) {
    let path: string
    try { path = decodeURIComponent(url.split(/[?#]/)[0]).replace(/^\.\//, '') } catch { continue }
    if (assetPath(path)) found.add(path)
  }
  return [...found].sort()
}

/** Per-document metadata object: only instances the body references, with no process-local ids. */
export function documentMetadata(instances: ImageInstance[] | null, references: string[]): Uint8Array | null {
  if (!instances) return null
  const wanted = new Set(references)
  const picked = instances.filter((i) => wanted.has(i.displayPath)).map((i) => ({ ...i, documentId: null })).sort((a, b) => (a.displayPath < b.displayPath ? -1 : 1))
  return picked.length ? new TextEncoder().encode(canonicalJson({ schemaVersion: 1, instances: picked })) : null
}

export interface BuiltEntry { entry: SyncDocumentEntry; uploads: SyncUpload[]; missingAssets: string[] }

/** Builds a commit entry from local bytes. Missing referenced images are reported, not invented. */
export async function buildEntry(documentId: string, doc: LocalDocument, readAsset: (assetPath: string) => Promise<Uint8Array | null>): Promise<BuiltEntry> {
  const uploads: SyncUpload[] = [], missingAssets: string[] = []
  const add = async (bytes: Uint8Array) => { const hash = await syncHash(bytes); uploads.push({ hash, bytes }); return { object: hash, bytes: bytes.byteLength } }
  const text = await add(doc.bytes)
  const references = managedReferences(doc.bytes)
  const metadataBytes = documentMetadata(doc.instances, references)
  const imageMetadata = metadataBytes ? await add(metadataBytes) : null
  const paths = new Set(references)
  for (const instance of doc.instances ?? []) if (paths.has(instance.displayPath) && assetPath(instance.sourcePath)) paths.add(instance.sourcePath)
  const resources = []
  for (const path of [...paths].sort()) {
    const bytes = await readAsset(path)
    if (bytes) resources.push({ path, ...(await add(bytes)) }); else missingAssets.push(path)
  }
  return { entry: { documentId, path: doc.path, text, imageMetadata, resources }, uploads, missingAssets }
}

const entryView = (e: SyncDocumentEntry) => [e.documentId, e.path, e.text.object, e.imageMetadata?.object ?? null, e.resources.map((r) => [r.path, r.object])]
export const snapshotView = (c: Pick<SyncCommit, 'documents' | 'tombstones'>) => JSON.stringify([
  [...c.documents].sort((a, b) => (a.documentId < b.documentId ? -1 : 1)).map(entryView),
  [...c.tombstones].sort((a, b) => (a.documentId < b.documentId ? -1 : 1)).map((t) => [t.documentId, t.path, t.operationId]),
])
export interface LocalChangeInput {
  workspaceId: string
  deviceId: string
  operationId: string
  identity: WorkspaceIdentity
  /** Snapshot this device last converged to (null before the first sync). */
  base: SyncCommit | null
  /** Hash of `base`, used as the only parent. */
  baseHash: string | null
  /** Markdown files read this pass, keyed by path. */
  disk: ReadonlyMap<string, LocalDocument>
  /**
   * Paths a complete scan found whose bytes equal the base entry (same revision and path); their
   * base entry is reused without reading the file. Image files are immutable and versioned by
   * name, so an unchanged body references unchanged images.
   */
  unchanged?: ReadonlySet<string>
  /** documentIds whose remote deletion is still pending locally (document was open); never republished. */
  withheld?: ReadonlySet<string>
  /**
   * Documents the user deleted in EasyM (in-app trash): documentId → body revision at deletion.
   * Only a base entry still at that revision becomes a tombstone; a newer remote edit is kept.
   */
  deleted: ReadonlyMap<string, string>
  readAsset(directory: string, assetPath: string): Promise<Uint8Array | null>
}
export interface LocalChange {
  /** Null when the workspace matches `base` (nothing to publish). */
  commit: SyncCommit | null
  uploads: SyncUpload[]
  /** Documents carried forward unchanged because their file is missing and not confirmed deleted. */
  carried: string[]
  /** Documents not published this pass (unportable path or missing referenced images). */
  skipped: { path: string; reason: 'missing_assets' | 'unportable_path' }[]
}

const directoryOf = (path: string) => path.split('/').slice(0, -1).join('/')

/** Builds this device's next commit from disk, the identity file and the last converged snapshot. */
export async function localChange(input: LocalChangeInput): Promise<LocalChange> {
  const previous = new Map((input.base?.documents ?? []).map((e) => [e.documentId, e]))
  const tombstones = new Map((input.base?.tombstones ?? []).map((t) => [t.documentId, t]))
  const documents: SyncDocumentEntry[] = [], uploads: SyncUpload[] = [], carried: string[] = [], skipped: LocalChange['skipped'] = []
  for (const item of input.identity.documents) {
    const doc = input.disk.get(item.path), before = previous.get(item.documentId)
    // Base already holds the remote tombstone; local edits are not published until the tab closes.
    if (input.withheld?.has(item.documentId)) continue
    if (!doc && before && before.path === item.path && input.unchanged?.has(item.path)) { tombstones.delete(item.documentId); documents.push(before); continue }
    if (!doc) {
      if (before && input.deleted.get(item.documentId) === before.text.object) { tombstones.set(item.documentId, { documentId: item.documentId, path: before.path, operationId: input.operationId }); continue }
      if (before) { documents.push(before); carried.push(item.path) }
      continue
    }
    if (!isPortableSyncPath(item.path)) { skipped.push({ path: item.path, reason: 'unportable_path' }); if (before) documents.push(before); continue }
    const built = await buildEntry(item.documentId, doc, (asset) => input.readAsset(directoryOf(item.path), asset))
    if (built.missingAssets.length) { skipped.push({ path: item.path, reason: 'missing_assets' }); if (before) documents.push(before); continue }
    tombstones.delete(item.documentId)
    documents.push(built.entry); uploads.push(...built.uploads)
  }
  // Documents the base knows but the identity no longer tracks stay as they were (step 2 trash
  // removes identity entries; only an explicit `deleted` turns them into tombstones).
  const tracked = new Set(input.identity.documents.map((d) => d.documentId))
  for (const [id, before] of previous) {
    if (tracked.has(id)) continue
    if (input.deleted.get(id) === before.text.object) tombstones.set(id, { documentId: id, path: before.path, operationId: input.operationId })
    else documents.push(before)
  }
  const next = { documents: documents.sort((a, b) => (a.documentId < b.documentId ? -1 : 1)), tombstones: [...tombstones.values()].sort((a, b) => (a.documentId < b.documentId ? -1 : 1)) }
  if (input.base && snapshotView(next) === snapshotView(input.base)) return { commit: null, uploads: [], carried, skipped }
  if (!input.base && !next.documents.length && !next.tombstones.length) return { commit: null, uploads: [], carried, skipped }
  const commit: SyncCommit = { schemaVersion: 1, workspaceId: input.workspaceId, operationId: input.operationId, deviceId: input.deviceId, parents: input.baseHash ? [input.baseHash] : [], ...next }
  // Objects already referenced by the base are on the remote; upload only new ones, once each.
  const known = new Set<string>()
  for (const e of input.base?.documents ?? []) { known.add(e.text.object); if (e.imageMetadata) known.add(e.imageMetadata.object); for (const r of e.resources) known.add(r.object) }
  const fresh = new Map(uploads.filter((u) => !known.has(u.hash)).map((u) => [u.hash, u]))
  return { commit, uploads: [...fresh.values()], carried, skipped }
}
export type ApplyOp =
  | { kind: 'trash'; documentId: string; path: string; expected: string }
  | { kind: 'move'; documentId: string; from: string; to: string; expected: string; references: string[] }
  /** `expected` null creates a new file (never overwriting); otherwise the file must still hold that revision. */
  | { kind: 'write'; documentId: string; path: string; expected: string | null; entry: SyncDocumentEntry; copy: boolean }
export interface ApplyPlan {
  ops: ApplyOp[]
  /** Remote versions written beside an unsynchronized local edit. */
  conflicts: { documentId: string; path: string; copy: string }[]
  /** Remote deletions not applied because the local document changed (edit beats delete). */
  keptDeletes: string[]
  /** Locally trashed documents recreated because the remote edited them afterwards. */
  restored: string[]
  /** Remote deletions of documents open in a tab: applied once the tab is closed. */
  deferred: { documentId: string; path: string; revision: string }[]
}
export interface ApplyInput {
  target: SyncCommit
  /** Snapshot the scanned disk reflected (last applied, or this pass's local commit). */
  base: SyncCommit | null
  identity: WorkspaceIdentity
  /** Complete scan: path → revision (`sha256:` of the raw bytes). */
  disk: ReadonlyMap<string, string>
  /** Paths open with unsaved editor changes; treated as locally changed. */
  dirty: ReadonlySet<string>
  /** Paths open in a tab (dirty or not); their deletion is deferred instead of applied. */
  open?: ReadonlySet<string>
  /** Same map as LocalChangeInput.deleted: a pending local deletion is not recreated. */
  deleted: ReadonlyMap<string, string>
  /** Deterministic id of the conflict copy of `documentId` at remote body `object`, so a retried apply finds it again. */
  copyId(documentId: string, object: string): string
}

const contentKey = (e: SyncDocumentEntry) => JSON.stringify([e.text.object, e.imageMetadata?.object ?? null, e.resources.map((r) => [r.path, r.object]).sort()])
function alternatePath(path: string, n: number): string {
  const slash = path.lastIndexOf('/'), dir = path.slice(0, slash + 1), name = path.slice(slash + 1)
  const ext = /\.(?:md|markdown)$/i.exec(name)?.[0] ?? '.md'
  const candidate = `${dir}${name.slice(0, name.length - ext.length)} (同步副本${n > 1 ? ` ${n}` : ''})${ext}`
  return isPortableSyncPath(candidate) ? candidate : `${dir}同步副本-${n}.md`
}

/**
 * Plans how the converged snapshot lands on disk. Overwrites, moves and deletions only touch
 * files still at their base revision; a document that also changed locally keeps the local
 * file in place and receives the remote version as a separate copy.
 */
export function planApply(input: ApplyInput): ApplyPlan {
  const localPath = new Map(input.identity.documents.map((d) => [d.documentId, d.path]))
  const base = new Map((input.base?.documents ?? []).map((e) => [e.documentId, e]))
  // Paths on disk and paths the identity tracks (a tracked file may be missing) are both taken.
  const occupied = new Set([...input.disk.keys(), ...input.identity.documents.map((d) => d.path)].map(syncPathKey))
  const free = (path: string) => { if (!occupied.has(syncPathKey(path))) return path; for (let n = 1; ; n++) { const next = alternatePath(path, n); if (!occupied.has(syncPathKey(next))) return next } }
  const changedLocally = (path: string, before: SyncDocumentEntry | undefined) => input.dirty.has(path) || !before || input.disk.get(path) !== before.text.object
  const trashes: ApplyOp[] = [], moves: ApplyOp[] = [], writes: ApplyOp[] = []
  const plan: ApplyPlan = { ops: [], conflicts: [], keptDeletes: [], restored: [], deferred: [] }

  for (const tomb of input.target.tombstones) {
    const path = localPath.get(tomb.documentId)
    if (!path || !input.disk.has(path)) continue
    if (changedLocally(path, base.get(tomb.documentId))) { plan.keptDeletes.push(path); continue }
    if (input.open?.has(path)) { plan.deferred.push({ documentId: tomb.documentId, path, revision: input.disk.get(path)! }); continue }
    trashes.push({ kind: 'trash', documentId: tomb.documentId, path, expected: input.disk.get(path)! })
    occupied.delete(syncPathKey(path))
  }
  for (const target of input.target.documents) {
    const before = base.get(target.documentId), path = localPath.get(target.documentId)
    if (before && contentKey(before) === contentKey(target) && before.path === target.path && path === target.path) continue
    const revision = path ? input.disk.get(path) : undefined
    if (path && revision !== undefined) {
      if (changedLocally(path, before)) {
        if (revision === target.text.object && path === target.path) continue
        const documentId = input.copyId(target.documentId, target.text.object)
        // Registered by an interrupted earlier apply: finish the file if needed, never duplicate.
        const registered = localPath.get(documentId)
        if (registered !== undefined) {
          if (!input.disk.has(registered)) writes.push({ kind: 'write', documentId, path: registered, expected: null, entry: { ...target, documentId, path: registered }, copy: true })
          continue
        }
        const copy = free(target.path)
        occupied.add(syncPathKey(copy))
        writes.push({ kind: 'write', documentId, path: copy, expected: null, entry: { ...target, documentId, path: copy }, copy: true })
        plan.conflicts.push({ documentId: target.documentId, path, copy })
        continue
      }
      let current = path
      if (target.path !== path) {
        occupied.delete(syncPathKey(path))
        current = free(target.path)
        occupied.add(syncPathKey(current))
        moves.push({ kind: 'move', documentId: target.documentId, from: path, to: current, expected: revision, references: (before ?? target).resources.map((r) => r.path) })
      }
      if (!before || contentKey(before) !== contentKey(target) || revision !== target.text.object) {
        writes.push({ kind: 'write', documentId: target.documentId, path: current, expected: revision, entry: { ...target, path: current }, copy: false })
      }
      continue
    }
    // New here, or tracked but missing locally (a missing file is never a deletion): create.
    // A pending local deletion of this exact version is not undone; a newer remote edit is.
    const trashed = input.deleted.get(target.documentId)
    if (!path && trashed === target.text.object) continue
    if (!path && trashed !== undefined) plan.restored.push(target.path)
    // A tracked-but-missing document returns to its own path; a later pass moves it if renamed.
    const dest = path ?? free(target.path)
    occupied.add(syncPathKey(dest))
    writes.push({ kind: 'write', documentId: target.documentId, path: dest, expected: null, entry: { ...target, path: dest }, copy: false })
  }
  plan.ops = [...trashes, ...moves, ...writes]
  return plan
}

/**
 * Joining with explicit user consent: a local document at the same (case-folded) path as a remote
 * document, under a different id, takes the remote id. Same bytes then need no transfer; different
 * bytes keep both versions through the normal conflict copy. The previous local id is kept as the
 * history mapping so local version history still resolves. Never matches by content.
 */
export function linkSameNamed(identity: WorkspaceIdentity, remote: Pick<SyncCommit, 'documents'>[]): { identity: WorkspaceIdentity; linked: string[] } {
  const remoteByPath = new Map<string, SyncDocumentEntry>()
  for (const commit of remote) for (const entry of commit.documents) remoteByPath.set(syncPathKey(entry.path), entry)
  const usedIds = new Set(identity.documents.map((d) => d.documentId))
  const linked: string[] = []
  const documents = identity.documents.map((doc) => {
    const match = remoteByPath.get(syncPathKey(doc.path))
    if (!match || match.documentId === doc.documentId || usedIds.has(match.documentId)) return doc
    usedIds.add(match.documentId)
    linked.push(doc.path)
    const historyId = doc.historyId ?? doc.documentId
    return historyId === match.documentId ? { documentId: match.documentId, path: doc.path } : { documentId: match.documentId, path: doc.path, historyId }
  })
  return { identity: { ...identity, documents }, linked }
}

export interface JoinPreview { download: number; upload: number; collisions: string[] }
/** First pairing with an existing remote workspace: what will be fetched, sent and renamed. */
export function previewJoin(remote: Pick<SyncCommit, 'documents'>[], identity: WorkspaceIdentity): JoinPreview {
  const remoteDocs = new Map<string, SyncDocumentEntry>()
  for (const commit of remote) for (const entry of commit.documents) remoteDocs.set(entry.documentId, entry)
  const localIds = new Set(identity.documents.map((d) => d.documentId))
  const localPaths = new Map(identity.documents.map((d) => [syncPathKey(d.path), d]))
  const collisions = [...remoteDocs.values()].filter((e) => !localIds.has(e.documentId) && localPaths.has(syncPathKey(e.path))).map((e) => e.path).sort()
  return { download: [...remoteDocs.keys()].filter((id) => !localIds.has(id)).length, upload: identity.documents.filter((d) => !remoteDocs.has(d.documentId)).length, collisions }
}
