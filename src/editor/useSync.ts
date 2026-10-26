import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { SyncEngine, type PassReport } from '../core/sync-engine'
import { SyncController, syncPausedKey, type SyncStatus } from '../platform/sync-controller'
import { DesktopSyncHost } from '../platform/sync-host'
import { NativeSyncProvider, syncBinding, syncError, type SyncBinding } from '../platform/sync-native'
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
    instance.start()
    return () => { instance.stop(); if (controller.current === instance) controller.current = null }
  }, [workspace, binding])

  return {
    binding, status, report,
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
