import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PassReport } from '../core/sync-engine'
import { SyncController, type SyncStatus } from './sync-controller'

const report = (patch: Partial<PassReport> = {}): PassReport => ({ published: false, commitHash: null, downloaded: 0, conflicts: [], copies: [], keptDeletes: [], restored: [], deferred: [], skipped: [], failed: [], changed: [], ...patch })
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function setup(pass: (signal: AbortSignal) => Promise<PassReport>, paused = false) {
  const statuses: SyncStatus[] = [], reports: PassReport[] = [], pausedWrites: boolean[] = []
  let stored = paused
  const controller = new SyncController({
    pass, onStatus: (s) => statuses.push(s), onReport: (r) => reports.push(r),
    loadPaused: () => stored, savePaused: (value) => { stored = value; pausedWrites.push(value) }, now: () => 1000,
  })
  return { controller, statuses, reports, pausedWrites }
}
describe('sync controller', () => {
  it('runs a pass on start and then every interval, reporting each', async () => {
    const pass = vi.fn(async () => report({ downloaded: 1 }))
    const { controller, reports } = setup(pass)
    controller.start(); await vi.advanceTimersByTimeAsync(0)
    expect(pass).toHaveBeenCalledTimes(1)
    expect(controller.status).toMatchObject({ kind: 'idle', lastSync: 1000 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(pass).toHaveBeenCalledTimes(2)
    expect(reports).toHaveLength(2)
    controller.stop()
  })
  it('never overlaps passes; a request during a pass runs exactly one follow-up', async () => {
    let finish!: () => void
    const pass = vi.fn(() => new Promise<PassReport>((resolve) => { finish = () => resolve(report()) }))
    const { controller } = setup(pass)
    controller.start(); await vi.advanceTimersByTimeAsync(0)
    controller.request(); controller.request(); controller.request()
    expect(pass).toHaveBeenCalledTimes(1)
    finish(); await vi.advanceTimersByTimeAsync(0)
    expect(pass).toHaveBeenCalledTimes(2)
    finish(); await vi.advanceTimersByTimeAsync(0)
    expect(pass).toHaveBeenCalledTimes(2)
    controller.stop()
  })
  it('backs off transient failures and recovers', async () => {
    const pass = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockRejectedValueOnce(new Error('server_busy:423')).mockResolvedValue(report())
    const { controller } = setup(pass)
    controller.start(); await vi.advanceTimersByTimeAsync(0)
    expect(controller.status).toEqual({ kind: 'retrying', code: 'timeout', at: 11_000, attempt: 1 })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(pass).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(controller.status).toMatchObject({ kind: 'retrying', attempt: 2 })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(controller.status.kind).toBe('idle')
    controller.stop()
  })
  it('pauses on errors that need the user and stays paused until resumed', async () => {
    const pass = vi.fn().mockRejectedValueOnce(new Error('unauthorized')).mockResolvedValue(report())
    const { controller } = setup(pass)
    controller.start(); await vi.advanceTimersByTimeAsync(0)
    expect(controller.status).toEqual({ kind: 'paused', code: 'unauthorized' })
    controller.request()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(pass).toHaveBeenCalledTimes(1)
    controller.resume(); await vi.advanceTimersByTimeAsync(0)
    expect(pass).toHaveBeenCalledTimes(2)
    expect(controller.status.kind).toBe('idle')
    controller.stop()
  })
  it('persists a user pause across restarts and clears it on resume', async () => {
    const pass = vi.fn(async () => report())
    const first = setup(pass)
    first.controller.start(); await vi.advanceTimersByTimeAsync(0)
    first.controller.pause()
    expect(first.pausedWrites).toEqual([true])
    expect(first.controller.status).toEqual({ kind: 'paused', code: null })
    await vi.advanceTimersByTimeAsync(600_000)
    expect(pass).toHaveBeenCalledTimes(1)
    first.controller.stop()
    const restarted = setup(pass, true)
    restarted.controller.start(); await vi.advanceTimersByTimeAsync(0)
    expect(restarted.controller.status).toEqual({ kind: 'paused', code: null })
    expect(pass).toHaveBeenCalledTimes(1)
    restarted.controller.resume(); await vi.advanceTimersByTimeAsync(0)
    expect(restarted.pausedWrites).toEqual([false])
    expect(pass).toHaveBeenCalledTimes(2)
    restarted.controller.stop()
  })

  it('stop aborts an in-flight pass and schedules nothing afterwards', async () => {
    const signals: AbortSignal[] = []
    const pass = vi.fn((signal: AbortSignal) => { signals.push(signal); return new Promise<PassReport>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) })
    const { controller } = setup(pass)
    controller.start(); await vi.advanceTimersByTimeAsync(0)
    controller.stop()
    expect(signals[0].aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(pass).toHaveBeenCalledTimes(1)
  })
})
