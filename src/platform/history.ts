import { invoke } from '@tauri-apps/api/core'
import type { ImageMetadata } from '../core/images'
import type { ImageResources } from './images'
import { historyReferences } from '../core/history-resources'
import { collectHistoryResources } from './history-resources'
export { historyReferences } from '../core/history-resources'
import { localImagePath } from '../core/export-resource'
import { parseMarkdownAst } from '../core/markdown-ast'
import { visit } from 'unist-util-visit'
import type { HistoryDiff } from '../core/history-diff'
import DiffWorker from './history-diff-worker?worker&inline'

export interface HistoryResource { path: string; hash: string | null; size: number; mime: string | null; role: string; missing: boolean }
export interface HistorySnapshot {
  snapshotId: string; documentId: string; parentSnapshotId: string | null; createdAt: number; reason: string; bodyHash: string; bodySize: number;
  encoding: 'utf-8' | 'utf-8-bom'; lineEnding: 'lf' | 'crlf' | 'mixed'; diskRevision: string | null; resources: HistoryResource[]; metadata: ImageMetadata; complete: boolean; unarchivedReferences?: string[]; name?: string | null; pinned?: boolean
}
export interface HistoryStatus { enabled: boolean; documentId: string | null; readOnly: boolean; usedBytes: number; budgetBytes: number; paused: boolean; warning?: string; snapshots: HistorySnapshot[]; orphans: { path: string; documentId: string }[] }
export interface HistoryInput { bytes: number[]; references: string[]; unarchivedReferences: string[]; assets: { path: string; bytes: number[] }[]; metadata: ImageMetadata; diskRevision: string | null }
export interface CleanupPlan { candidates: { document: string; snapshotId: string; reason: string; name: string | null; createdAt: number }[]; reclaimBytes: number; token: string }
export const historyOperation = <T>(id: string, request: Record<string, unknown>) => invoke<T>('history_operation', { id, request })
export async function historyInput(bytes: Uint8Array, resources: ImageResources, diskRevision: string | null): Promise<HistoryInput> {
  const [{ references, unarchivedReferences }] = await collectHistoryResources([new TextDecoder().decode(bytes)]), paths = new Set(references)
  const instances = resources.instances.filter(i => paths.has(i.displayPath))
  instances.forEach(i => { paths.add(i.sourcePath); paths.add(i.displayPath) })
  const assets = []
  let total = 0
  for (const path of paths) {
    const blob = resources.assets[path]
    if (!blob) continue
    total += blob.size; if (total > 128 * 1024 * 1024) throw new Error('图片资源超过 128 MiB。')
    assets.push({ path, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) })
  }
  return { bytes: Array.from(bytes), references, unarchivedReferences, assets, metadata: { schemaVersion: 1, instances }, diskRevision }
}

// Only edit AST image destinations and image-reference definitions, preserving labels, titles and prose.
export function relocateHistoryImages(text: string, paths: Record<string, string>): string {
  const tree = parseMarkdownAst(text), definitions = new Set<string>()
  visit(tree, 'imageReference', node => { definitions.add(node.identifier) })
  const edits: { from: number; to: number; insert: string }[] = []
  visit(tree, node => {
    if (node.type !== 'image' && !(node.type === 'definition' && definitions.has(node.identifier))) return
    const path = localImagePath(node.url), target = path && paths[path]
    if (!target || target === node.url) return
    const from = node.position?.start.offset, to = node.position?.end.offset
    if (from == null || to == null) throw new Error('无法安全映射图片位置。')
    const source = text.slice(from, to)
    // Locate the destination after the image label or reference colon. It may be angle wrapped.
    const prefix = node.type === 'definition' ? /^ {0,3}\[[^\n]*?\]:\s*/.exec(source)?.[0] : /^!\[(?:\\.|[^\\\]])*\]\(\s*/.exec(source)?.[0]
    if (!prefix) throw new Error('无法安全映射图片引用，请另存正文副本。')
    let start = prefix.length, end = start
    if (source[start] === '<') { start++; end = source.indexOf('>', start); if (end < 0) throw new Error('无法安全映射图片引用。') }
    else {
      let depth = 0
      while (end < source.length) { const c = source[end]; if (c === '\\') { end += 2; continue } if (c === '(') depth++; if (c === ')') { if (!depth) break; depth-- } if (/\s/.test(c) && !depth) break; end++ }
    }
    const original = source.slice(start, end).replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1')
    if (localImagePath(original) !== path) throw new Error('无法安全映射图片引用。')
    edits.push({ from: from + start, to: from + end, insert: target })
  })
  for (const edit of edits.sort((a, b) => b.from - a.from)) text = text.slice(0, edit.from) + edit.insert + text.slice(edit.to)
  if (historyReferences(text).some(path => paths[path] && paths[path] !== path)) throw new Error('仍有无法重定位的图片引用。')
  return text
}

export function compareHistory(before: string, after: string, signal?: AbortSignal): Promise<HistoryDiff> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('已取消', 'AbortError')); return }
    const worker = new DiffWorker()
    const finish = () => { clearTimeout(timer); worker.terminate(); signal?.removeEventListener('abort', abort) }
    const abort = () => { finish(); reject(new DOMException('已取消', 'AbortError')) }
    const fallback = (message: string) => { finish(); resolve({ lines: [], additions: 0, deletions: 0, fallback: message }) }
    const timer = globalThis.setTimeout(() => fallback('超过 10 秒，未生成逐行差异；请查看双方全文。'), 10000)
    signal?.addEventListener('abort', abort, { once: true })
    worker.onmessage = (event: MessageEvent<HistoryDiff>) => { finish(); resolve(event.data) }
    worker.onerror = () => fallback('后台差异计算失败；请查看双方全文。')
    try { worker.postMessage({ before, after }) } catch { fallback('后台差异任务未能启动；请查看双方全文。') }
  })
}

export const historyError = (error: unknown): string => {
  const code = error instanceof Error ? error.message : String(error)
  return ({ history_read_only: '历史格式版本较新，已保留原数据，请使用新版 EasyM。', history_invalid: '历史数据无效；已停止操作并保留原数据。', history_corrupt: '归档对象哈希校验失败；禁止恢复，请检查备份。', history_incomplete: '快照缺少图片，禁止完整恢复；可仅另存正文。', history_quota: '历史配额不足，已暂停创建快照。请清理历史或提高配额。', history_mixed: '当前文档混合使用换行；请先确认并保存换行格式，或另存副本。', revision_conflict: '文件或清理计划已被外部修改；未覆盖正文，请刷新或另存副本。', history_pinned: '固定快照受保护，请先取消固定。', resource_missing: '归档对象或文件缺失，已保留当前正文。' } as Record<string, string>)[code] ?? code
}
