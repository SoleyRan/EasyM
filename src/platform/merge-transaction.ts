import { invoke } from '@tauri-apps/api/core'
import { decodeFile, encodeFile, type FileSnapshot } from '../core/codec'
import { collectHistoryResources } from './history-resources'
import type { ImageResources } from './images'

export type MergeFormat = 'local' | 'disk'
export interface MergeCandidate { base: string; local: string; disk: string; text: string; format: MergeFormat; confirmed: boolean }
export interface MergePrepared { operationId: string; recoveryPath: string }
export interface MergeCommitted { revision: string; warning?: string | null; recoveryPath: string }
export interface MergeRecord { operationId: string; createdAt: number; recoveryPath: string; resultRevision: string }
export type RecoverySide = 'base' | 'local' | 'disk' | 'result'

// Always encode the selected policy explicitly, even when text equals a mixed-ending snapshot.
export function mergeBytes(text: string, format: FileSnapshot): Uint8Array {
  if (text.includes('\0') || text.includes('\r')) throw new Error('合并正文必须为规范化文本。')
  const body = format.lineEnding === 'crlf' ? text.replace(/\n/g, '\r\n') : text
  const bytes = new TextEncoder().encode((format.encoding === 'utf-8-bom' ? '\uFEFF' : '') + body)
  if (bytes.length > 10 * 1024 * 1024) throw new Error('合并正文超过 10 MiB。')
  return bytes
}

export async function prepareMerge(id: string, baseRevision: string, diskRevision: string, base: FileSnapshot, local: string, disk: FileSnapshot, result: Uint8Array, resources: ImageResources): Promise<MergePrepared> {
  const refs = await collectHistoryResources([base.originalText, local, disk.text, decodeFile(result).text])
  if (refs[0].references.length || refs[2].references.length || refs.some(ref => ref.unarchivedReferences.length)) throw new Error('merge_resources_unverified')
  const paths = new Set([...refs[1].references, ...refs[3].references])
  const instances = resources.instances.filter(i => paths.has(i.displayPath))
  instances.forEach(i => { paths.add(i.sourcePath); paths.add(i.displayPath) })
  const assets = []
  let total = 0
  for (const path of paths) {
    const blob = resources.assets[path]
    if (!blob) throw new Error('merge_resources_unverified')
    total += blob.size; if (total > 128 * 1024 * 1024) throw new Error('当前文档图片资源超过 128 MiB。')
    assets.push({ path, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) })
  }
  return invoke<MergePrepared>('prepare_merge', { id, input: {
    baseRevision, diskRevision, base: Array.from(base.originalBytes), local: Array.from(encodeFile(base, local, base.lineEnding === 'mixed' ? 'lf' : undefined)),
    disk: Array.from(disk.originalBytes), result: Array.from(result), references: refs,
    assets, metadata: { schemaVersion: 1, instances },
  } })
}
export const commitMerge = (id: string, operationId: string) => invoke<MergeCommitted>('commit_merge', { id, operationId })
export const listMergeRecovery = (id: string) => invoke<{ records: MergeRecord[]; warnings: string[] }>('merge_recovery', { id })
export const restoreMergeCopy = (id: string, operationId: string, side: RecoverySide) => invoke<{ path: string } | null>('merge_recovery', { id, operationId, side })
export function mergeError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error)
  return ({ revision_conflict: '磁盘版本再次变化，未应用合并。请关闭窗口，重新检查并分析；已经创建的恢复记录仍可取回。',
    merge_resources_unverified: '无法验证双方本地图片或实例的一致性，已阻止合并。请另存本地副本后处理图片冲突。',
    merge_archive_corrupt: '合并恢复记录校验失败，已停止操作并保留当前文件。',
    merge_archive_quota: '合并恢复目录达到 512 MiB / 128 项限制，已阻止写回。请先备份并手动整理恢复目录。',
    permission_denied: '没有文件或恢复目录访问权限，未应用合并。',
    io_failed: '合并归档或提交失败，本地编辑保持不变；请检查磁盘并重新检查外部版本。',
  } as Record<string, string>)[code] ?? code
}
