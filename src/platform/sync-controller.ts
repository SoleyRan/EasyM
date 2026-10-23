import type { PassReport } from '../core/sync-engine'
import { classifySyncError, retryDelay, SYNC_INTERVAL } from '../core/sync-schedule'

/**
 * v2 step 3C: runs sync passes for one bound workspace. Passes never overlap; a request during a
 * pass schedules exactly one follow-up. Transient failures back off; anything needing the user
 * pauses until `resume`. Offline editing is never blocked: the controller only drives the
 * engine, which itself refuses to touch unsaved editor content.
 */
export type SyncStatus =
  | { kind: 'idle'; lastSync: number | null; report: PassReport | null }
  | { kind: 'syncing' }
  | { kind: 'retrying'; code: string; at: number; attempt: number }
  /** `code` null: paused by the user (persisted). Otherwise paused by an error needing action. */
  | { kind: 'paused'; code: string | null }

export interface SyncControllerDeps {
  pass(signal: AbortSignal): Promise<PassReport>
  onStatus(status: SyncStatus): void
  onReport(report: PassReport): void
  /** User pause flag, persisted per binding. */
  loadPaused(): boolean
  savePaused(paused: boolean): void
  now?(): number
}
export class SyncController {
  private current: SyncStatus = { kind: 'idle', lastSync: null, report: null }
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: AbortController | null = null
  private again = false
  private attempt = 0
  private stopped = true

  constructor(private readonly deps: SyncControllerDeps) {}
  get status(): SyncStatus { return this.current }

  /** Starts automatic passes unless the user paused this binding. */
  start() {
    this.stopped = false
    if (this.deps.loadPaused()) { this.set({ kind: 'paused', code: null }); return }
    void this.run()
  }
  /** Stops everything (closing the workspace or exiting sync); an in-flight pass is aborted. */
  stop() {
    this.stopped = true
    clearTimeout(this.timer); this.timer = undefined
    this.running?.abort()
  }
  /** Runs a pass now (manual "sync now", a saved document); coalesces with a running pass. */
  request() {
    if (this.stopped || this.current.kind === 'paused') return
    if (this.running) { this.again = true; return }
    clearTimeout(this.timer); this.timer = undefined
    void this.run()
  }
  pause() {
    this.deps.savePaused(true)
    clearTimeout(this.timer); this.timer = undefined
    this.running?.abort()
    this.set({ kind: 'paused', code: null })
  }
  /** Clears both a user pause and an error pause; the next pass re-checks everything. */
  resume() {
    this.deps.savePaused(false)
    this.attempt = 0
    this.set({ kind: 'idle', lastSync: null, report: null })
    if (!this.stopped) void this.run()
  }

  private async run() {
    if (this.stopped || this.running) return
    const controller = new AbortController(); this.running = controller
    this.set({ kind: 'syncing' })
    try {
      const report = await this.deps.pass(controller.signal)
      this.attempt = 0
      this.deps.onReport(report)
      this.set({ kind: 'idle', lastSync: this.now(), report })
      // Failed operations are retried on the next regular pass with fresh revisions.
      this.schedule(SYNC_INTERVAL)
    } catch (error) {
      if (controller.signal.aborted) {
        // Aborted by pause/stop: keep the status they set; paused stays paused.
        if (this.current.kind === 'syncing') this.set({ kind: 'paused', code: null })
        return
      }
      const failure = classifySyncError(error)
      if (failure.kind === 'action') { this.set({ kind: 'paused', code: failure.code }); return }
      this.attempt++
      const delay = retryDelay(this.attempt)
      this.set({ kind: 'retrying', code: failure.code, at: this.now() + delay, attempt: this.attempt })
      this.schedule(delay)
    } finally {
      this.running = null
      if (this.again && !this.stopped && this.current.kind !== 'paused') { this.again = false; clearTimeout(this.timer); this.timer = undefined; void this.run() }
      this.again = false
    }
  }
  private schedule(delay: number) {
    if (this.stopped) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = undefined; void this.run() }, delay)
  }
  private now() { return this.deps.now?.() ?? Date.now() }
  private set(status: SyncStatus) { this.current = status; this.deps.onStatus(status) }
}

export const syncPausedKey = (bindingId: string) => `easym-sync-paused:${bindingId}`
