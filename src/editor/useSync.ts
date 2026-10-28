import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { decodeFile, type FileSnapshot } from '../core/codec'
import { SyncEngine, type PassReport, type SyncConflictEntry } from '../core/sync-engine'
import { SyncController, syncPausedKey, type SyncStatus } from '../platform/sync-controller'
import { DesktopSyncHost } from '../platform/sync-host'
import { NativeSyncProvider, resolveSyncConflict, syncBinding, syncError, type SyncBinding } from '../platform/sync-native'
import { storedPreference, storePreference } from '../platform/preferences'
import type { DocumentHandle } from './DocumentEditor'

export interface SyncView {
  binding: SyncBinding | null
  status: SyncStatus | null
  report: PassReport | null
  request(): void
  pause(): void
  resume(): void
  /** Re-reads the binding after pairing or exiting sync. */
  refresh(): void
  /** Both versions of an open conflict and, when the history determines it, their common version. */
  loadConflict(entry: OpenConflict): Promise<ConflictVersions>
  /** Writes the chosen body (null keeps this document) and trashes the copy; then syncs again. */
  resolveConflict(entry: OpenConflict, versions: ConflictVersions, bytes: Uint8Array | null): Promise<void>
}
export type OpenConflict = SyncConflictEntry & { path: string; copy: string }
export interface ConflictVersions { base: string | null; mine: FileSnapshot & { revision: string }; theirs: FileSnapshot & { revision: string } }

/** `notes/a.md` → `notes/a (解决前 20261027-2130).md`: a new name for the replaced body in the trash. */
export function snapshotPath(path: string, now = new Date()): string {
  const slash = path.lastIndexOf('/'), dir = path.slice(0, slash + 1), name = path.slice(slash + 1)
  const ext = /\.(?:md|markdown)$/i.exec(name)?.[0] ?? '.md', two = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`
  return `${dir}${name.slice(0, name.length - ext.length)} (解决前 ${stamp})${ext}`
}

/** A tab must not be overwritten while it has unsaved edits or an operation in progress. */
const blocked = (handle: DocumentHandle) => handle.summary.dirty || handle.summary.busy || handle.summary.pendingImage

/**
 * Drives sync for the open workspace. One controller per binding; it stops when the workspace
 * changes or the binding is removed. Tabs whose file the pass replaced or moved reload in place,
 * except tabs with unsaved edits (the editor's external-change check handles those on save).
 */
export function useSync(workspace: string | null, enabled: boolean, handles: () => DocumentHandle[], onError: (message: string) => void): SyncView {
  const [binding, setBinding] = useState<SyncBinding | null>(null)
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [report, setReport] = useState<PassReport | null>(null)
  const [revision, setRevision] = useState(0)
  const controller = useRef<SyncController | null>(null)
  const engineRef = useRef<{ engine: SyncEngine; host: DesktopSyncHost; workspace: string } | null>(null)
  const handlesRef = useRef(handles); handlesRef.current = handles
  const errorRef = useRef(onError); errorRef.current = onError

  useEffect(() => {
    setBinding(null)
    if (!enabled || !workspace) return
    let alive = true
    syncBinding(workspace).then((value) => { if (alive) setBinding(value) }).catch((error) => { if (alive) errorRef.current(syncError(error)) })
    return () => { alive = false }
  }, [workspace, enabled, revision])
  useEffect(() => {
    setStatus(null); setReport(null)
    if (!workspace || !binding) return
    const dirtySessions = () => new Set(handlesRef.current().filter(blocked).map((h) => h.summary.fileId).filter((id): id is string => !!id))
    const host = new DesktopSyncHost(workspace, binding, dirtySessions)
    const engine = new SyncEngine(new NativeSyncProvider(workspace, binding), host)
    const instance = new SyncController({
      pass: async (signal) => { host.movedSessions = []; return engine.pass(signal) },
      onStatus: setStatus,
      onReport: (next) => { setReport(next); void reloadChanged(workspace, next, host.movedSessions, handlesRef.current()) },
      loadPaused: () => storedPreference(syncPausedKey(binding.bindingId)) === 'true',
      savePaused: (paused) => { storePreference(syncPausedKey(binding.bindingId), String(paused)) },
    })
    controller.current = instance
    const current = { engine, host, workspace }
    engineRef.current = current
    instance.start()
    return () => { instance.stop(); if (controller.current === instance) controller.current = null; if (engineRef.current === current) engineRef.current = null }
  }, [workspace, binding])

  const loadConflict = useCallback(async (entry: OpenConflict): Promise<ConflictVersions> => {
    const active = engineRef.current
    if (!active) throw new Error('binding_missing')
    const read = async (path: string) => { const doc = await active.host.read(path); return { ...decodeFile(doc.bytes), revision: doc.revision } }
    const [mine, theirs] = [await read(entry.path), await read(entry.copy)]
    // The common version only enables line-by-line choices; without it whole-document choices remain.
    const base = await active.engine.conflictBase(entry, AbortSignal.timeout(60_000)).then((bytes) => (bytes ? decodeFile(bytes).text : null)).catch(() => null)
    return { base, mine, theirs }
  }, [])

  const resolveConflict = useCallback(async (entry: OpenConflict, versions: ConflictVersions, bytes: Uint8Array | null) => {
    const active = engineRef.current
    if (!active) throw new Error('binding_missing')
    const sessions = await invoke<{ path: string; session: string }[]>('sync_local_open', { id: active.workspace })
    const session = sessions.find((s) => s.path === entry.path)?.session
    const tab = session ? handlesRef.current().find((h) => h.summary.fileId === session) : undefined
    if (tab && blocked(tab)) throw new Error('document_dirty')
    await resolveSyncConflict(active.workspace, { path: entry.path, expected: versions.mine.revision, copy: entry.copy, copyExpected: versions.theirs.revision, bytes, snapshotPath: snapshotPath(entry.path) })
    if (tab && bytes) await tab.relocated?.(entry.path).catch(() => undefined)
    // The next pass publishes the result and the copy's deletion, and drops the entry.
    controller.current?.request()
  }, [])

  return {
    binding, status, report, loadConflict, resolveConflict,
    request: useCallback(() => controller.current?.request(), []),
    pause: useCallback(() => controller.current?.pause(), []),
    resume: useCallback(() => controller.current?.resume(), []),
    refresh: useCallback(() => setRevision((value) => value + 1), []),
  }
}

/**
 * Reloads tabs whose file a pass replaced (same path) or moved (native sessions already point at
 * the new path). Tabs with unsaved edits are skipped; their next save reports the external change.
 */
async function reloadChanged(workspace: string, report: PassReport, moved: string[], handles: DocumentHandle[]) {
  if (!report.changed.length) return
  const sessions = await invoke<{ path: string; session: string }[]>('sync_local_open', { id: workspace }).catch(() => [])
  const changed = new Set(report.changed.map((c) => c.to))
  const affected = new Map(sessions.filter((s) => changed.has(s.path) || moved.includes(s.session)).map((s) => [s.session, s.path]))
  for (const handle of handles) {
    const path = handle.summary.fileId ? affected.get(handle.summary.fileId) : undefined
    if (path && !blocked(handle)) await handle.relocated?.(path).catch(() => undefined)
  }
}
