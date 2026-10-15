import { useEffect, useRef, useState } from 'react'
import type { ParsedDocument } from '../core/markdown'
import MarkdownWorker from '../platform/markdown-worker?worker&inline'
import { MATH_LIMITS } from '../core/math'

const empty: ParsedDocument = { html: '', headings: [], images: [] }

export function usePreview(text: string, error: (message: string) => void, math = true) {
  const [parsed, setParsed] = useState(empty)
  const parsedText = useRef('')
  const previousMath = useRef(math)
  const revision = useRef(0)
  const worker = useRef<Worker | null>(null)
  const report = useRef(error); report.current = error

  useEffect(() => () => { worker.current?.terminate(); worker.current = null }, [])

  useEffect(() => {
    const current = ++revision.current
    // Returning to the exact displayed source through undo keeps that preview
    // valid. Only an option change invalidates the same-source presentation.
    if (previousMath.current !== math) parsedText.current = ''
    previousMath.current = math
    let running: Worker | null = null, deadline = 0
    const timer = window.setTimeout(() => {
      let task: Worker
      try { task = worker.current ?? new MarkdownWorker(); worker.current = task }
      catch { report.current('后台预览不可用，源码仍可编辑。'); return }
      running = task
      const fail = (message: string) => {
        if (current !== revision.current) return
        clearTimeout(deadline); task.terminate(); worker.current = null; running = null
        parsedText.current = ''; setParsed(empty); report.current(message)
      }
      task.onmessage = (event: MessageEvent<{ revision: number; parsed: ParsedDocument; error?: string }>) => {
        if (event.data.revision !== revision.current || current !== revision.current) return
        clearTimeout(deadline); running = null
        if (event.data.error) { fail(event.data.error); return }
        parsedText.current = text; setParsed(event.data.parsed)
      }
      task.onerror = () => fail('后台预览不可用，源码仍可编辑。')
      deadline = window.setTimeout(() => fail('预览解析超时，源码仍可编辑；修改内容可重试。'), MATH_LIMITS.timeout)
      try { task.postMessage({ text, revision: current, options: { math } }) }
      catch { fail('后台预览不可用，源码仍可编辑。') }
    }, 120)
    return () => { ++revision.current; clearTimeout(timer); clearTimeout(deadline); if (running) { running.terminate(); if (worker.current === running) worker.current = null } }
  }, [text, math])
  return { parsed, parsedText }
}
