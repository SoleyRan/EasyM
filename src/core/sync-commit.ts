import { assetPath } from './images'
import { isSyncHash, isSyncId, MERGE_DEVICE_ID, syncHash, type SyncProvider } from './sync-contract'

/**
 * v2 step 1 commit manifest (schemaVersion 1). Stored as an immutable object addressed by
 * the SHA-256 of its exact bytes; device heads point to it. Not yet connected to the editor.
 */
export const SYNC_COMMIT_SCHEMA_VERSION = 1
export const MAX_SYNC_COMMIT_BYTES = 4 * 1024 * 1024
export const MAX_SYNC_DOCUMENTS = 10_000
export const MAX_SYNC_RESOURCES_PER_DOCUMENT = 1_000
export const MAX_SYNC_TEXT_BYTES = 10 * 1024 * 1024
export const MAX_SYNC_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_SYNC_METADATA_BYTES = 2 * 1024 * 1024

export interface SyncObjectRef { object: string; bytes: number }
/** `path` is relative to the document's directory and must be an EasyM asset path. */
export interface SyncResource extends SyncObjectRef { path: string }
export interface SyncDocumentEntry {
  documentId: string
  /** Workspace-relative, `/`-separated, NFC Markdown path. */
  path: string
  text: SyncObjectRef
  /** Per-document image instance metadata; never a whole directory images.json. */
  imageMetadata: SyncObjectRef | null
  resources: SyncResource[]
}
export interface SyncTombstone { documentId: string; path: string; operationId: string }
export interface SyncCommit {
  schemaVersion: 1
  workspaceId: string
  operationId: string
  deviceId: string
  /** Device commits have at most one parent; merge commits exactly two, sorted ascending. */
  parents: string[]
  documents: SyncDocumentEntry[]
  tombstones: SyncTombstone[]
}

export class SyncCommitError extends Error {
  readonly code: 'invalid_commit' | 'unsupported_schema' | 'workspace_mismatch' | 'hash_mismatch' | 'path_conflict' | 'duplicate_identity' | 'missing_object'
  constructor(code: SyncCommitError['code']) {
    super(code)
    this.code = code
    this.name = 'SyncCommitError'
  }
}
const fail = (code: SyncCommitError['code'] = 'invalid_commit'): never => { throw new SyncCommitError(code) }
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail())
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value)
  if (actual.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) fail()
}
const id = (value: unknown) => (isSyncId(value) ? value : fail())

const windowsReserved = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i
/** Portable across Windows, macOS and Linux: rejects traversal, drive/UNC forms and names Windows cannot store. */
export function isPortableSyncPath(path: unknown, maxBytes = 1024): path is string {
  if (typeof path !== 'string' || path === '' || path.normalize('NFC') !== path || new TextEncoder().encode(path).length > maxBytes) return false
  if (/[\u0000-\u001f\u007f\\:*?"<>|]/.test(path) || path.startsWith('/')) return false
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !windowsReserved.test(part))
}
/** Approximates the case-insensitive comparison used by default Windows/macOS volumes. */
export const syncPathKey = (path: string) => path.normalize('NFC').toLowerCase()

function objectRef(value: unknown, max: number): SyncObjectRef {
  const ref = record(value)
  exactKeys(ref, ['object', 'bytes'])
  if (!isSyncHash(ref.object) || !Number.isSafeInteger(ref.bytes) || (ref.bytes as number) < 0 || (ref.bytes as number) > max) fail()
  return { object: ref.object as string, bytes: ref.bytes as number }
}

function documentEntry(value: unknown): SyncDocumentEntry {
  const entry = record(value)
  exactKeys(entry, ['documentId', 'path', 'text', 'imageMetadata', 'resources'])
  if (!isPortableSyncPath(entry.path) || !/\.(?:md|markdown)$/i.test(entry.path)) fail()
  if (!Array.isArray(entry.resources) || entry.resources.length > MAX_SYNC_RESOURCES_PER_DOCUMENT) fail()
  const seen = new Set<string>()
  let total = 0
  const resources = (entry.resources as unknown[]).map((item) => {
    const resource = record(item)
    exactKeys(resource, ['path', 'object', 'bytes'])
    if (typeof resource.path !== 'string' || !assetPath(resource.path) || seen.has(resource.path.toLowerCase())) fail()
    seen.add((resource.path as string).toLowerCase())
    const ref = objectRef({ object: resource.object, bytes: resource.bytes }, MAX_SYNC_IMAGE_BYTES)
    total += ref.bytes
    return { path: resource.path as string, ...ref }
  })
  // Matches the 1.0 per-document resource budget (128 MiB).
  if (total > 128 * 1024 * 1024) fail()
  return {
    documentId: id(entry.documentId),
    path: entry.path as string,
    text: objectRef(entry.text, MAX_SYNC_TEXT_BYTES),
    imageMetadata: entry.imageMetadata === null ? null : objectRef(entry.imageMetadata, MAX_SYNC_METADATA_BYTES),
    resources,
  }
}
/** Validates untrusted commit bytes. It does not prove referenced objects exist or match. */
export function parseSyncCommit(bytes: Uint8Array, expectedWorkspaceId: string): SyncCommit {
  if (!isSyncId(expectedWorkspaceId) || bytes.byteLength === 0 || bytes.byteLength > MAX_SYNC_COMMIT_BYTES) fail()
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)) }
  catch { return fail() }
  const commit = record(value)
  if (!Number.isSafeInteger(commit.schemaVersion)) fail()
  if (commit.schemaVersion !== SYNC_COMMIT_SCHEMA_VERSION) fail('unsupported_schema')
  exactKeys(commit, ['schemaVersion', 'workspaceId', 'operationId', 'deviceId', 'parents', 'documents', 'tombstones'])
  const workspaceId = id(commit.workspaceId)
  if (workspaceId !== expectedWorkspaceId) fail('workspace_mismatch')
  const deviceId = id(commit.deviceId)
  if (!Array.isArray(commit.parents) || !commit.parents.every(isSyncHash)) fail()
  const parents = commit.parents as string[]
  if (deviceId === MERGE_DEVICE_ID ? parents.length !== 2 || parents[0] >= parents[1] : parents.length > 1) fail()
  if (!Array.isArray(commit.documents) || !Array.isArray(commit.tombstones) || commit.documents.length + commit.tombstones.length > MAX_SYNC_DOCUMENTS) fail()
  const documents = (commit.documents as unknown[]).map(documentEntry)
  const tombstones = (commit.tombstones as unknown[]).map((item) => {
    const tombstone = record(item)
    exactKeys(tombstone, ['documentId', 'path', 'operationId'])
    if (!isPortableSyncPath(tombstone.path)) fail()
    return { documentId: id(tombstone.documentId), path: tombstone.path as string, operationId: id(tombstone.operationId) }
  })
  checkIdentities(documents, tombstones)
  return { schemaVersion: 1, workspaceId, operationId: id(commit.operationId), deviceId, parents, documents, tombstones }
}

function checkIdentities(documents: SyncDocumentEntry[], tombstones: SyncTombstone[]) {
  const ids = new Set<string>(), paths = new Set<string>()
  for (const entry of [...documents, ...tombstones]) {
    if (ids.has(entry.documentId)) fail('duplicate_identity')
    ids.add(entry.documentId)
  }
  // Tombstoned paths may be reused by a new document; live paths must be unique on every platform.
  for (const entry of documents) {
    const key = syncPathKey(entry.path)
    if (paths.has(key)) fail('path_conflict')
    paths.add(key)
  }
}

/** Deterministic encoding with a fixed key order and path-sorted entries; validated before use. */
export function encodeSyncCommit(commit: SyncCommit): Uint8Array {
  const ordered = {
    schemaVersion: SYNC_COMMIT_SCHEMA_VERSION,
    workspaceId: commit.workspaceId,
    operationId: commit.operationId,
    deviceId: commit.deviceId,
    parents: [...commit.parents],
    documents: [...commit.documents].sort(byPath).map((entry) => ({
      documentId: entry.documentId,
      path: entry.path,
      text: { object: entry.text.object, bytes: entry.text.bytes },
      imageMetadata: entry.imageMetadata && { object: entry.imageMetadata.object, bytes: entry.imageMetadata.bytes },
      resources: [...entry.resources].sort(byPath).map((resource) => ({ path: resource.path, object: resource.object, bytes: resource.bytes })),
    })),
    tombstones: [...commit.tombstones].sort(byPath).map((entry) => ({ documentId: entry.documentId, path: entry.path, operationId: entry.operationId })),
  }
  const bytes = new TextEncoder().encode(JSON.stringify(ordered))
  parseSyncCommit(bytes, commit.workspaceId)
  return bytes
}
const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

/** Reads a commit object and checks its bytes against the content address before parsing. */
export async function readSyncCommit(provider: SyncProvider, workspaceId: string, hash: string, signal: AbortSignal): Promise<SyncCommit> {
  if (!isSyncHash(hash)) fail()
  const bytes = await provider.readObject(workspaceId, hash, signal)
  if (!bytes) return fail('missing_object')
  if (bytes.byteLength > MAX_SYNC_COMMIT_BYTES || (await syncHash(bytes)) !== hash) fail('hash_mismatch')
  return parseSyncCommit(bytes, workspaceId)
}
export interface SyncUpload { hash: string; bytes: Uint8Array }
/** RFC budget: at most two object transfers in flight. */
export const MAX_SYNC_PARALLEL_TRANSFERS = 2

export function commitObjects(commit: SyncCommit): Set<string> {
  const hashes = new Set<string>()
  for (const entry of commit.documents) {
    hashes.add(entry.text.object)
    if (entry.imageMetadata) hashes.add(entry.imageMetadata.object)
    for (const resource of entry.resources) hashes.add(resource.object)
  }
  return hashes
}

/**
 * Uploads immutable objects, then the commit object. Objects not uploaded here must be in
 * `existing` (already on the remote, normally the parent's objects), so no published head can
 * reference a missing object. The head is advanced separately (see sync-log.ts).
 */
export async function uploadSyncCommit(provider: SyncProvider, commit: SyncCommit, uploads: SyncUpload[], existing: ReadonlySet<string>, signal: AbortSignal): Promise<string> {
  const bytes = encodeSyncCommit(commit)
  const pending = new Map<string, Uint8Array>()
  for (const upload of uploads) {
    if (!isSyncHash(upload.hash) || (await syncHash(upload.bytes)) !== upload.hash) fail('hash_mismatch')
    pending.set(upload.hash, upload.bytes)
  }
  for (const hash of commitObjects(commit)) if (!pending.has(hash) && !existing.has(hash)) fail('missing_object')
  const queue = [...pending]
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      signal.throwIfAborted()
      await provider.createObject(commit.workspaceId, item[0], item[1], signal)
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_SYNC_PARALLEL_TRANSFERS, queue.length) }, worker))
  const commitHash = await syncHash(bytes)
  signal.throwIfAborted()
  await provider.createObject(commit.workspaceId, commitHash, bytes, signal)
  return commitHash
}
