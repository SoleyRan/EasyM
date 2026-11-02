import { encodeSyncDeviceHead, isSyncId, parseSyncDeviceHead, syncHash, type ExpectedSyncHead, type PublishSyncHeadResult, type SyncDeviceHead, type SyncProvider, type VersionedDeviceHead } from './sync-contract'

/**
 * Deterministic in-process Provider for unit tests and fault injection. It is not evidence
 * about any real server. `nonAtomic` models the step-1 finding that conditional writes on
 * Apache mod_dav are not exclusive: preconditions are checked but racing writers all succeed.
 */
export class MemorySyncProvider implements SyncProvider {
  readonly objects = new Map<string, Uint8Array>()
  readonly heads = new Map<string, { bytes: Uint8Array; revision: string }>()
  requests: string[] = []
  nonAtomic = false
  /** Commit the next head write, then lose the response. */
  loseNextPublishResponse = false
  /** Fail the next object upload before anything is stored. */
  failNextObject = false
  private revisions = 0

  private key(workspaceId: string, name: string) { return `${workspaceId}/${name}` }

  async listDeviceHeads(workspaceId: string, signal: AbortSignal): Promise<VersionedDeviceHead[]> {
    signal.throwIfAborted(); this.requests.push('listDeviceHeads')
    const prefix = `${workspaceId}/devices/`
    return [...this.heads].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, value]) => {
      const deviceId = key.slice(prefix.length)
      if (!isSyncId(deviceId)) throw new Error('invalid_listing')
      return { head: parseSyncDeviceHead(value.bytes, workspaceId, deviceId), revision: value.revision }
    })
  }

  async readDeviceHead(workspaceId: string, deviceId: string, signal: AbortSignal): Promise<VersionedDeviceHead | null> {
    signal.throwIfAborted(); this.requests.push('readDeviceHead')
    const value = this.heads.get(this.key(workspaceId, `devices/${deviceId}`))
    return value ? { head: parseSyncDeviceHead(value.bytes, workspaceId, deviceId), revision: value.revision } : null
  }

  async publishDeviceHead(head: SyncDeviceHead, expected: ExpectedSyncHead, signal: AbortSignal): Promise<PublishSyncHeadResult> {
    signal.throwIfAborted(); this.requests.push('publishDeviceHead')
    const key = this.key(head.workspaceId, `devices/${head.deviceId}`), current = this.heads.get(key)
    const matches = expected.kind === 'owned' || (expected.kind === 'absent' ? !current : current?.revision === expected.revision)
    if (!matches && !this.nonAtomic) return { kind: 'conflict' }
    const revision = `"r${++this.revisions}"`
    this.heads.set(key, { bytes: encodeSyncDeviceHead(head), revision })
    if (this.loseNextPublishResponse) { this.loseNextPublishResponse = false; return { kind: 'unknown' } }
    return { kind: 'committed', revision }
  }

  async readObject(workspaceId: string, hash: string, signal: AbortSignal): Promise<Uint8Array | null> {
    signal.throwIfAborted(); this.requests.push('readObject')
    const bytes = this.objects.get(this.key(workspaceId, hash))
    return bytes ? bytes.slice() : null
  }

  async createObject(workspaceId: string, hash: string, bytes: Uint8Array, signal: AbortSignal): Promise<'created' | 'exists'> {
    signal.throwIfAborted(); this.requests.push('createObject')
    if (this.failNextObject) { this.failNextObject = false; throw new Error('transport_failed') }
    if ((await syncHash(bytes)) !== hash) throw new Error('hash_mismatch')
    const key = this.key(workspaceId, hash), current = this.objects.get(key)
    if (current) {
      if ((await syncHash(current)) !== hash) throw new Error('remote_object_corrupt')
      return 'exists'
    }
    this.objects.set(key, bytes.slice())
    return 'created'
  }

  readonly retired = new Map<string, Uint8Array>()
  readonly deviceInfo = new Map<string, Uint8Array>()

  async listRetiredDevices(workspaceId: string, signal: AbortSignal): Promise<string[]> {
    signal.throwIfAborted(); this.requests.push('listRetiredDevices')
    const prefix = `${workspaceId}/retired/`
    return [...this.retired.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)).sort()
  }

  async retireDevice(head: SyncDeviceHead, revision: string | null, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); this.requests.push('retireDevice')
    const record = this.key(head.workspaceId, `retired/${head.deviceId}`)
    // Create-only: an existing record (an earlier, interrupted retirement) is kept as it is.
    if (!this.retired.has(record)) this.retired.set(record, encodeSyncDeviceHead(head))
    const key = this.key(head.workspaceId, `devices/${head.deviceId}`), current = this.heads.get(key)
    if (!current) return
    if (revision !== null && current.revision !== revision) throw Object.assign(new Error('device_changed'), { code: 'device_changed' })
    this.heads.delete(key)
  }

  async readDeviceInfo(workspaceId: string, deviceId: string, signal: AbortSignal): Promise<Uint8Array | null> {
    signal.throwIfAborted(); this.requests.push('readDeviceInfo')
    return this.deviceInfo.get(this.key(workspaceId, `device-info/${deviceId}`))?.slice() ?? null
  }

  async publishDeviceInfo(workspaceId: string, deviceId: string, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); this.requests.push('publishDeviceInfo')
    this.deviceInfo.set(this.key(workspaceId, `device-info/${deviceId}`), bytes.slice())
  }
}
