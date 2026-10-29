import { historyDiff } from './history-diff'
import { planMerge } from './merge'

/**
 * v2 step 4A: deterministic line-level three-way merge for sync. Every device that merges the same
 * three bodies must produce the same bytes, because merge commits are content-addressed and
 * computed independently on each device. So, unlike the interactive merge, nothing here depends on
 * wall-clock time: the diff runs with an unreachable deadline and is bounded only by its size and
 * memory limits, which depend on the input alone.
 */
export const MAX_SYNC_MERGE_BYTES = 2 * 1024 * 1024
const NO_DEADLINE = Number.MAX_SAFE_INTEGER

// ignoreBOM keeps a leading BOM in the text so it can be refused instead of silently dropped.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
function text(bytes: Uint8Array): string | null {
  if (bytes.byteLength > MAX_SYNC_MERGE_BYTES) return null
  try { return decoder.decode(bytes) } catch { return null }
}
const lineEnding = (value: string): 'crlf' | 'lf' | 'none' => {
  const crlf = (value.match(/\r\n/g) ?? []).length, lf = (value.match(/\n/g) ?? []).length
  return lf === 0 ? 'none' : crlf === lf ? 'crlf' : crlf === 0 ? 'lf' : 'none'
}

/**
 * Merges `left` and `right` against `base`. Returns the merged bytes, or null when the edits
 * overlap, the bodies are not UTF-8, use mixed line endings, carry a BOM, or exceed the limits;
 * the caller then keeps one version in place and the other as a conflict copy.
 */
export function mergeSyncText(base: Uint8Array, left: Uint8Array, right: Uint8Array): Uint8Array | null {
  const bodies = [base, left, right].map(text)
  if (bodies.some((body) => body === null || body.startsWith('﻿') || body.includes('\0'))) return null
  const [o, l, r] = bodies as string[]
  // Line endings must agree on both sides so the merge never rewrites them silently.
  const endings = new Set([l, r].map(lineEnding).filter((ending) => ending !== 'none'))
  if (endings.size > 1 || [o, l, r].some((body) => /\r(?!\n)/.test(body))) return null
  const crlf = endings.has('crlf')
  const plan = planMerge(o, l, r, NO_DEADLINE)
  if (plan.status !== 'clean' || plan.text === undefined) return null
  const merged = crlf ? plan.text.replace(/\n/g, '\r\n') : plan.text
  const bytes = new TextEncoder().encode(merged)
  return bytes.byteLength > MAX_SYNC_MERGE_BYTES ? null : bytes
}

/** Exposed for tests: the diff limits that bound the merge without a clock. */
export const syncMergeDiff = (before: string, after: string) => historyDiff(before, after, NO_DEADLINE)

/**
 * Merges the images of two document versions for a merged body. Each image path takes one object:
 * the one both sides agree on, or the one a single side changed. A path both sides changed
 * differently is a conflict (null). The result keeps only paths the merged body still needs.
 */
export function mergeSyncResources<T extends { path: string; object: string }>(base: readonly T[], left: readonly T[], right: readonly T[], needed: ReadonlySet<string>): T[] | null {
  const o = new Map(base.map((r) => [r.path, r])), l = new Map(left.map((r) => [r.path, r])), r = new Map(right.map((x) => [x.path, x]))
  const out: T[] = []
  for (const path of [...new Set([...l.keys(), ...r.keys()])].sort()) {
    if (!needed.has(path)) continue
    const x = l.get(path), y = r.get(path), b = o.get(path)
    if (!x || !y || x.object === y.object) { out.push((x ?? y)!); continue }
    if (b?.object === x.object) out.push(y)
    else if (b?.object === y.object) out.push(x)
    else return null
  }
  return out
}

interface MetadataInstance { displayPath: string; [key: string]: unknown }
const metadataKey = (instance: MetadataInstance) => JSON.stringify(instance)
const parseMetadata = (bytes: Uint8Array | null): MetadataInstance[] | null => {
  if (!bytes) return []
  try {
    const value = JSON.parse(decoder.decode(bytes)) as { schemaVersion?: unknown; instances?: unknown }
    if (value.schemaVersion !== 1 || !Array.isArray(value.instances)) return null
    return value.instances.every((i) => i && typeof i === 'object' && typeof (i as MetadataInstance).displayPath === 'string') ? value.instances as MetadataInstance[] : null
  } catch { return null }
}

/**
 * Merges per-document image metadata the same way as resources: one instance per display path,
 * keyed by its full canonical JSON. Returns the instances to keep, or null on a real conflict or
 * unreadable metadata.
 */
export function mergeSyncMetadata(base: Uint8Array | null, left: Uint8Array | null, right: Uint8Array | null, needed: ReadonlySet<string>): MetadataInstance[] | null {
  const parsed = [base, left, right].map(parseMetadata)
  if (parsed.some((value) => value === null)) return null
  const [o, l, r] = (parsed as MetadataInstance[][]).map((list) => list.map((instance) => ({ path: instance.displayPath, object: metadataKey(instance), instance })))
  const merged = mergeSyncResources(o, l, r, needed)
  return merged && merged.map((item) => item.instance).sort((a, b) => (a.displayPath < b.displayPath ? -1 : 1))
}
