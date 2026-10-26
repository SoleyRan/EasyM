import { commitObjects, isPortableSyncPath, readSyncCommit, syncPathKey, uploadSyncCommit, type SyncCommit, type SyncDocumentEntry, type SyncTombstone, type SyncUpload } from './sync-commit'
import { MAX_SYNC_DEVICES, MERGE_DEVICE_ID, syncHash, type SyncProvider } from './sync-contract'

/**
 * v2 per-device log. Every device writes only `devices/<deviceId>.json`; no file is shared
 * between writers, so correctness never depends on a server-side compare-and-swap (step 1
 * measured that Apache mod_dav acknowledges racing conditional writes and that Nextcloud does
 * so for creates). Devices converge through deterministic merge commits: any device merging
 * the same tips produces byte-identical commits, so it does not matter who merges first.
 */
export const MAX_SYNC_HISTORY_COMMITS = 10_000

/** Local, per-binding record. Persisted by the platform in step 3; never synced. */
export interface SyncDeviceState {
  workspaceId: string
  deviceId: string
  /** Sequence and commit of this device's last confirmed head; 0/null before the first publish. */
  sequence: number
  commitHash: string | null
  /** Highest sequence seen per remote device, to detect rollbacks and removed heads. */
  seen: Record<string, number>
  /** Head write whose reply was lost; persisted before the request, resolved on the next pass. */
  pending?: { sequence: number; commitHash: string }
}

export const initialDeviceState = (workspaceId: string, deviceId: string): SyncDeviceState => ({ workspaceId, deviceId, sequence: 0, commitHash: null, seen: {} })

export class SyncLogError extends Error {
  readonly code: 'device_conflict' | 'rollback' | 'too_many_devices' | 'history_budget' | 'unknown_outcome' | 'not_descendant'
  constructor(code: SyncLogError['code']) {
    super(code)
    this.code = code
    this.name = 'SyncLogError'
  }
}

/** Commits are immutable, so one cache serves every walk within a pass. */
export class SyncHistory {
  private readonly commits = new Map<string, SyncCommit>()
  constructor(private readonly provider: SyncProvider, private readonly workspaceId: string, private readonly signal: AbortSignal) {}
  async get(hash: string): Promise<SyncCommit> {
    const cached = this.commits.get(hash)
    if (cached) return cached
    if (this.commits.size >= MAX_SYNC_HISTORY_COMMITS) throw new SyncLogError('history_budget')
    const commit = await readSyncCommit(this.provider, this.workspaceId, hash, this.signal)
    this.commits.set(hash, commit)
    return commit
  }
  /** All ancestors including `hash` itself. */
  async ancestors(hash: string): Promise<Set<string>> {
    const seen = new Set<string>(), stack = [hash]
    for (let next = stack.pop(); next; next = stack.pop()) {
      if (seen.has(next)) continue
      seen.add(next)
      stack.push(...(await this.get(next)).parents)
    }
    return seen
  }
}

type Doc = { kind: 'doc'; entry: SyncDocumentEntry }
type Tomb = { kind: 'tomb'; tomb: SyncTombstone }
type Slot = Doc | Tomb
type Snapshot = Map<string, Slot>
/** A document whose merge bases disagree; any difference is then kept as a copy. */
const UNKNOWN = Symbol('unknown')

const snapshot = (commit: SyncCommit): Snapshot => {
  const map: Snapshot = new Map()
  for (const entry of commit.documents) map.set(entry.documentId, { kind: 'doc', entry })
  for (const tomb of commit.tombstones) map.set(tomb.documentId, { kind: 'tomb', tomb })
  return map
}
const contentKey = (entry: SyncDocumentEntry) => JSON.stringify([entry.text.object, entry.imageMetadata?.object ?? null, [...entry.resources].sort((a, b) => (a.path < b.path ? -1 : 1)).map((r) => [r.path, r.object])])
const slotKey = (slot: Slot | undefined) => (slot === undefined ? '' : slot.kind === 'doc' ? `d${slot.entry.path}\0${contentKey(slot.entry)}` : `t${slot.tomb.path}\0${slot.tomb.operationId}`)
const same = (a: Slot | undefined, b: Slot | undefined) => slotKey(a) === slotKey(b)
const pick3 = <T>(l: T, r: T, o: T): T | null => (l === r || r === o ? l : l === o ? r : null)

/** UUID-shaped identifier derived from content, so every device derives the same one. */
async function derivedId(...parts: string[]): Promise<string> {
  const h = (await syncHash(new TextEncoder().encode(parts.join('\n')))).slice(7)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[parseInt(h[16], 16) & 3]}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

function conflictPath(path: string, tag: string): string {
  const slash = path.lastIndexOf('/'), dir = path.slice(0, slash + 1), name = path.slice(slash + 1)
  const ext = /\.(?:md|markdown)$/i.exec(name)?.[0] ?? '.md'
  const candidate = `${dir}${name.slice(0, name.length - ext.length)} (冲突 ${tag})${ext}`
  return isPortableSyncPath(candidate) ? candidate : `${dir}冲突-${tag}.md`
}
/** Lowest common ancestors: common ancestors that are not an ancestor of another common one. */
async function mergeBases(history: SyncHistory, a: string, b: string): Promise<string[]> {
  const left = await history.ancestors(a), right = await history.ancestors(b)
  const common = [...left].filter((hash) => right.has(hash))
  const dominated = new Set<string>()
  for (const hash of common) for (const ancestor of await history.ancestors(hash)) if (ancestor !== hash) dominated.add(ancestor)
  return common.filter((hash) => !dominated.has(hash)).sort()
}

/** A document's base is known only when every merge base holds the same version of it. */
async function baseLookup(history: SyncHistory, bases: string[]): Promise<(id: string) => Slot | undefined | typeof UNKNOWN> {
  const snaps = await Promise.all(bases.map(async (hash) => snapshot(await history.get(hash))))
  return (id) => {
    if (!snaps.length) return undefined
    const first = snaps[0].get(id)
    return snaps.every((snap) => same(snap.get(id), first)) ? first : UNKNOWN
  }
}

export interface SyncConflict {
  documentId: string
  reason: 'both_changed' | 'both_renamed' | 'edit_vs_delete' | 'path_collision'
  /** Path of the version kept in place, and of the extra copy when one was created. */
  path: string
  copy: string | null
}

/**
 * Deterministic three-way merge per documentId. Nothing is discarded: path and content merge
 * independently (rename on one side + edit on the other is clean); concurrent content edits keep
 * one version in place and the other as a conflict copy that reuses the same immutable objects;
 * edit beats delete; distinct documents landing on one path are renamed.
 */
export async function mergeSyncCommits(history: SyncHistory, a: string, b: string): Promise<{ commit: SyncCommit; conflicts: SyncConflict[] }> {
  const [left, right] = a < b ? [a, b] : [b, a]
  const leftCommit = await history.get(left)
  const l = snapshot(leftCommit), r = snapshot(await history.get(right))
  const base = await baseLookup(history, await mergeBases(history, left, right))
  const out: Snapshot = new Map(), conflicts: SyncConflict[] = []
  for (const id of [...new Set([...l.keys(), ...r.keys()])].sort()) {
    const x = l.get(id), y = r.get(id), o = base(id)
    if (same(x, y) || !y) { out.set(id, x as Slot); continue }
    if (!x) { out.set(id, y); continue }
    if (x.kind === 'tomb' && y.kind === 'tomb') { out.set(id, slotKey(x) < slotKey(y) ? x : y); continue }
    if (x.kind === 'tomb' || y.kind === 'tomb') {
      const doc = (x.kind === 'doc' ? x : y) as Doc, tomb = (x.kind === 'tomb' ? x : y) as Tomb
      // Delete wins only over an unchanged document; otherwise keep the edit.
      if (o !== UNKNOWN && o?.kind === 'doc' && same(doc, o)) { out.set(id, tomb); continue }
      out.set(id, doc)
      conflicts.push({ documentId: id, reason: 'edit_vs_delete', path: doc.entry.path, copy: null })
      continue
    }
    const ob = o !== UNKNOWN && o?.kind === 'doc' ? o.entry : null
    let path = ob ? pick3(x.entry.path, y.entry.path, ob.path) : null
    if (path === null) {
      path = x.entry.path < y.entry.path ? x.entry.path : y.entry.path
      if (x.entry.path !== y.entry.path) conflicts.push({ documentId: id, reason: 'both_renamed', path, copy: null })
    }
    const xc = contentKey(x.entry), yc = contentKey(y.entry), oc = ob ? contentKey(ob) : null
    const merged = xc === yc || yc === oc ? x.entry : xc === oc ? y.entry : null
    if (merged) { out.set(id, { kind: 'doc', entry: { ...merged, path } }); continue }
    const [win, lose] = xc < yc ? [x.entry, y.entry] : [y.entry, x.entry]
    const tag = (await syncHash(new TextEncoder().encode(contentKey(lose)))).slice(7, 15)
    const copy: SyncDocumentEntry = { ...lose, documentId: await derivedId('conflict-copy', id, contentKey(lose)), path: conflictPath(path, tag) }
    out.set(id, { kind: 'doc', entry: { ...win, path } })
    if (!out.has(copy.documentId)) out.set(copy.documentId, { kind: 'doc', entry: copy })
    conflicts.push({ documentId: id, reason: 'both_changed', path, copy: copy.path })
  }
  resolvePathCollisions(out, conflicts)
  const slots = [...out.values()]
  const commit: SyncCommit = {
    schemaVersion: 1, workspaceId: leftCommit.workspaceId, operationId: await derivedId('merge', left, right), deviceId: MERGE_DEVICE_ID, parents: [left, right],
    documents: slots.flatMap((slot) => (slot.kind === 'doc' ? [slot.entry] : [])),
    tombstones: slots.flatMap((slot) => (slot.kind === 'tomb' ? [slot.tomb] : [])),
  }
  return { commit, conflicts }
}

/** Distinct documents on one (case-folded) path: the lowest documentId keeps it. */
function resolvePathCollisions(out: Snapshot, conflicts: SyncConflict[]) {
  const docs = [...out.values()].flatMap((slot) => (slot.kind === 'doc' ? [slot.entry] : [])).sort((a, b) => (a.documentId < b.documentId ? -1 : 1))
  const taken = new Set<string>()
  for (const entry of docs) {
    let path = entry.path
    for (let n = 0; taken.has(syncPathKey(path)); n++) path = conflictPath(entry.path, `${entry.documentId.slice(0, 8)}${n ? `-${n}` : ''}`)
    taken.add(syncPathKey(path))
    if (path === entry.path) continue
    out.set(entry.documentId, { kind: 'doc', entry: { ...entry, path } })
    conflicts.push({ documentId: entry.documentId, reason: 'path_collision', path: entry.path, copy: path })
  }
}
export interface SyncPassInput {
  /** A new local commit whose only parent is `state.commitHash` (none on the first publish). */
  change?: { commit: SyncCommit; uploads: SyncUpload[] }
  /** Persists local state; called before the head request so a crash or lost reply is recoverable. */
  persist: (state: SyncDeviceState) => Promise<void>
}
export interface SyncPassResult {
  state: SyncDeviceState
  /** Converged snapshot this device now points at (applied locally in step 3). */
  commitHash: string | null
  conflicts: SyncConflict[]
  published: boolean
}

/**
 * One pass: settle any pending head write, read every device head, fold all tips with
 * deterministic merges, then advance only this device's head. Stops instead of guessing when
 * the remote shows a rollback, a removed head, a cloned device id or an unresolved write.
 */
export async function runSyncPass(provider: SyncProvider, current: SyncDeviceState, input: SyncPassInput, signal: AbortSignal): Promise<SyncPassResult> {
  let state: SyncDeviceState = { ...current, seen: { ...current.seen } }
  const { workspaceId, deviceId } = state
  if (state.pending) state = await settlePending(provider, state, input, signal)

  const heads = await provider.listDeviceHeads(workspaceId, signal)
  if (heads.length > MAX_SYNC_DEVICES) throw new SyncLogError('too_many_devices')
  const own = heads.find((h) => h.head.deviceId === deviceId)
  if (own ? own.head.sequence !== state.sequence || own.head.commitHash !== state.commitHash : state.sequence !== 0) {
    throw new SyncLogError(own && own.head.sequence < state.sequence ? 'rollback' : 'device_conflict')
  }
  for (const [seen, sequence] of Object.entries(state.seen)) {
    const head = heads.find((h) => h.head.deviceId === seen)
    if (!head || head.head.sequence < sequence) throw new SyncLogError('rollback')
  }

  const history = new SyncHistory(provider, workspaceId, signal)
  const existing = new Set<string>(), candidates = heads.map((h) => h.head.commitHash)
  for (const hash of candidates) for (const object of commitObjects(await history.get(hash))) existing.add(object)
  if (input.change) {
    const { commit, uploads } = input.change
    // The change may have been built before a pending write was settled; the head it was built
    // on is then an ancestor of the settled head, and the change is merged like any other tip.
    const parent = commit.parents.join()
    if (commit.deviceId !== deviceId || commit.workspaceId !== workspaceId || (parent !== (state.commitHash ?? '') && parent !== (current.commitHash ?? ''))) throw new SyncLogError('not_descendant')
    candidates.push(await uploadSyncCommit(provider, commit, uploads, existing, signal))
    for (const object of commitObjects(commit)) existing.add(object)
  }
  const { tip, conflicts } = await converge(provider, history, candidates, existing, signal)
  for (const { head } of heads) if (head.deviceId !== deviceId) state.seen[head.deviceId] = head.sequence

  if (tip === null || tip === state.commitHash) {
    await input.persist(state)
    return { state, commitHash: tip, conflicts, published: false }
  }
  // Every published head descends from this device's previous head, so nothing is ever unpublished.
  if (state.commitHash && !(await history.ancestors(tip)).has(state.commitHash)) throw new SyncLogError('not_descendant')
  const sequence = state.sequence + 1
  state = { ...state, pending: { sequence, commitHash: tip } }
  await input.persist(state)
  const expected = own ? (own.revision ? { kind: 'match' as const, revision: own.revision } : { kind: 'owned' as const }) : { kind: 'absent' as const }
  const result = await provider.publishDeviceHead({ schemaVersion: 1, workspaceId, deviceId, sequence, commitHash: tip }, expected, signal)
  if (result.kind === 'conflict') throw new SyncLogError('device_conflict')
  if (result.kind === 'unknown') throw new SyncLogError('unknown_outcome')
  state = { ...state, sequence, commitHash: tip, pending: undefined }
  await input.persist(state)
  return { state, commitHash: tip, conflicts, published: true }
}

/**
 * Settles a head write whose reply was lost, without running a pass. Callers that build a local
 * change from disk use this first, so disk can catch up with the published head beforehand.
 */
export async function settleSyncPending(provider: SyncProvider, state: SyncDeviceState, persist: SyncPassInput['persist'], signal: AbortSignal): Promise<SyncDeviceState> {
  return state.pending ? settlePending(provider, state, { persist }, signal) : state
}

/** Reading the own head back shows the pending write, the previous head, or a foreign writer. */
async function settlePending(provider: SyncProvider, state: SyncDeviceState, input: SyncPassInput, signal: AbortSignal): Promise<SyncDeviceState> {
  const pending = state.pending as NonNullable<SyncDeviceState['pending']>
  const remote = await provider.readDeviceHead(state.workspaceId, state.deviceId, signal)
  let next: SyncDeviceState
  if (remote && remote.head.sequence === pending.sequence && remote.head.commitHash === pending.commitHash) next = { ...state, sequence: pending.sequence, commitHash: pending.commitHash, pending: undefined }
  else if (remote ? remote.head.sequence === state.sequence && remote.head.commitHash === state.commitHash : state.sequence === 0) next = { ...state, pending: undefined }
  else throw new SyncLogError('device_conflict')
  await input.persist(next)
  return next
}

/** Drops tips contained in another tip, then folds the rest in sorted order. */
async function converge(provider: SyncProvider, history: SyncHistory, candidates: string[], existing: ReadonlySet<string>, signal: AbortSignal): Promise<{ tip: string | null; conflicts: SyncConflict[] }> {
  const unique = [...new Set(candidates)].sort()
  const ancestry = new Map<string, Set<string>>()
  for (const hash of unique) ancestry.set(hash, await history.ancestors(hash))
  const tips = unique.filter((hash) => !unique.some((other) => other !== hash && ancestry.get(other)?.has(hash)))
  if (!tips.length) return { tip: null, conflicts: [] }
  let tip = tips[0]
  const conflicts: SyncConflict[] = []
  for (const next of tips.slice(1)) {
    const merged = await mergeSyncCommits(history, tip, next)
    conflicts.push(...merged.conflicts)
    // Byte-identical on every device that merges the same pair, so concurrent merges coincide.
    tip = await uploadSyncCommit(provider, merged.commit, [], existing, signal)
  }
  return { tip, conflicts }
}
