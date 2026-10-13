import { invoke } from '@tauri-apps/api/core'
import { desktop } from './storage'
import { safeLink } from '../core/links'

export async function openExternalLink(url: string): Promise<void> {
  if (!safeLink(url) || !/^(https?:|mailto:)/i.test(url)) throw new Error('不支持打开此地址。')
  if (desktop) await invoke('open_external_link', { url })
  else window.open(url, '_blank', 'noopener,noreferrer')
}
export function relativeDocumentTarget(currentPath: string | null, url: string): string | null {
  if (!currentPath || !safeLink(url) || /^[a-z][a-z\d+.-]*:|^[#/]/i.test(url)) return null
  const path = decodeURIComponent(url.split(/[?#]/)[0])
  const parts = currentPath?.split('/').slice(0, -1) ?? []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { if (!parts.length) return null; parts.pop() }
    else { if (/[:\x00-\x1f\\]/.test(part)) return null; parts.push(part) }
  }
  const result = parts.join('/')
  return /\.(md|markdown)$/i.test(result) ? result : null
}
