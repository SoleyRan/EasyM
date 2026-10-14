import { invoke } from '@tauri-apps/api/core'
import type { OpenedFile } from './storage'
import type { Workspace } from './workspace'

export interface RecentEntry { id: string; kind: 'file' | 'workspace'; name: string; location: string }
export interface NativeSession { tabs: { draftKey: string; recentId: string | null }[]; activeDraftKey: string | null; workspaceId: string | null }
export interface RecentState { entries: RecentEntry[]; session: NativeSession }
export const recentState = () => invoke<RecentState>('recent_state')
export const rememberSession = (session: NativeSession) => invoke<void>('remember_session', { session })
export const forgetRecent = (id: string | null) => invoke<void>('forget_recent', { id })
export const reopenRecentWorkspace = (id: string) => invoke<Workspace>('reopen_recent_workspace', { id })
export async function reopenRecentFile(id: string): Promise<OpenedFile> {
  const file = await invoke<Omit<OpenedFile, 'bytes'> & { bytes: number[] }>('reopen_recent_file', { id })
  return { ...file, bytes: new Uint8Array(file.bytes) }
}
export function recentError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error)
  return ({ recent_invalid_record: '最近打开记录格式不兼容或损坏，原记录已保留。', recent_invalid_session: '会话记录格式不兼容，原记录已保留。', recent_read_failed: '无法读取最近打开记录，原记录已保留。', recent_write_failed: '无法保存最近打开记录，当前文档和草稿仍保留。', recent_missing: '记录已移除，请重新选择文件。', resource_missing: '目标已移动或删除，请移除此记录或重新选择。', permission_denied: '目标权限或路径已变化，请重新选择以授权。', quota_exceeded: '目标超过当前资源上限，请重新选择。', invalid_data: '目标类型不再受支持，请移除此记录或重新选择。' } as Record<string, string>)[code] ?? `最近打开操作失败：${code}`
}
