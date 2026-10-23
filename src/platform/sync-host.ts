import { invoke } from '@tauri-apps/api/core'
import type { ImageInstance } from '../core/images'
import { syncHash } from '../core/sync-contract'
import type { EngineState, LocalScan, SyncHost } from '../core/sync-engine'
import { encodeWorkspaceIdentity, parseWorkspaceIdentity, type WorkspaceIdentity } from '../core/sync-identity'
import { readSyncState, writeSyncState, type SyncBinding } from './sync-native'
import { listTrash } from './workspace-ops'

interface NativeScan { identity: number[] | null; documents: { path: string; revision: string; bytes: number; historyId: string | null; historyUnreadable?: boolean }[] }
interface NativeDocument { bytes: number[]; revision: string; instances: ImageInstance[] | null }

/**
 * Native session ids of tabs that must not be overwritten (unsaved edits or an operation in
 * progress). Supplied by the editor shell; which documents are open comes from the native side.
 */
export type DirtySessions = () => Set<string>

/**
 * Desktop SyncHost: every local read and write goes through the native commands, which hold the
 * document write queue, check revisions and refuse to touch documents open in a tab.
 */
export class DesktopSyncHost implements SyncHost {
  readonly workspaceId: string
  readonly deviceId: string
  /** Native sessions moved by the last `move`, so the shell can reload those tabs in place. */
  movedSessions: string[] = []
  constructor(private readonly workspace: string, binding: SyncBinding, private readonly dirtySessions: DirtySessions) {
    this.workspaceId = binding.workspaceId
    this.deviceId = binding.deviceId
  }
  async scan(): Promise<LocalScan> {
    const scan = await invoke<NativeScan>('sync_local_revisions', { id: this.workspace })
    const raw = scan.identity ? new Uint8Array(scan.identity) : null
    return {
      identity: raw ? parseWorkspaceIdentity(raw) : null,
      // The precondition is the digest of the exact file bytes, as the native write checks it.
      identityRevision: raw ? await syncHash(raw) : null,
      documents: scan.documents.map((d) => ({ path: d.path, revision: d.revision, historyId: d.historyId, historyUnreadable: d.historyUnreadable })),
    }
  }
  async read(path: string) {
    const doc = await invoke<NativeDocument>('sync_local_read', { id: this.workspace, path })
    return { path, bytes: new Uint8Array(doc.bytes), revision: doc.revision, instances: doc.instances }
  }
  async readAsset(directory: string, asset: string) {
    const raw = await invoke<number[] | null>('sync_local_asset', { id: this.workspace, directory, asset })
    return raw ? new Uint8Array(raw) : null
  }
  async open() {
    const sessions = await invoke<{ path: string; session: string }[]>('sync_local_open', { id: this.workspace })
    const dirty = this.dirtySessions()
    return { open: new Set(sessions.map((s) => s.path)), dirty: new Set(sessions.filter((s) => dirty.has(s.session)).map((s) => s.path)) }
  }
  async trashed() {
    const entries = await listTrash(this.workspace)
    return new Map(entries.flatMap((e) => (e.documentId ? [[e.documentId, e.revision] as [string, string]] : [])))
  }
  async writeIdentity(next: WorkspaceIdentity, expected: string | null) {
    await invoke('sync_identity_write', { id: this.workspace, expected, bytes: Array.from(encodeWorkspaceIdentity(next)) })
  }
  async write(op: Parameters<SyncHost['write']>[0]) {
    await invoke('sync_local_write', { id: this.workspace, request: {
      operationId: op.operationId, path: op.path, expected: op.expected, bytes: Array.from(op.bytes),
      assets: op.assets.map((a) => ({ path: a.path, bytes: Array.from(a.bytes) })), instances: op.instances,
    } })
  }
  async move(op: Parameters<SyncHost['move']>[0]) {
    this.movedSessions.push(...await invoke<string[]>('sync_local_move', { id: this.workspace, operationId: op.operationId, from: op.from, to: op.to, expected: op.expected, references: op.references }))
  }
  async trash(op: Parameters<SyncHost['trash']>[0]) {
    await invoke('sync_local_trash', { id: this.workspace, operationId: op.operationId, path: op.path, expected: op.expected })
  }
  loadState(): Promise<EngineState | null> { return readSyncState(this.workspace) }
  saveState(state: EngineState) { return writeSyncState(this.workspace, state) }
  newId() { return crypto.randomUUID() }
}
