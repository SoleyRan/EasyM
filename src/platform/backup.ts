import { invoke } from '@tauri-apps/api/core'
import { historyInput, historyError } from './history'
import { collectHistoryResources } from './history-resources'
import type { ImageResources } from './images'

export interface BackupDraft { id: string | null; name: string; bytes: Uint8Array | null; error: string; resources: ImageResources; revision: string | null }
export interface BackupSummary { documentName: string; createdAt: number; files: number; bytes: number; includesHistory: boolean; packageHash: string }
export interface BackupInspection { token: string; summary: BackupSummary; reviews: { text: string; availableReferences: string[] }[] }
export async function createBackup(draft: BackupDraft, includeHistory: boolean): Promise<BackupSummary | null> {
  if (!draft.bytes) throw new Error(draft.error)
  if (includeHistory && !draft.id) throw new Error('history_disabled')
  const input = await historyInput(draft.bytes, draft.resources, draft.revision)
  if (input.unarchivedReferences.length) throw new Error('backup_resource_missing')
  return invoke('create_document_backup', { input: { ...input, id: draft.id, name: draft.name, includeHistory, expectedRevision: draft.revision } })
}
export const inspectBackup = () => invoke<BackupInspection | null>('inspect_document_backup')
export const releaseBackup = (token: string) => invoke<void>('release_document_backup', { token })
export async function validateBackup(inspection: BackupInspection): Promise<string[][]> {
  if (!inspection.token || !inspection.reviews.length || inspection.reviews.length > 10000) throw new Error('backup_corrupt')
  let bytes = 0, references = 0
  const encoder = new TextEncoder()
  for (const review of inspection.reviews) {
    if (review.text.length > 10 * 1024 * 1024) throw new Error('quota_exceeded')
    const size = encoder.encode(review.text).byteLength
    bytes += size; references += review.availableReferences.length
    if (size > 10 * 1024 * 1024 || bytes > 74 * 1024 * 1024 || references > 65536 + 4096) throw new Error('quota_exceeded')
  }
  const scans = await collectHistoryResources(inspection.reviews.map(review => review.text))
  return scans.map((scan, index) => {
    const available = new Set(inspection.reviews[index].availableReferences)
    if (scan.unarchivedReferences.length || available.size !== inspection.reviews[index].availableReferences.length || scan.references.some(path => !available.has(path)) || (index === 0 && scan.references.length !== available.size)) throw new Error('backup_resource_missing')
    return scan.references
  })
}
export const restoreBackup = (token: string, references: string[][]) => invoke<string | null>('restore_document_backup', { token, references })
export const backupError = (error: unknown): string => {
  const code = error instanceof Error ? error.message : String(error)
  return ({ backup_corrupt: '备份结构、路径或哈希校验失败，已停止恢复。', backup_read_only: '备份格式版本较新或不受支持，请使用兼容版本的 EasyM。', backup_resource_missing: '本地图片缺失、路径不安全或正文与归档资源不一致，已停止操作。远程图片仅保留链接。', backup_exists: '目标备份已经存在，请选择新的文件名；未覆盖原文件。', backup_extension: '备份文件名必须以 .easym-backup.zip 结尾。', backup_expired: '备份审查已过期，请重新选择并校验备份。', backup_changed: '备份文件在审查后发生变化，请重新选择并校验。', backup_sessions_full: '备份审查会话已达上限，请关闭其他审查窗口后重试。', quota_exceeded: '备份超出大小、条目数或解压限制，已停止操作。', mixed_line_endings: '正文已修改且原文件使用混合换行，请先确认换行格式并另存，再创建备份。', history_analysis_failed: '正文图片分析失败或超时，请重试。', io_failed: '备份读写或校验失败，未完成发布；请检查目录权限和磁盘空间。' } as Record<string, string>)[code] ?? historyError(error)
}
