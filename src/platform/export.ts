import { invoke } from '@tauri-apps/api/core'
import MarkdownWorker from './markdown-worker?worker&inline'
import type { ParsedDocument } from '../core/markdown'
import { desktop } from './storage'

export function parseForExport(text: string): Promise<ParsedDocument> {
  return new Promise((resolve, reject) => {
    const worker = new MarkdownWorker()
    const finish = () => { clearTimeout(timer); worker.terminate() }
    const timer = window.setTimeout(() => { finish(); reject(new Error('导出解析超时，请减少正文后重试。')) }, 60_000)
    worker.onmessage = (event: MessageEvent<{ parsed: ParsedDocument; error?: string }>) => {
      finish()
      if (event.data.error) reject(new Error(event.data.error))
      else resolve(event.data.parsed)
    }
    worker.onerror = () => { finish(); reject(new Error('后台导出不可用，请重试。')) }
    try { worker.postMessage({ text, revision: 1 }) }
    catch (error) { finish(); reject(error) }
  })
}

export async function saveHtml(name: string, html: string): Promise<boolean> {
  if (desktop) return invoke<boolean>('export_html', { name, html })
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }))
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return true
}

export async function printDocument(): Promise<void> {
  if (desktop) await invoke('print_document')
  else window.print()
}
