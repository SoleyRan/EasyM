import { parseSyncHead, syncHash, type ExpectedSyncHead, type PublishSyncHeadResult, type SyncHead, type SyncProvider, type VersionedSyncHead } from './sync-contract'

/**
 * Deterministic in-process Provider for unit tests and fault injection. It models a
 * service with atomic conditional head writes; it is not evidence about any real server.
 */
export class MemorySyncProvider implements SyncProvider {
  readonly objects = new Map<string, Uint8Array>()
  head: { bytes: Uint8Array; revision: string } | null = null
  requests: string[] = []
  /** Commit the head write, then lose the response (timeout after server-side success). */
  loseNextPublishResponse = false
  /** Fail the next object upload before anything is stored. */
  failNextObject = false
  private revisions = 0

  private key(workspaceId: string, hash: string) { return `${workspaceId}/${hash}` }

  async readHead(workspaceId: string, signal: AbortSignal): Promise<VersionedSyncHead | null> {
    signal.throwIfAborted(); this.requests.push('readHead')
    if (!this.head) return null
    return { head: parseSyncHead(this.head.bytes, workspaceId), revision: this.head.revision }
  }

  async publishHead(head: SyncHead, expected: ExpectedSyncHead, signal: AbortSignal): Promise<PublishSyncHeadResult> {
    signal.throwIfAborted(); this.requests.push('publishHead')
    const matches = expected.kind === 'absent' ? this.head === null : this.head?.revision === expected.revision
    if (!matches) return { kind: 'conflict' }
    const bytes = new TextEncoder().encode(JSON.stringify(head))
    this.head = { bytes, revision: `"r${++this.revisions}"` }
    if (this.loseNextPublishResponse) { this.loseNextPublishResponse = false; return { kind: 'unknown' } }
    return { kind: 'committed', value: { head: parseSyncHead(bytes, head.workspaceId), revision: this.head.revision } }
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
}
