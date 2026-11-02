import { describe, expect, it } from 'vitest'
import { encodeSyncDeviceHead } from './sync-contract'
import { detectPlatform, encodeSyncDeviceInfo, listSyncDevices, normalizeDeviceName, parseSyncDeviceInfo, queueRetirement } from './sync-devices'
import { MemorySyncProvider } from './sync-memory-provider'

const workspaceId = '1358f0a2-25b8-441b-9d55-379f6ca303dc'
const id = (n: number) => `d0d0d0d0-0000-4000-8000-${String(n).padStart(12, '0')}`
const hash = `sha256:${'a'.repeat(64)}`
const signal = () => new AbortController().signal
const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

describe('device info', () => {
  it('round-trips and normalizes the name', () => {
    const bytes = encodeSyncDeviceInfo({ schemaVersion: 1, workspaceId, deviceId: id(1), name: '  办公室 Mac  ', platform: 'macos' })
    expect(parseSyncDeviceInfo(bytes, workspaceId, id(1))).toEqual({ schemaVersion: 1, workspaceId, deviceId: id(1), name: '办公室 Mac', platform: 'macos' })
  })
  it('rejects bad names', () => {
    for (const name of ['', '   ', 'a'.repeat(65), 'tab\there', 'zero​width']) expect(() => normalizeDeviceName(name), name).toThrow('invalid_device_name')
    expect(normalizeDeviceName('😀'.repeat(64))).toHaveLength(128)
  })
  it('treats remote info as untrusted', () => {
    const good = { schemaVersion: 1, workspaceId, deviceId: id(1), name: 'A', platform: 'linux' }
    for (const value of [{ ...good, deviceId: id(2) }, { ...good, workspaceId: id(3) }, { ...good, platform: 'ios' }, { ...good, extra: 1 }, { ...good, name: '' }, { ...good, schemaVersion: 2 }]) {
      expect(() => parseSyncDeviceInfo(enc(value), workspaceId, id(1)), JSON.stringify(value)).toThrow('invalid_device_info')
    }
    expect(() => parseSyncDeviceInfo(new TextEncoder().encode('not json'), workspaceId, id(1))).toThrow('invalid_device_info')
    expect(() => parseSyncDeviceInfo(new Uint8Array(5000), workspaceId, id(1))).toThrow('invalid_device_info')
  })
  it('detects the platform from the user agent', () => {
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows')
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe('macos')
    expect(detectPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux')
    expect(detectPlatform('something else')).toBe('other')
  })
})

describe('device list', () => {
  it('lists every head with its info, this device first; unreadable info shows as unnamed', async () => {
    const provider = new MemorySyncProvider()
    for (const n of [1, 2, 3]) provider.heads.set(`${workspaceId}/devices/${id(n)}`, { bytes: encodeSyncDeviceHead({ schemaVersion: 1, workspaceId, deviceId: id(n), sequence: n, commitHash: hash }), revision: `"r${n}"` })
    provider.deviceInfo.set(`${workspaceId}/device-info/${id(1)}`, encodeSyncDeviceInfo({ schemaVersion: 1, workspaceId, deviceId: id(1), name: '甲', platform: 'windows' }))
    provider.deviceInfo.set(`${workspaceId}/device-info/${id(2)}`, enc({ forged: true }))
    const list = await listSyncDevices(provider, workspaceId, id(3), [id(2)], signal())
    expect(list.map((d) => [d.deviceId, d.name, d.self, d.retiring])).toEqual([[id(3), null, true, false], [id(1), '甲', false, false], [id(2), null, false, true]])
  })
  it('never queues this device, and keeps the queue sorted and unique', () => {
    expect(queueRetirement([id(2)], id(1), id(3))).toEqual([id(1), id(2)])
    expect(queueRetirement([id(1)], id(1), id(3))).toEqual([id(1)])
    expect(() => queueRetirement([], id(3), id(3))).toThrow('device_self')
    expect(() => queueRetirement([], 'not-an-id', id(3))).toThrow('device_self')
  })
})
