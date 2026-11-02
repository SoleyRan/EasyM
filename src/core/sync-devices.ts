import { isSyncId, MAX_SYNC_HEAD_BYTES, MERGE_DEVICE_ID, type SyncProvider } from './sync-contract'

/**
 * v2 step 5A: remote device management.
 *
 * Layout next to `devices/` (whose listing stays strict: only `<deviceId>.json` heads):
 *  - `retired/<deviceId>.json`: a retirement record, created once and never changed. Its bytes are
 *    the device head as it was when retired. A retired device's head is ignored by every device,
 *    and its disappearance is not a rollback. A device only retires another one after its own
 *    published head contains that device's last head, so nothing it published is dropped.
 *  - `device-info/<deviceId>.json`: name and platform, written only by the device itself (on
 *    connecting, rejoining and renaming) and read only when the user opens the device list. Not
 *    part of any commit. The last sync time comes from the server's Last-Modified of the head.
 */
export const MAX_SYNC_DEVICE_NAME = 64
export const SYNC_PLATFORMS = ['windows', 'macos', 'linux', 'other'] as const
export type SyncPlatform = (typeof SYNC_PLATFORMS)[number]

export interface SyncDeviceInfo {
  schemaVersion: 1
  workspaceId: string
  deviceId: string
  name: string
  platform: SyncPlatform
}

export class SyncDeviceError extends Error {
  readonly code: 'invalid_device_info' | 'invalid_device_name' | 'device_unmerged' | 'device_changed' | 'device_self'
  constructor(code: SyncDeviceError['code']) { super(code); this.code = code; this.name = 'SyncDeviceError' }
}

/** Trimmed, NFC, 1–64 characters, no control characters. */
export function normalizeDeviceName(value: string): string {
  const name = value.normalize('NFC').trim()
  if (!name || [...name].length > MAX_SYNC_DEVICE_NAME || /[\p{Cc}\p{Cf}]/u.test(name)) throw new SyncDeviceError('invalid_device_name')
  return name
}

export const encodeSyncDeviceInfo = (info: SyncDeviceInfo): Uint8Array => new TextEncoder().encode(JSON.stringify({
  schemaVersion: 1, workspaceId: info.workspaceId, deviceId: info.deviceId, name: normalizeDeviceName(info.name), platform: info.platform,
}))

/** Remote JSON is untrusted: exact keys, the device named by the location, bounded values. */
export function parseSyncDeviceInfo(bytes: Uint8Array, workspaceId: string, deviceId: string): SyncDeviceInfo {
  const fail = (): never => { throw new SyncDeviceError('invalid_device_info') }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SYNC_HEAD_BYTES) fail()
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)) } catch { return fail() }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  const info = value as Record<string, unknown>
  const keys = ['schemaVersion', 'workspaceId', 'deviceId', 'name', 'platform']
  if (Object.keys(info).length !== keys.length || !keys.every((key) => Object.hasOwn(info, key))) fail()
  if (info.schemaVersion !== 1 || info.workspaceId !== workspaceId || info.deviceId !== deviceId || !isSyncId(deviceId) || deviceId === MERGE_DEVICE_ID) fail()
  if (typeof info.name !== 'string' || !SYNC_PLATFORMS.includes(info.platform as SyncPlatform)) fail()
  let name: string
  try { name = normalizeDeviceName(info.name as string) } catch { return fail() }
  return { schemaVersion: 1, workspaceId, deviceId, name, platform: info.platform as SyncPlatform }
}

export function defaultDeviceName(platform: SyncPlatform): string {
  return { windows: 'Windows 设备', macos: 'Mac 设备', linux: 'Linux 设备', other: '其他设备' }[platform]
}

export function detectPlatform(userAgent: string): SyncPlatform {
  return /Windows/i.test(userAgent) ? 'windows' : /Mac OS X|Macintosh/i.test(userAgent) ? 'macos' : /Linux/i.test(userAgent) ? 'linux' : 'other'
}

export interface SyncDeviceView {
  deviceId: string
  /** null when the device never wrote its info (older builds) or it is unreadable. */
  name: string | null
  platform: SyncPlatform | null
  /** Server time the device last published, ms; null when the server gave none. */
  lastSync: number | null
  sequence: number
  self: boolean
  /** Deactivation queued on this device and not yet completed. */
  retiring: boolean
}

/**
 * The device list shown in the sync dialog: every head on the server with its info. Unreadable
 * info is shown as unnamed, never trusted. Sorted with this device first, then by last sync.
 */
export async function listSyncDevices(provider: SyncProvider, workspaceId: string, selfId: string, retiring: readonly string[], signal: AbortSignal): Promise<SyncDeviceView[]> {
  const heads = await provider.listDeviceHeads(workspaceId, signal)
  const views: SyncDeviceView[] = []
  for (const { head, modified } of heads) {
    let info: SyncDeviceInfo | null = null
    try {
      const bytes = await provider.readDeviceInfo(workspaceId, head.deviceId, signal)
      info = bytes && parseSyncDeviceInfo(bytes, workspaceId, head.deviceId)
    } catch (error) { if ((error as { code?: string }).code !== 'invalid_device_info') throw error }
    views.push({ deviceId: head.deviceId, name: info?.name ?? null, platform: info?.platform ?? null, lastSync: modified ?? null, sequence: head.sequence, self: head.deviceId === selfId, retiring: retiring.includes(head.deviceId) })
  }
  return views.sort((a, b) => Number(b.self) - Number(a.self) || (b.lastSync ?? 0) - (a.lastSync ?? 0) || (a.deviceId < b.deviceId ? -1 : 1))
}

/** Adds `deviceId` to the queued deactivations of `retire`; this device can never retire itself. */
export function queueRetirement(retire: readonly string[] | undefined, deviceId: string, selfId: string): string[] {
  if (deviceId === selfId || !isSyncId(deviceId)) throw new SyncDeviceError('device_self')
  return [...new Set([...(retire ?? []), deviceId])].sort()
}
