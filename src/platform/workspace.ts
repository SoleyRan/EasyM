import { invoke } from '@tauri-apps/api/core'
import type { OpenedFile } from './storage'

export interface WorkspaceEntry { path: string; name: string; kind: 'directory' | 'document' | 'image' }
export interface Workspace { id: string; name: string; entries: WorkspaceEntry[] }
export interface WorkspaceImage { id: string; path: string }
export interface WorkspaceSearchResult { path: string; line: number; preview: string; revision: string }
export interface WorkspaceSearchReport { results: WorkspaceSearchResult[]; scanned: number; skipped: number; limited: boolean; cancelled: boolean }
export interface WorkspaceLocation { token: string; line: number; revision: string }
export const WORKSPACE_IMAGE_TYPE = 'application/x-easym-workspace-image'

export const openWorkspace = () => invoke<Workspace | null>('open_workspace')
export const listWorkspace = (id: string, relativePath = '') => invoke<WorkspaceEntry[]>('list_workspace', { id, relativePath })
export const searchWorkspace = (id: string, query: string, requestId: string) => invoke<WorkspaceSearchReport>('search_workspace', { id, query, requestId })
export const cancelWorkspaceSearch = (requestId: string) => invoke<void>('cancel_workspace_search', { requestId })

export async function openWorkspaceDocument(id: string, relativePath: string): Promise<OpenedFile> {
  const file = await invoke<Omit<OpenedFile, 'bytes'> & { bytes: number[] }>('open_workspace_document', { id, relativePath })
  return { ...file, bytes: new Uint8Array(file.bytes) }
}

export async function readWorkspaceImage({ id, path }: WorkspaceImage): Promise<File> {
  const file = await invoke<{ bytes: number[]; mime: string }>('read_workspace_image', { id, relativePath: path })
  return new File([new Uint8Array(file.bytes)], path.split('/').at(-1) ?? '图片', { type: file.mime })
}

export function workspaceImageData(value: string): WorkspaceImage | null {
  try {
    const data = JSON.parse(value) as Partial<WorkspaceImage>
    return typeof data.id === 'string' && typeof data.path === 'string' ? { id: data.id, path: data.path } : null
  } catch { return null }
}
