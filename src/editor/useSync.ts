import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { decodeFile, type FileSnapshot } from '../core/codec'
import { rejoinState, RETIRE_OLD_CODES, SyncEngine, type PassReport, type SyncConflictEntry } from '../core/sync-engine'
import { defaultDeviceName, detectPlatform, encodeSyncDeviceInfo, listSyncDevices, normalizeDeviceName, queueRetirement, type SyncDeviceView } from '../core/sync-devices'
import { SyncController, syncPausedKey, type SyncStatus } from '../platform/sync-controller'
import { DesktopSyncHost } from '../platform/sync-host'
import { NativeSyncProvider, readQuota, readSyncState, rejoinWorkspace, resolveSyncConflict, syncBinding, syncError, writeSyncState, type SyncBinding, type SyncQuota } from '../platform/sync-native'
import { appVersion, storedPreference, storePreference } from '../platform/preferences'
import { syncDiagnostics, tally } from '../core/sync-diagnostics'
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
  /** Step 4C: continues under a new device id after a rollback or a reused id; files are kept. */
  rejoin(): Promise<void>
  /** Step 5A: a document was saved; syncs soon unless sync is manual only. */
  notify(): void
  /** Step 5A: ms between automatic passes, or null for manual only. */
  interval: number | null
  setInterval(value: number | null): void
  /** Step 5A: every device on the server with its name and last sync time. */
  devices(): Promise<SyncDeviceView[]>
  rename(name: string): Promise<void>
  /** Queues another device for deactivation; it completes on the next pass once its content is merged. */
  deactivate(deviceId: string): Promise<void>
  /** Step 5B: server space as the server reports it; read on demand. */
  quota(): Promise<SyncQuota>
  /** Step 5B: a redacted report (codes, counts, short ids) for a support request. */
  diagnostics(): Promise<string>
}
export const SYNC_INTERVALS = [60_000, 300_000, 900_000] as const
const intervalKey = (bindingId: string) => `easym-sync-interval:${bindingId}`
const nameKey = (bindingId: string) => `easym-sync-device-name:${bindingId}`
/** Device id whose info was last published for this binding, so it is written once per id. */
const infoKey = (bindingId: string) => `easym-sync-device-info:${bindingId}`
function storedInterval(bindingId: string): number | null {
  const value = storedPreference(intervalKey(bindingId))
  if (value === 'manual') return null
  const ms = Number(value)
  return (SYNC_INTERVALS as readonly number[]).includes(ms) ? ms : SYNC_INTERVALS[0]
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
  const [interval, setIntervalState] = useState<number | null>(SYNC_INTERVALS[0])
  useEffect(() => { if (binding) setIntervalState(storedInterval(binding.bindingId)) }, [binding])
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
    const provider = new NativeSyncProvider(workspace, binding)
    const instance = new SyncController({
      pass: async (signal, progress) => {
        host.movedSessions = []
        const result = await engine.pass(signal, progress)
        // Device info is written once per device id (after connecting or rejoining); a failure
        // is retried on the next pass. It is informational and never blocks syncing.
        if (storedPreference(infoKey(binding.bindingId)) !== binding.deviceId) {
          await publishInfo(provider, binding).then(() => storePreference(infoKey(binding.bindingId), binding.deviceId)).catch(() => undefined)
        }
        return result
      },
      onStatus: setStatus,
      onReport: (next) => { setReport(next); void reloadChanged(workspace, next, host.movedSessions, handlesRef.current()) },
      loadPaused: () => storedPreference(syncPausedKey(binding.bindingId)) === 'true',
      savePaused: (paused) => { storePreference(syncPausedKey(binding.bindingId), String(paused)) },
      interval: () => storedInterval(binding.bindingId),
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

  const rejoin = useCallback(async () => {
    if (!workspace || !binding) throw new Error('binding_missing')
    controller.current?.stop()
    try {
      // Read before the id changes: the native side refuses state written for another device id.
      const previous = await readSyncState(workspace).catch(() => null)
      // Step 5A: after a rollback the old id is retired automatically once the new one published;
      // after a reused id it belongs to another installation and is left alone.
      const code = status?.kind === 'paused' ? status.code : null
      const next = await rejoinWorkspace(workspace)
      const state = await rejoinState(new NativeSyncProvider(workspace, next), previous, next.workspaceId, next.deviceId, AbortSignal.timeout(120_000), !!code && RETIRE_OLD_CODES.has(code))
      await writeSyncState(workspace, state)
      // A new binding object restarts the controller with the new id.
      setBinding(next)
    } catch (error) {
      // Restart with whatever the native side holds now; a half-done rejoin reports state_mismatch
      // on the next pass, which offers rejoining again.
      setRevision((value) => value + 1)
      throw error
    }
  }, [workspace, binding, status])

  const devices = useCallback(async () => {
    if (!workspace || !binding) throw new Error('binding_missing')
    const state = await readSyncState(workspace).catch(() => null)
    return listSyncDevices(new NativeSyncProvider(workspace, binding), binding.workspaceId, binding.deviceId, state?.device.retire ?? [], AbortSignal.timeout(60_000))
  }, [workspace, binding])

  const rename = useCallback(async (name: string) => {
    if (!workspace || !binding) throw new Error('binding_missing')
    const value = normalizeDeviceName(name)
    storePreference(nameKey(binding.bindingId), value)
    await publishInfo(new NativeSyncProvider(workspace, binding), binding)
    storePreference(infoKey(binding.bindingId), binding.deviceId)
  }, [workspace, binding])

  const deactivate = useCallback(async (deviceId: string) => {
    if (!workspace || !binding || !controller.current) throw new Error('binding_missing')
    // Edits the persisted state while no pass runs, so a running pass cannot overwrite the queue.
    await controller.current.exclusive(async () => {
      const state = await readSyncState(workspace)
      if (!state) throw new Error('sync_state_invalid')
      const retire = queueRetirement(state.device.retire, deviceId, binding.deviceId)
      await writeSyncState(workspace, { ...state, device: { ...state.device, retire } })
    })
  }, [workspace, binding])

  const quota = useCallback(async () => {
    if (!workspace || !binding) throw new Error('binding_missing')
    return readQuota(workspace)
  }, [workspace, binding])

  const diagnostics = useCallback(async () => {
    if (!workspace || !binding) throw new Error('binding_missing')
    // Each part is optional: a diagnostics report must still be produced when the server is down.
    const state = await readSyncState(workspace).catch(() => null)
    const space = await readQuota(workspace).catch(() => null)
    const count = await new NativeSyncProvider(workspace, binding).listDeviceHeads(binding.workspaceId, AbortSignal.timeout(30_000)).then((h) => h.length, () => null)
    return syncDiagnostics({
      appVersion, platform: detectPlatform(navigator.userAgent),
      status: status ? { kind: status.kind, code: status.kind === 'paused' || status.kind === 'retrying' ? status.code : null, attempt: status.kind === 'retrying' ? status.attempt : undefined } : { kind: 'none' },
      endpoint: binding.endpoint, interval: storedInterval(binding.bindingId),
      state: state && { sequence: state.device.sequence, commitHash: state.device.commitHash, applied: state.applied, pending: !!state.device.pending, seenDevices: Object.keys(state.device.seen).length, deferred: state.deferred.length, conflicts: state.conflicts?.length ?? 0, retiring: state.device.retire?.length ?? 0, rebased: !!state.device.base },
      report: report && { published: report.published, downloaded: report.downloaded, conflicts: tally(report.conflicts.map((c) => c.reason)), copies: report.copies.length, keptDeletes: report.keptDeletes.length, restored: report.restored.length, deferred: report.deferred.length, skipped: tally(report.skipped.map((s) => s.reason)), failed: tally(report.failed.map((f) => f.error)), openConflicts: report.openConflicts.length },
      quota: space, devices: count, workspaceId: binding.workspaceId, deviceId: binding.deviceId, generatedAt: new Date(),
    })
  }, [workspace, binding, status, report])

  const setInterval = useCallback((value: number | null) => {
    if (!binding) return
    storePreference(intervalKey(binding.bindingId), value === null ? 'manual' : String(value))
    setIntervalState(value)
    controller.current?.reschedule()
  }, [binding])

  return {
    binding, status, report, loadConflict, resolveConflict, rejoin, devices, rename, deactivate, interval, setInterval, quota, diagnostics,
    notify: useCallback(() => controller.current?.notify(), []),
    request: useCallback(() => controller.current?.request(), []),
    pause: useCallback(() => controller.current?.pause(), []),
    resume: useCallback(() => controller.current?.resume(), []),
    refresh: useCallback(() => setRevision((value) => value + 1), []),
  }
}

/** Writes this device's name and platform; the name is kept locally so a rejoin keeps it. */
async function publishInfo(provider: NativeSyncProvider, binding: SyncBinding) {
  const platform = detectPlatform(navigator.userAgent)
  const name = storedPreference(nameKey(binding.bindingId)) ?? defaultDeviceName(platform)
  const bytes = encodeSyncDeviceInfo({ schemaVersion: 1, workspaceId: binding.workspaceId, deviceId: binding.deviceId, name, platform })
  await provider.publishDeviceInfo(binding.workspaceId, binding.deviceId, bytes, AbortSignal.timeout(60_000))
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
