import { invoke } from '@tauri-apps/api/core'
import { syncHash } from '../core/sync-contract'
import { encodeWorkspaceIdentity, parseWorkspaceIdentity, reconcileIdentity, resolveIdentity, type DiskDocument, type IdentityResolution, type ReconcilePlan, type WorkspaceIdentity } from '../core/sync-identity'

interface IdentityScan { identity: number[] | null; identityError: string | null; documents: DiskDocument[]; unreadable: string[] }

/** Preview of a workspace identity change. Nothing is written until `commit` is called. */
export interface IdentityPreview {
  workspaceId: string
  /** Digest of the identity bytes the plan was computed from; null when enabling for the first time. */
  baseRevision: string | null
  plan: ReconcilePlan
  enabled: boolean
}

export class IdentityScanError extends Error {
  constructor(readonly code: 'identity_unreadable' | 'scan_incomplete', readonly detail: string[] = []) { super(code); this.name = 'IdentityScanError' }
}

/**
 * Scans the workspace and computes a plan. An incomplete scan or an unreadable identity file
 * stops here: a partial view would make present documents look deleted.
 */
export async function previewIdentity(workspace: string): Promise<IdentityPreview> {
  const scan = await invoke<IdentityScan>('sync_identity_scan', { id: workspace })
  if (scan.identityError) throw new IdentityScanError('identity_unreadable', [scan.identityError])
  if (scan.unreadable.length) throw new IdentityScanError('scan_incomplete', scan.unreadable)
  const bytes = scan.identity ? new Uint8Array(scan.identity) : null
  const current = bytes ? parseWorkspaceIdentity(bytes) : null
  const plan = reconcileIdentity(current, scan.documents, () => crypto.randomUUID(), () => crypto.randomUUID())
  return { workspaceId: plan.identity.workspaceId, baseRevision: bytes ? await syncHash(bytes) : null, plan, enabled: !!current }
}

/** Writes the plan (plus explicit resolutions) only if the identity file is unchanged since preview. */
export async function commitIdentity(workspace: string, preview: IdentityPreview, resolutions: IdentityResolution[] = []): Promise<WorkspaceIdentity> {
  const identity = resolutions.length ? resolveIdentity(preview.plan, resolutions, () => crypto.randomUUID()) : preview.plan.identity
  await invoke<string>('sync_identity_write', { id: workspace, expected: preview.baseRevision, bytes: Array.from(encodeWorkspaceIdentity(identity)) })
  return identity
}

/** Undo enabling: removes only `.easym/sync/workspace.json`, and only if it is the expected version. */
export async function disableIdentity(workspace: string, revision: string): Promise<void> {
  await invoke('sync_identity_remove', { id: workspace, expected: revision })
}

export function identityError(error: unknown): string {
  const code = error instanceof IdentityScanError ? error.code : error instanceof Error ? (error as { code?: string }).code ?? error.message : String(error)
  const messages: Record<string, string> = {
    identity_unreadable: '同步身份文件无法读取或格式无效；已保留原文件，请检查 .easym/sync/workspace.json。',
    scan_incomplete: '部分目录无法读取，扫描不完整；为避免误判删除，未更改身份。',
    revision_conflict: '同步身份已被其他操作更改，请重新预览。',
    quota_exceeded: '工作区超过同步身份扫描上限（10000 个文档、深度 32）。',
    unsupported_schema: '同步身份文件版本较新；已保留原文件，请使用新版 EasyM。',
    invalid_identity: '同步身份文件或所选处理无效；未写入任何更改。',
    duplicate_identity: '存在重复的文档身份；请检查 .easym/sync/workspace.json。',
    path_conflict: '存在仅大小写不同的文档路径；请先重命名其中一个。',
  }
  return messages[code] ?? `同步身份操作失败（${code}）。`
}
