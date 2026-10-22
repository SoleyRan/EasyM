import { invoke } from '@tauri-apps/api/core'
import { rewriteIncoming, rewriteOutgoing } from '../core/link-rewrite'
import { isPortableSyncPath } from '../core/sync-commit'

interface Candidate { path: string; bytes: number[]; revision: string }
interface Prepared { from: string; to: string; candidates: Candidate[] }
export interface RenamePlan {
  from: string; to: string
  /** Other documents whose links will be updated, with how many links change. */
  incoming: { path: string; links: number }[]
  /** Links inside the renamed document that change (only for moves; renames keep them). */
  outgoing: number
  /** Documents that could not be decoded and are left unchanged. */
  skipped: string[]
  rewrites: { path: string; expected: string; bytes: number[] }[]
}
export interface RenameResult { path: string; warnings: string[] }
export interface TrashEntry { operationId: string; path: string; deletedAt: number; documentId: string | null }

export function renameTarget(from: string, name: string): string {
  const trimmed = name.normalize('NFC')
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\')) throw new Error('invalid_name')
  const directory = from.split('/').slice(0, -1)
  const to = [...directory, /\.(?:md|markdown)$/i.test(trimmed) ? trimmed : `${trimmed}.md`].join('/')
  if (!isPortableSyncPath(to)) throw new Error('invalid_name')
  return to
}

/**
 * Read-only planning: the native side validates the rename and returns the other documents;
 * links are rewritten here byte-exactly, preserving each file's BOM and line endings.
 */
export async function planRename(workspace: string, from: string, to: string): Promise<RenamePlan> {
  const prepared = await invoke<Prepared>('workspace_rename_prepare', { id: workspace, from, to })
  const plan: RenamePlan = { from, to, incoming: [], outgoing: 0, skipped: [], rewrites: [] }
  for (const candidate of prepared.candidates) {
    // Rewrite the raw text (BOM, CRLF and mixed line endings kept); only URL spans change.
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(new Uint8Array(candidate.bytes))
      if (text.includes('\0')) throw new Error('binary')
    } catch { plan.skipped.push(candidate.path); continue }
    const encode = (next: string) => Array.from(new TextEncoder().encode(next))
    if (candidate.path === from) {
      // Links to itself follow the new name; other relative links move with it (same directory: unchanged).
      const self = rewriteIncoming(text, from, from, to)
      const moved = rewriteOutgoing(self.text, from, to)
      plan.outgoing = self.changed + moved.changed
      if (plan.outgoing) plan.rewrites.push({ path: from, expected: candidate.revision, bytes: encode(moved.text) })
      continue
    }
    const result = rewriteIncoming(text, candidate.path, from, to)
    if (!result.changed) continue
    plan.incoming.push({ path: candidate.path, links: result.changed })
    plan.rewrites.push({ path: candidate.path, expected: candidate.revision, bytes: encode(result.text) })
  }
  return plan
}

export const commitRename = (workspace: string, plan: RenamePlan) =>
  invoke<RenameResult>('workspace_rename', { id: workspace, operationId: crypto.randomUUID(), from: plan.from, to: plan.to, rewrites: plan.rewrites })
export const trashDocument = (workspace: string, path: string, expected: string | null = null) =>
  invoke<{ operationId: string; path: string; documentId: string | null; warning: string | null }>('workspace_trash', { id: workspace, operationId: crypto.randomUUID(), path, expected })
export const listTrash = (workspace: string) => invoke<TrashEntry[]>('workspace_trash_list', { id: workspace })
export const restoreTrash = (workspace: string, operationId: string) => invoke<{ path: string; warning: string | null }>('workspace_trash_restore', { id: workspace, operationId })

export function workspaceOpError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error)
  const messages: Record<string, string> = {
    invalid_name: '文件名无效：需为 .md/.markdown，且不能含 / \\ : * ? " < > |、不能以点或空格结尾，也不能是 CON、AUX 等保留名。',
    target_exists: '同名文档已存在；未做任何更改。',
    cross_directory: '跨目录移动将在后续版本提供；当前仅支持同目录重命名。',
    save_pending: '该文档有未完成的保存恢复记录，请先重新打开该文档完成恢复。',
    history_name_taken: '新名称已有版本历史记录，为避免合并两份历史，请换一个名称。',
    revision_conflict: '有文档在预览后被修改；未做任何更改，请重试。',
    document_open: '该文档已在标签页中打开；请先关闭标签页再重命名或删除。',
    quota_exceeded: '工作区文档过多或过大，无法安全分析链接；未做任何更改。',
    journal_corrupt: '重命名恢复记录损坏；已保留原始文件，请检查 .easym/sync/operations。',
  }
  return messages[code] ?? `操作失败（${code}）。`
}
