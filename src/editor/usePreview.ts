import { useEffect, useRef, useState } from 'react'
import type { ParsedDocument } from '../core/markdown'
import MarkdownWorker from '../platform/markdown-worker?worker&inline'

const empty: ParsedDocument = { html: '', headings: [], images: [] }

export function usePreview(text: string, error: (message: string) => void) {
  const [parsed, setParsed] = useState(empty)
  const parsedText = useRef('')
  const revision = useRef(0)
  const worker = useRef<Worker | null>(null)
  const report = useRef(error); report.current = error

  useEffect(() => {
    // Inline workers avoid platform-specific requests through Tauri's asset handler.
    let task: Worker
    try { task = new MarkdownWorker() }
    catch { report.current('后台预览不可用，源码仍可编辑。'); return }
    worker.current = task
    task.onerror = () => report.current('后台预览不可用，源码仍可编辑。')
    return () => { task.terminate(); worker.current = null }
  }, [])

  useEffect(() => {
    const current = ++revision.current
    const task = worker.current
    if (!task) return
    task.onmessage = (event: MessageEvent<{ revision: number; parsed: ParsedDocument; error?: string }>) => {
      if (event.data.revision !== revision.current) return
      if (event.data.error) { report.current(event.data.error); return }
      parsedText.current = text; setParsed(event.data.parsed)
    }
    const timer = window.setTimeout(() => task.postMessage({ text, revision: current }), 120)
    return () => { clearTimeout(timer) }
  }, [text])
  return { parsed, parsedText }
}
