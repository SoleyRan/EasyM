import { readSyncCommit, type SyncCommit, type SyncDocumentEntry } from './sync-commit'
import { syncHash, type SyncProvider } from './sync-contract'
import type { WorkspaceIdentity } from './sync-identity'
import { initialDeviceState, runSyncPass, settleSyncPending, type SyncConflict, type SyncDeviceState } from './sync-log'
import { localChange, planApply, type ApplyOp, type LocalDocument } from './sync-snapshot'
import type { ImageInstance } from './images'

/**
 * v2 step 3B: one complete sync pass for a bound workspace. The engine owns ordering; the host
 * supplies local I/O. Invariants, in order of priority:
 *  1. Before building a local change, disk is brought to this device's published head, so a
 *     local commit never silently reverts remote changes that did not reach disk earlier.
 *  2. Identity entries for documents created from the remote are written before their files,
 *     so an interrupted apply is recognised on retry instead of producing duplicates.
 *  3. Local writes reuse the journaled save with an expected revision; a concurrent edit makes
 *     the write fail and the next pass treats the file as locally changed.
 */
export interface EngineState {
  device: SyncDeviceState
  /** Commit the disk last fully reflected; null before the first apply. */
  applied: string | null
  /** Remote deletions of documents open in a tab, applied once the tab closes. */
  deferred: { documentId: string; path: string; revision: string }[]
}
export interface LocalScanDocument { path: string; revision: string; historyId: string | null; historyUnreadable?: boolean }
/** `identityRevision` is the digest of the identity file's raw bytes (opaque write precondition). */
export interface LocalScan { identity: WorkspaceIdentity | null; identityRevision: string | null; documents: LocalScanDocument[] }

export interface SyncHost {
  workspaceId: string
  deviceId: string
  scan(): Promise<LocalScan>
  read(path: string): Promise<LocalDocument & { revision: string }>
  /** Writes the identity file only if it still has `expected` (digest of its raw bytes). */
  readAsset(directory: string, asset: string): Promise<Uint8Array | null>
  /** Paths open in a tab, and the subset with unsaved edits. */
  open(): Promise<{ open: Set<string>; dirty: Set<string> }>
  /** documentId → body revision at deletion, for documents in the in-app trash. */
  trashed(): Promise<Map<string, string>>
  writeIdentity(next: WorkspaceIdentity, expected: string | null): Promise<void>
  write(op: { operationId: string; path: string; expected: string | null; bytes: Uint8Array; assets: { path: string; bytes: Uint8Array }[]; instances: ImageInstance[] }): Promise<void>
  move(op: { operationId: string; from: string; to: string; expected: string; references: string[] }): Promise<void>
  trash(op: { operationId: string; path: string; expected: string }): Promise<void>
  loadState(): Promise<EngineState | null>
  saveState(state: EngineState): Promise<void>
  newId(): string
}

export interface PassReport {
  published: boolean
  commitHash: string | null
  downloaded: number
  conflicts: SyncConflict[]
  copies: { path: string; copy: string }[]
  keptDeletes: string[]
  restored: string[]
  deferred: string[]
  /** Local documents not published (missing images or unportable path). */
  skipped: { path: string; reason: string }[]
  /** Operations that failed this pass; retried next time with fresh revisions. */
  failed: { path: string; error: string }[]
}

export class SyncEngineError extends Error {
  readonly code: 'identity_missing' | 'identity_mismatch' | 'identity_paused'
  constructor(code: SyncEngineError['code']) { super(code); this.code = code; this.name = 'SyncEngineError' }
}

/**
 * Trash entries as seen by the snapshot functions: a locally trashed document is matched against
 * its version in `base` (what was synced), not the bytes at deletion, so an edit made just before
 * deleting still deletes. Entries unknown to `base` get a value no remote body can equal, so a
 * remote edit of them is restored (edit beats delete).
 */
function trashAgainst(trashed: Map<string, string>, base: SyncCommit | null): Map<string, string> {
  const objects = new Map((base?.documents ?? []).map((e) => [e.documentId, e.text.object]))
  return new Map([...trashed.keys()].map((id) => [id, objects.get(id) ?? 'deleted']))
}
const errorCode = (error: unknown) => error instanceof Error ? ((error as { code?: string }).code ?? error.message) : String(error)

/** Copies get a stable id derived from the original and the remote body, so retries reuse it. */
export async function conflictCopyId(documentId: string, object: string): Promise<string> {
  const hex = (await syncHash(new TextEncoder().encode(`easym-copy:${documentId}:${object}`))).slice(7)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${['8', '9', 'a', 'b'][parseInt(hex[16], 16) % 4]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
/**
 * Registers documents that appeared on disk without identity, but only unambiguous ones: an
 * unused history id is adopted, a shared or unreadable history pauses the document (step 2A
 * rules); anything ambiguous is left for the identity dialog and simply not published yet.
 */
function adoptNewDocuments(identity: WorkspaceIdentity, scan: LocalScan, newId: () => string): WorkspaceIdentity | null {
  const tracked = new Set(identity.documents.map((d) => d.path.normalize('NFC').toLowerCase()))
  const historyOwners = new Map<string, number>()
  for (const doc of scan.documents) if (doc.historyId) historyOwners.set(doc.historyId, (historyOwners.get(doc.historyId) ?? 0) + 1)
  const usedHistory = new Set(identity.documents.flatMap((d) => (d.historyId ? [d.historyId] : [])))
  const added = []
  for (const doc of scan.documents) {
    if (tracked.has(doc.path.normalize('NFC').toLowerCase()) || doc.historyUnreadable) continue
    if (doc.historyId && ((historyOwners.get(doc.historyId) ?? 0) > 1 || usedHistory.has(doc.historyId))) continue
    added.push(doc.historyId ? { documentId: newId(), path: doc.path, historyId: doc.historyId } : { documentId: newId(), path: doc.path })
    tracked.add(doc.path.normalize('NFC').toLowerCase())
  }
  return added.length ? { ...identity, documents: [...identity.documents, ...added].sort((a, b) => (a.path < b.path ? -1 : 1)) } : null
}

export class SyncEngine {
  constructor(private readonly provider: SyncProvider, private readonly host: SyncHost) {}

  private async commit(hash: string | null, signal: AbortSignal): Promise<SyncCommit | null> {
    return hash ? readSyncCommit(this.provider, this.host.workspaceId, hash, signal) : null
  }

  /**
   * Lands `target` on disk relative to `base`. Returns false when anything failed, so the caller
   * keeps the previous `applied` commit and retries next pass.
   */
  private async apply(target: SyncCommit, base: SyncCommit | null, state: EngineState, report: PassReport, signal: AbortSignal): Promise<boolean> {
    const scan = await this.host.scan()
    let identity = scan.identity
    if (!identity) throw new SyncEngineError('identity_missing')
    const { open, dirty } = await this.host.open()
    const trashed = await this.host.trashed()
    const deleted = trashAgainst(trashed, base)
    const copyIds = new Map<string, string>()
    for (const entry of target.documents) copyIds.set(`${entry.documentId}:${entry.text.object}`, await conflictCopyId(entry.documentId, entry.text.object))
    const plan = planApply({
      target, base, identity, open, dirty, deleted,
      disk: new Map(scan.documents.map((d) => [d.path, d.revision])),
      copyId: (documentId, object) => copyIds.get(`${documentId}:${object}`) as string,
    })
    report.copies.push(...plan.conflicts.map((c) => ({ path: c.path, copy: c.copy })))
    report.keptDeletes.push(...plan.keptDeletes); report.restored.push(...plan.restored)
    for (const item of plan.deferred) if (!state.deferred.some((d) => d.documentId === item.documentId)) state.deferred.push(item)
    report.deferred.push(...state.deferred.map((d) => d.path))

    // Register identities of documents about to be created before writing their files.
    const creates = plan.ops.filter((op): op is Extract<ApplyOp, { kind: 'write' }> => op.kind === 'write' && op.expected === null)
    // Trash and move update identity themselves (step 2); only new entries are written here.
    const known = new Set(identity.documents.map((d) => d.documentId))
    const fresh = creates.filter((op) => !known.has(op.documentId)).map((op) => ({ documentId: op.documentId, path: op.path }))
    if (fresh.length) {
      const withCreates = { ...identity, documents: [...identity.documents, ...fresh].sort((a, b) => (a.path < b.path ? -1 : 1)) }
      await this.host.writeIdentity(withCreates, scan.identityRevision)
      identity = withCreates
    }

    let ok = true
    for (const op of plan.ops) {
      signal.throwIfAborted()
      const operationId = this.host.newId()
      try {
        if (op.kind === 'trash') await this.host.trash({ operationId, path: op.path, expected: op.expected })
        else if (op.kind === 'move') await this.host.move({ operationId, from: op.from, to: op.to, expected: op.expected, references: op.references })
        else {
          const { bytes, assets, instances } = await this.materialize(op.entry, signal)
          await this.host.write({ operationId, path: op.path, expected: op.expected, bytes, assets, instances })
          if (op.expected === null) report.downloaded++
        }
      } catch (error) {
        ok = false
        report.failed.push({ path: op.kind === 'move' ? op.from : op.path, error: errorCode(error) })
      }
    }
    return ok
  }

  /** Fetches and verifies a document's body, images and per-document image metadata. */
  private async materialize(entry: SyncDocumentEntry, signal: AbortSignal) {
    const read = async (hash: string) => {
      const bytes = await this.provider.readObject(this.host.workspaceId, hash, signal)
      if (!bytes) throw new Error('missing_object')
      return bytes
    }
    const bytes = await read(entry.text.object)
    const assets = []
    for (const resource of entry.resources) assets.push({ path: resource.path, bytes: await read(resource.object) })
    let instances: ImageInstance[] = []
    if (entry.imageMetadata) {
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await read(entry.imageMetadata.object))) as { schemaVersion?: number; instances?: ImageInstance[] }
      if (value.schemaVersion !== 1 || !Array.isArray(value.instances)) throw new Error('invalid_metadata')
      instances = value.instances
    }
    return { bytes, assets, instances }
  }

  /** One full pass. Errors from the network or the log propagate; local write failures are reported. */
  async pass(signal: AbortSignal): Promise<PassReport> {
    const report: PassReport = { published: false, commitHash: null, downloaded: 0, conflicts: [], copies: [], keptDeletes: [], restored: [], deferred: [], skipped: [], failed: [] }
    const state: EngineState = (await this.host.loadState()) ?? { device: initialDeviceState(this.host.workspaceId, this.host.deviceId), applied: null, deferred: [] }
    if (state.device.workspaceId !== this.host.workspaceId || state.device.deviceId !== this.host.deviceId) throw new SyncEngineError('identity_mismatch')
    const save = async () => this.host.saveState(state)

    // 0. A head write whose reply was lost is settled first; it may have advanced the head.
    if (state.device.pending) state.device = await settleSyncPending(this.provider, state.device, async (device) => { state.device = device; await save() }, signal)

    // 1. Disk catches up with this device's published head before any local change is built.
    if (state.device.commitHash && state.applied !== state.device.commitHash) {
      const target = (await this.commit(state.device.commitHash, signal))!
      if (await this.apply(target, await this.commit(state.applied, signal), state, report, signal)) state.applied = state.device.commitHash
      await save()
      if (state.applied !== state.device.commitHash) { report.commitHash = state.device.commitHash; return report }
    }

    // 2. Deferred remote deletions whose tab has closed, if the file is still unchanged.
    const { open } = await this.host.open()
    let scan = await this.host.scan()
    for (const item of [...state.deferred]) {
      if (open.has(item.path)) continue
      const current = scan.documents.find((d) => d.path === item.path)
      try { if (current?.revision === item.revision) await this.host.trash({ operationId: this.host.newId(), path: item.path, expected: item.revision }) }
      catch (error) { report.failed.push({ path: item.path, error: errorCode(error) }); continue }
      state.deferred = state.deferred.filter((d) => d !== item)
    }
    await save()

    // 3. Unambiguous new documents get an identity.
    scan = await this.host.scan()
    if (!scan.identity) throw new SyncEngineError('identity_missing')
    if (scan.identity.workspaceId !== this.host.workspaceId) throw new SyncEngineError('identity_mismatch')
    const adopted = adoptNewDocuments(scan.identity, scan, () => this.host.newId())
    if (adopted) { await this.host.writeIdentity(adopted, scan.identityRevision); scan = await this.host.scan() }
    const identity = scan.identity!

    // 4. Local change relative to the applied snapshot.
    const base = await this.commit(state.applied, signal)
    const baseEntries = new Map((base?.documents ?? []).map((e) => [e.path, e]))
    const unchanged = new Set<string>(), disk = new Map<string, LocalDocument>()
    for (const doc of scan.documents) {
      const entry = baseEntries.get(doc.path)
      const tracked = identity.documents.find((d) => d.path === doc.path)
      if (!tracked) continue
      if (entry && entry.documentId === tracked.documentId && entry.text.object === doc.revision) { unchanged.add(doc.path); continue }
      disk.set(doc.path, await this.host.read(doc.path))
    }
    const trashed = await this.host.trashed()
    const appliedTombstones = new Set(base?.tombstones.map((t) => t.documentId) ?? [])
    const change = await localChange({
      workspaceId: this.host.workspaceId, deviceId: this.host.deviceId, operationId: this.host.newId(), identity, base, baseHash: state.applied,
      disk, unchanged, withheld: new Set(state.deferred.map((d) => d.documentId)),
      deleted: new Map([...trashAgainst(trashed, base)].filter(([id]) => !appliedTombstones.has(id))),
      readAsset: (directory, asset) => this.host.readAsset(directory, asset),
    })
    report.skipped.push(...change.skipped)

    // 5. Publish and converge, then land the result.
    const result = await runSyncPass(this.provider, state.device, { change: change.commit ? { commit: change.commit, uploads: change.uploads } : undefined, persist: async (device) => { state.device = device; await save() } }, signal)
    state.device = result.state
    report.published = result.published; report.commitHash = result.commitHash; report.conflicts.push(...result.conflicts)
    await save()
    if (result.commitHash && result.commitHash !== state.applied) {
      const target = (await this.commit(result.commitHash, signal))!
      // The local commit (if any) is what disk reflects now; otherwise the applied snapshot.
      const reflected = change.commit ?? base
      if (await this.apply(target, reflected, state, report, signal)) state.applied = result.commitHash
      await save()
    }
    return report
  }
}
