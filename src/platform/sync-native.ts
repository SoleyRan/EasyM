import { invoke } from '@tauri-apps/api/core'
import { encodeSyncDeviceHead, parseSyncDeviceHead, syncHash, type ExpectedSyncHead, type PublishSyncHeadResult, type SyncDeviceHead, type SyncProvider, type VersionedDeviceHead } from '../core/sync-contract'
import type { SyncDeviceState } from '../core/sync-log'
import type { EngineState } from '../core/sync-engine'

/** What the webview knows about a binding: no password and no local path. */
export interface SyncBinding { bindingId: string; workspaceId: string; deviceId: string; endpoint: string; username: string; createdAt: number }
interface HeadBytes { deviceId: string; bytes: number[]; revision: string | null }

const bytes = (value: number[] | Uint8Array) => value instanceof Uint8Array ? value : new Uint8Array(value)

export const syncBinding = (workspace: string) => invoke<SyncBinding | null>('sync_binding', { id: workspace })
/** Checks endpoint and credentials and lists remote workspace ids; stores nothing. */
export const probeEndpoint = (endpoint: string, username: string, password: string) => invoke<string[]>('sync_probe', { endpoint, username, password })
/** Requires an enabled sync identity; the password goes to the OS credential store only. */
export const bindWorkspace = (workspace: string, endpoint: string, username: string, password: string) => invoke<SyncBinding>('sync_bind', { id: workspace, endpoint, username, password })
/** Exit sync: removes binding, credential, state and cache. Workspace and remote are kept. */
export const unbindWorkspace = (workspace: string) => invoke<void>('sync_unbind', { id: workspace })

/**
 * Persisted engine state. `workspaceId`/`deviceId` sit at the top level because the native side
 * refuses state that does not belong to the binding.
 */
export async function readSyncState(workspace: string): Promise<EngineState | null> {
  const raw = await invoke<number[] | null>('sync_state_read', { id: workspace })
  if (!raw) return null
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes(raw))) as { workspaceId?: string; deviceId?: string } & Partial<EngineState>
  const device = value.device as SyncDeviceState | undefined
  if (!device || typeof device.sequence !== 'number' || (device.commitHash !== null && typeof device.commitHash !== 'string') || typeof device.seen !== 'object'
    || device.workspaceId !== value.workspaceId || device.deviceId !== value.deviceId
    || (value.applied !== null && typeof value.applied !== 'string') || !Array.isArray(value.deferred)
    || (value.conflicts !== undefined && !Array.isArray(value.conflicts))) throw new Error('sync_state_invalid')
  // Older state has no conflict list; malformed entries are dropped rather than trusted.
  const conflicts = (value.conflicts ?? []).filter((c) => c && typeof c.documentId === 'string' && typeof c.copyId === 'string' && (c.kind === 'merge' || c.kind === 'local') && (c.base === null || typeof c.base === 'string'))
  return { device, applied: value.applied ?? null, deferred: value.deferred, conflicts }
}
export const writeSyncState = (workspace: string, state: EngineState) =>
  invoke<void>('sync_state_write', { id: workspace, bytes: Array.from(new TextEncoder().encode(JSON.stringify({ workspaceId: state.device.workspaceId, deviceId: state.device.deviceId, ...state }))) })

/**
 * SyncProvider over the native WebDAV commands of one bound workspace. Every call is checked
 * against the binding's workspaceId so the core cannot address another namespace by mistake.
 */
export class NativeSyncProvider implements SyncProvider {
  constructor(private readonly workspace: string, private readonly binding: SyncBinding) {}
  private check(workspaceId: string, signal: AbortSignal) {
    signal.throwIfAborted()
    if (workspaceId !== this.binding.workspaceId) throw new Error('workspace_mismatch')
  }
  async listDeviceHeads(workspaceId: string, signal: AbortSignal): Promise<VersionedDeviceHead[]> {
    this.check(workspaceId, signal)
    const heads = await invoke<HeadBytes[]>('sync_heads', { id: this.workspace })
    return heads.map((head) => ({ head: parseSyncDeviceHead(bytes(head.bytes), workspaceId, head.deviceId), revision: head.revision }))
  }
  async readDeviceHead(workspaceId: string, deviceId: string, signal: AbortSignal): Promise<VersionedDeviceHead | null> {
    this.check(workspaceId, signal)
    const head = await invoke<HeadBytes | null>('sync_head', { id: this.workspace, device: deviceId })
    return head ? { head: parseSyncDeviceHead(bytes(head.bytes), workspaceId, deviceId), revision: head.revision } : null
  }
  async publishDeviceHead(head: SyncDeviceHead, expected: ExpectedSyncHead, signal: AbortSignal): Promise<PublishSyncHeadResult> {
    this.check(head.workspaceId, signal)
    if (head.deviceId !== this.binding.deviceId) throw new Error('permission_denied')
    const condition = expected.kind === 'absent' ? null : expected.kind === 'owned' ? '' : expected.revision
    const result = await invoke<{ kind: string; revision: string | null }>('sync_publish', { id: this.workspace, bytes: Array.from(encodeSyncDeviceHead(head)), expected: condition })
    if (result.kind === 'committed') return { kind: 'committed', revision: result.revision }
    if (result.kind === 'conflict') return { kind: 'conflict' }
    return { kind: 'unknown' }
  }
  async readObject(workspaceId: string, hash: string, signal: AbortSignal): Promise<Uint8Array | null> {
    this.check(workspaceId, signal)
    const raw = await invoke<number[] | null>('sync_object', { id: this.workspace, hash })
    if (!raw) return null
    const value = bytes(raw)
    // Native code already verified the hash; checking again keeps the core's trust boundary local.
    if ((await syncHash(value)) !== hash) throw new Error('hash_mismatch')
    return value
  }
  async createObject(workspaceId: string, hash: string, value: Uint8Array, signal: AbortSignal): Promise<'created' | 'exists'> {
    this.check(workspaceId, signal)
    const result = await invoke<string>('sync_put_object', { id: this.workspace, hash, bytes: Array.from(value) })
    return result === 'exists' ? 'exists' : 'created'
  }
}

/** v2 step 4B: writes a conflict resolution; both earlier versions go to the in-app trash. */
export interface ResolveConflictRequest { path: string; expected: string; copy: string; copyExpected: string; bytes: Uint8Array | null; snapshotPath: string }
export const resolveSyncConflict = (workspace: string, request: ResolveConflictRequest) => invoke<string>('sync_local_resolve', { id: workspace, request: {
  path: request.path, expected: request.expected, copy: request.copy, copyExpected: request.copyExpected,
  bytes: request.bytes ? Array.from(request.bytes) : null, snapshotPath: request.snapshotPath,
  saveOperation: crypto.randomUUID(), snapshotOperation: crypto.randomUUID(), copyOperation: crypto.randomUUID(),
} })

export function syncError(error: unknown): string {
  const code = error instanceof Error ? (error as { code?: string }).code ?? error.message : String(error)
  const messages: Record<string, string> = {
    endpoint_invalid: '服务器地址无效；请填写 WebDAV 目录的完整地址，不要包含用户名、密码或查询参数。',
    endpoint_insecure: '只允许 HTTPS 地址（本机测试地址除外）；为保护密码，不支持明文 HTTP。',
    endpoint_redirected: '服务器要求跳转到其他地址；为避免把密码发送到其他站点，请直接填写跳转后的地址。',
    unauthorized: '用户名或密码不正确，或没有该目录的访问权限。',
    certificate_invalid: '服务器证书无法验证；EasyM 不会跳过证书校验，请检查服务器配置。',
    connect_failed: '无法连接服务器；请检查网络和地址。',
    timeout: '连接服务器超时；当前编辑已保存在本地，可稍后重试。',
    quota_exceeded: '服务器空间不足或单个文件超出服务器限制。',
    credential_store_unavailable: '系统凭据存储不可用；EasyM 不会把密码写入文件。',
    credential_missing: '找不到该工作区保存的密码；请重新连接。',
    identity_missing: '请先在“同步身份”中启用工作区身份。',
    binding_exists: '该工作区已连接同步服务器。',
    binding_missing: '该工作区尚未连接同步服务器。',
    invalid_listing: '服务器返回的设备列表不完整或包含未知内容；为避免误判，已停止同步。',
    too_many_devices: '远端设备数量超过 64 台上限，已暂停同步。',
    hash_mismatch: '远端对象内容与摘要不符；已拒绝使用该数据。',
    document_open: '请先关闭冲突副本的标签页再解决冲突。',
    document_dirty: '本文档有未保存的修改；请先保存或放弃后再解决冲突。',
    revision_conflict: '文档在你选择之后又被修改，未做任何改动；请重新打开冲突再选择。',
    target_exists: '用于保存解决前版本的文件名已被占用，请稍后重试。',
  }
  if (code.startsWith('server_busy')) return '服务器繁忙或暂时锁定文件；稍后会重试。'
  return messages[code] ?? `同步失败（${code}）。`
}
