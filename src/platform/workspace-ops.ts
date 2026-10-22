import { invoke } from '@tauri-apps/api/core'
import { linkUrls, rewriteIncoming, rewriteOutgoing } from '../core/link-rewrite'
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
  /** Cross-directory moves: managed images the document references, copied to the target. */
  images: string[]
}
export interface RenameResult { path: string; warnings: string[]; sessions: string[] }

/** EasyM-managed image paths, relative to the document: these are copied, never re-linked. */
const MANAGED = /^assets\/(?:\.originals\/)?img-[a-zA-Z0-9-]+\.(?:png|jpg)$/
export const isManagedImage = (path: string) => MANAGED.test(path)

/** `notes/a.md` → `archive/a.md`: moves keep the file name; the directory must already exist. */
export function moveTarget(from: string, directory: string): string {
  const name = from.split('/').at(-1) ?? from
  const to = directory ? `${directory}/${name}` : name
  if (to === from || !isPortableSyncPath(to)) throw new Error('invalid_name')
  return to
}
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
  const plan: RenamePlan = { from, to, incoming: [], outgoing: 0, skipped: [], rewrites: [], images: [] }
  const fromDir = from.split('/').slice(0, -1).join('/'), toDir = to.split('/').slice(0, -1).join('/')
  const moving = fromDir !== toDir
  for (const candidate of prepared.candidates) {
    // Rewrite the raw text (BOM, CRLF and mixed line endings kept); only URL spans change.
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(new Uint8Array(candidate.bytes))
      if (text.includes('\0')) throw new Error('binary')
    } catch { plan.skipped.push(candidate.path); continue }
    const encode = (next: string) => Array.from(new TextEncoder().encode(next))
    if (candidate.path === from) {
      // Links to itself follow the new name. On a move, managed images travel with the document
      // (same relative path at the target) while every other relative link is re-pointed.
      const self = rewriteIncoming(text, from, from, to)
      const keep = new Map<string, string>()
      if (moving) for (const image of managedImages(self.text)) {
        plan.images.push(image)
        const prefix = fromDir ? `${fromDir}/` : '', target = toDir ? `${toDir}/` : ''
        keep.set(prefix + image, target + image)
      }
      const moved = rewriteOutgoing(self.text, from, to, keep)
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

/** Managed images referenced by the document body (links, images and definitions). */
function managedImages(text: string): string[] {
  const found = new Set<string>()
  for (const url of linkUrls(text)) {
    let path: string
    try { path = decodeURIComponent(url.split(/[?#]/)[0]).replace(/^\.\//, '') } catch { continue }
    if (isManagedImage(path)) found.add(path)
  }
  return [...found].sort()
}

export const commitRename = (workspace: string, plan: RenamePlan) =>
  invoke<RenameResult>('workspace_rename', { id: workspace, operationId: crypto.randomUUID(), from: plan.from, to: plan.to, rewrites: plan.rewrites, resources: { references: plan.images } })
export const listDirectories = (workspace: string) => invoke<string[]>('workspace_directories', { id: workspace })
export const trashDocument = (workspace: string, path: string, expected: string | null = null) =>
  invoke<{ operationId: string; path: string; documentId: string | null; warning: string | null }>('workspace_trash', { id: workspace, operationId: crypto.randomUUID(), path, expected })
export const listTrash = (workspace: string) => invoke<TrashEntry[]>('workspace_trash_list', { id: workspace })
export const restoreTrash = (workspace: string, operationId: string) => invoke<{ path: string; warning: string | null }>('workspace_trash_restore', { id: workspace, operationId })

/** Non-fatal follow-ups reported after a committed rename/move. */
export function renameWarning(code: string): string {
  if (code === 'merge_records_previous_name') return '合并恢复记录仍按原文件名列出'
  if (code === 'recent_not_updated') return '最近打开记录未更新'
  if (code.startsWith('link_skipped:')) return `${code.slice(13)} 在操作期间被修改，未更新其中的链接`
  if (code.startsWith('identity:')) return '同步身份未更新，请在“同步身份”中处理'
  return code
}

export function workspaceOpError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error)
  const messages: Record<string, string> = {
    invalid_name: '文件名无效：需为 .md/.markdown，且不能含 / \\ : * ? " < > |、不能以点或空格结尾，也不能是 CON、AUX 等保留名。',
    target_exists: '同名文档已存在；未做任何更改。',
    cross_directory: '无法移动到该目录。',
    target_missing: '目标目录不存在或已被移走；请刷新文件树后重试。',
    resource_conflict: '目标目录已有同名但内容不同的图片；为避免覆盖，未做任何更改。',
    resource_missing: '文档引用的图片缺失或不在文档目录内，无法随文档移动；请先修复图片引用。',
    resources_unreadable: '图片元数据无法读取；为避免丢失图片编辑记录，未做任何更改。',
    document_dirty: '该文档有未保存的修改；请先保存再重命名或移动。',
    save_pending: '该文档有未完成的保存恢复记录，请先重新打开该文档完成恢复。',
    history_name_taken: '新名称已有版本历史记录，为避免合并两份历史，请换一个名称。',
    revision_conflict: '有文档在预览后被修改；未做任何更改，请重试。',
    document_open: '该文档已在标签页中打开；请先关闭标签页再删除。',
    quota_exceeded: '工作区文档过多或过大，无法安全分析链接；未做任何更改。',
    journal_corrupt: '重命名恢复记录损坏；已保留原始文件，请检查 .easym/sync/operations。',
  }
  return messages[code] ?? `操作失败（${code}）。`
}
