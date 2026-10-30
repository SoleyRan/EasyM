import { commitObjects, isPortableSyncPath, readSyncCommit, SyncCommitError, syncPathKey, uploadSyncCommit, type SyncCommit, type SyncDocumentEntry, type SyncTombstone, type SyncUpload } from './sync-commit'
import { MAX_SYNC_DEVICES, MERGE_DEVICE_ID, syncHash, type SyncProvider, type VersionedDeviceHead } from './sync-contract'
import { MAX_SYNC_MERGE_BYTES, mergeSyncMetadata, mergeSyncResources, mergeSyncText } from './sync-merge'
import { assetPath } from './images'
import { canonicalJson, managedReferences } from './sync-snapshot'

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
  /**
   * Step 4C: a device that rejoined under a new id builds its first change on this published
   * commit (what disk last reflected). It must still be reachable from the remote heads; cleared
   * once the device has published.
   */
  base?: string
  /**
   * Step 5A: device ids to retire (deactivated by the user, or this device's id before rejoining).
   * A device is retired only once this device's published head contains its last head, so nothing
   * it published is dropped; an id leaves the list when retired or already gone.
   */
  retire?: string[]
}

export const initialDeviceState = (workspaceId: string, deviceId: string): SyncDeviceState => ({ workspaceId, deviceId, sequence: 0, commitHash: null, seen: {} })

export class SyncLogError extends Error {
  readonly code: 'device_conflict' | 'rollback' | 'too_many_devices' | 'history_budget' | 'unknown_outcome' | 'not_descendant' | 'device_retired'
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
  /** Reads an object referenced by a commit and checks it against its content address. */
  async object(hash: string): Promise<Uint8Array> {
    const bytes = await this.provider.readObject(this.workspaceId, hash, this.signal)
    if (!bytes) throw new SyncCommitError('missing_object')
    if ((await syncHash(bytes)) !== hash) throw new SyncCommitError('hash_mismatch')
    return bytes
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
const COPY_NAME = /^(.*) \(冲突 ([0-9a-f]{8})\)(\.md|\.markdown)$/i, COPY_FALLBACK = /^冲突-([0-9a-f]{8})\.md$/

/**
 * Conflict copies that merge commits created, among the documents of `target` that `isNew`
 * accepts. A copy is recognised by its name and then proven by its derived id, so a copy that was
 * renamed or edited before this device saw it is simply not listed, never attributed wrongly.
 */
export async function mergeConflictCopies(target: SyncCommit, isNew: (documentId: string) => boolean): Promise<{ documentId: string; copyId: string }[]> {
  const byPath = new Map(target.documents.map((entry) => [entry.path, entry]))
  const found: { documentId: string; copyId: string }[] = []
  for (const copy of target.documents) {
    if (!isNew(copy.documentId)) continue
    const slash = copy.path.lastIndexOf('/'), dir = copy.path.slice(0, slash + 1), name = copy.path.slice(slash + 1)
    const named = COPY_NAME.exec(name), fallback = named ? null : COPY_FALLBACK.exec(name)
    if (!named && !fallback) continue
    const key = contentKey(copy)
    if ((named ? named[2] : fallback![1]) !== (await syncHash(new TextEncoder().encode(key))).slice(7, 15)) continue
    const candidates = named ? [byPath.get(`${dir}${named[1]}${named[3]}`)] : target.documents.filter((entry) => entry.path.startsWith(dir) && !entry.path.slice(dir.length).includes('/'))
    for (const original of candidates) {
      if (!original || original.documentId === copy.documentId) continue
      if ((await derivedId('conflict-copy', original.documentId, key)) === copy.documentId) { found.push({ documentId: original.documentId, copyId: copy.documentId }); break }
    }
  }
  return found
}

/**
 * The common version a merge conflict copy was split from: walks back from `head` only through
 * commits that contain the copy, finds the merge commit that created it, and returns the text
 * object of `documentId` in that merge's bases. Null when the history does not determine one.
 */
export async function conflictBase(history: SyncHistory, head: string, documentId: string, copyId: string): Promise<string | null> {
  const contains = (commit: SyncCommit) => commit.documents.some((entry) => entry.documentId === copyId)
  const seen = new Set<string>(), stack = [head]
  for (let hash = stack.pop(); hash; hash = stack.pop()) {
    if (seen.has(hash)) continue
    seen.add(hash)
    const commit = await history.get(hash)
    if (!contains(commit)) continue
    const parents = await Promise.all(commit.parents.map((parent) => history.get(parent)))
    if (commit.parents.length === 2 && !parents.some(contains)) {
      const base = (await baseLookup(history, await mergeBases(history, commit.parents[0], commit.parents[1])))(documentId)
      return base !== UNKNOWN && base?.kind === 'doc' ? base.entry.text.object : null
    }
    stack.push(...commit.parents)
  }
  return null
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
  /** `merged`: both sides changed different lines and the result combines them (no copy). */
  reason: 'both_changed' | 'both_renamed' | 'edit_vs_delete' | 'path_collision' | 'merged'
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
export async function mergeSyncCommits(history: SyncHistory, a: string, b: string): Promise<{ commit: SyncCommit; conflicts: SyncConflict[]; uploads: SyncUpload[] }> {
  const [left, right] = a < b ? [a, b] : [b, a]
  const leftCommit = await history.get(left)
  const l = snapshot(leftCommit), r = snapshot(await history.get(right))
  const base = await baseLookup(history, await mergeBases(history, left, right))
  const out: Snapshot = new Map(), conflicts: SyncConflict[] = [], uploads: SyncUpload[] = []
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
    // Both sides changed the content: try a line-level merge against the common version.
    const lines = ob ? await mergeEntry(history, ob, x.entry, y.entry, uploads) : null
    if (lines) { out.set(id, { kind: 'doc', entry: { ...lines, documentId: id, path } }); conflicts.push({ documentId: id, reason: 'merged', path, copy: null }); continue }
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
  return { commit, conflicts, uploads }
}

/**
 * Line-level merge of one document whose content both sides changed. Deterministic: the result
 * depends only on the three entries' objects, so every device derives the same merged entry and
 * the same merge commit. Returns null when the text edits overlap, the images or image metadata
 * conflict, or a body is too large; the caller then keeps a conflict copy as before.
 */
async function mergeEntry(history: SyncHistory, base: SyncDocumentEntry, left: SyncDocumentEntry, right: SyncDocumentEntry, uploads: SyncUpload[]): Promise<Omit<SyncDocumentEntry, 'documentId' | 'path'> | null> {
  if ([base, left, right].some((entry) => entry.text.bytes > MAX_SYNC_MERGE_BYTES || (entry.imageMetadata?.bytes ?? 0) > MAX_SYNC_MERGE_BYTES)) return null
  const [o, x, y] = await Promise.all([base, left, right].map((entry) => history.object(entry.text.object)))
  const body = mergeSyncText(o, x, y)
  if (!body) return null
  const references = managedReferences(body)
  const metadata = async (entry: SyncDocumentEntry) => (entry.imageMetadata ? history.object(entry.imageMetadata.object) : null)
  const instances = mergeSyncMetadata(await metadata(base), await metadata(left), await metadata(right), new Set(references))
  if (!instances) return null
  // Same rule as a local build: the referenced images plus the sources of their edited instances.
  const needed = new Set(references)
  for (const instance of instances) if (typeof instance.sourcePath === 'string' && assetPath(instance.sourcePath)) needed.add(instance.sourcePath)
  const resources = mergeSyncResources(base.resources, left.resources, right.resources, needed)
  if (!resources) return null
  const add = async (bytes: Uint8Array) => { const hash = await syncHash(bytes); uploads.push({ hash, bytes }); return { object: hash, bytes: bytes.byteLength } }
  const text = await add(body)
  const metadataBytes = instances.length ? new TextEncoder().encode(canonicalJson({ schemaVersion: 1, instances })) : null
  const imageMetadata = metadataBytes ? await add(metadataBytes) : null
  return { text, imageMetadata, resources: resources.map((r) => ({ path: r.path, object: r.object, bytes: r.bytes })) }
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
  // Retirement records are only read when a head is missing, so ordinary passes cost nothing extra.
  let retired: Set<string> | null = null
  const isRetired = async (id: string) => (retired ??= new Set(await provider.listRetiredDevices(workspaceId, signal))).has(id)
  const own = heads.find((h) => h.head.deviceId === deviceId)
  if (!own && state.sequence !== 0 && (await isRetired(deviceId))) throw new SyncLogError('device_retired')
  if (own ? own.head.sequence !== state.sequence || own.head.commitHash !== state.commitHash : state.sequence !== 0) {
    throw new SyncLogError(own && own.head.sequence < state.sequence ? 'rollback' : 'device_conflict')
  }
  for (const [seen, sequence] of Object.entries(state.seen)) {
    const head = heads.find((h) => h.head.deviceId === seen)
    // A retired device's head disappears on purpose; anything it published is already merged.
    if (!head && (await isRetired(seen))) { delete state.seen[seen]; continue }
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
    const rebased = !!state.base && parent === state.base && state.commitHash === null
    if (commit.deviceId !== deviceId || commit.workspaceId !== workspaceId || (parent !== (state.commitHash ?? '') && parent !== (current.commitHash ?? '') && !rebased)) throw new SyncLogError('not_descendant')
    if (rebased) {
      // A rejoined device's base must still be in the published history; otherwise its change
      // would point at a commit other devices cannot read.
      let reachable = false
      for (const { head } of heads) if ((await history.ancestors(head.commitHash)).has(parent)) { reachable = true; break }
      if (!reachable) throw new SyncLogError('not_descendant')
    }
    // Unchanged documents reuse the parent's objects; they were uploaded before it was published.
    for (const hash of commit.parents) for (const object of commitObjects(await history.get(hash))) existing.add(object)
    candidates.push(await uploadSyncCommit(provider, commit, uploads, existing, signal))
    for (const object of commitObjects(commit)) existing.add(object)
  }
  const { tip, conflicts } = await converge(provider, history, candidates, existing, signal)
  for (const { head } of heads) if (head.deviceId !== deviceId) state.seen[head.deviceId] = head.sequence

  if (tip === null || tip === state.commitHash) {
    state = await retirePending(provider, history, state, heads, signal)
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
  state = { ...state, sequence, commitHash: tip, pending: undefined, base: undefined }
  await input.persist(state)
  if (state.retire?.length) { state = await retirePending(provider, history, state, heads, signal); await input.persist(state) }
  return { state, commitHash: tip, conflicts, published: true }
}

/**
 * Step 5A: retires the ids in `state.retire` whose last listed head is contained in this device's
 * published head. A head the listing no longer shows is already gone; one that changed since the
 * listing stays queued for the next pass, which merges its new content first.
 */
async function retirePending(provider: SyncProvider, history: SyncHistory, state: SyncDeviceState, heads: VersionedDeviceHead[], signal: AbortSignal): Promise<SyncDeviceState> {
  if (!state.retire?.length || !state.commitHash) return state
  const published = await history.ancestors(state.commitHash)
  const remaining: string[] = []
  for (const id of state.retire) {
    if (id === state.deviceId) continue
    const listed = heads.find((h) => h.head.deviceId === id)
    if (!listed) { delete state.seen[id]; continue }
    if (!published.has(listed.head.commitHash)) { remaining.push(id); continue }
    try {
      await provider.retireDevice(listed.head, listed.revision, signal)
      delete state.seen[id]
    } catch (error) {
      if ((error as { code?: string }).code === 'device_changed') { remaining.push(id); continue }
      throw error
    }
  }
  return { ...state, retire: remaining.length ? remaining : undefined }
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
  else if (!remote && (await provider.listRetiredDevices(state.workspaceId, signal)).includes(state.deviceId)) throw new SyncLogError('device_retired')
  else throw new SyncLogError('device_conflict')
  await input.persist(next)
  return next
}

/** Drops tips contained in another tip, then folds the rest in sorted order. */
async function converge(provider: SyncProvider, history: SyncHistory, candidates: string[], existing: Set<string>, signal: AbortSignal): Promise<{ tip: string | null; conflicts: SyncConflict[] }> {
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
    // Line merges add new bodies and metadata; uploading identical bytes twice is a no-op.
    tip = await uploadSyncCommit(provider, merged.commit, merged.uploads, existing, signal)
    for (const upload of merged.uploads) existing.add(upload.hash)
  }
  return { tip, conflicts }
}
