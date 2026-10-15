import engineUrl from 'mermaid/dist/mermaid.min.js?url'
import type { ParsedDocument } from '../core/markdown'
import { MERMAID_LIMITS, mermaidIssue } from '../core/mermaid'
import { mermaidDataUrl } from '../core/mermaid-svg'

function render(source: string, theme: string, signal: AbortSignal, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('cancelled')); return }
    const frame = document.createElement('iframe')
    frame.className = 'mermaid-sandbox'; frame.setAttribute('sandbox', 'allow-scripts'); frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1
    frame.style.cssText = 'position:fixed;left:-20000px;top:0;width:1200px;height:900px;visibility:hidden;pointer-events:none'
    const token = crypto.randomUUID()
    const finish = (error?: string, svg?: string) => { clearTimeout(timer); window.removeEventListener('message', receive); signal.removeEventListener('abort', abort); frame.remove(); error ? reject(new Error(error)) : resolve(svg!) }
    const abort = () => finish('cancelled')
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || !event.data) return
      if (event.data.type === 'easym-mermaid-ready') frame.contentWindow?.postMessage({ type: 'easym-mermaid', token, source, theme, engine: new URL(engineUrl, document.baseURI).href }, '*')
      if (event.data.type === 'easym-mermaid-result' && event.data.token === token) {
        if (typeof event.data.svg === 'string') finish(undefined, event.data.svg)
        else finish('语法错误或渲染失败')
      }
    }
    const timer = window.setTimeout(() => finish('图表渲染超时'), timeout)
    window.addEventListener('message', receive); signal.addEventListener('abort', abort, { once: true })
    frame.src = new URL('mermaid.html', document.baseURI).href; document.body.append(frame)
  })
}

export async function renderMermaid(parsed: ParsedDocument, enabled = true, theme = 'light', signal = new AbortController().signal): Promise<ParsedDocument> {
  if (!parsed.diagrams?.length || signal.aborted) return parsed
  const root = document.createElement('div'); root.innerHTML = parsed.html
  const started = Date.now(); let total = 0, count = 0
  const blocks = parsed.blocks?.map(block => ({ ...block }))
  for (const diagram of parsed.diagrams) {
    if (signal.aborted) return parsed
    let issue = !enabled ? 'Mermaid 渲染已关闭' : mermaidIssue(diagram.source)
    total += diagram.source.length
    if (++count > MERMAID_LIMITS.count || total > MERMAID_LIMITS.total || Date.now() - started > MERMAID_LIMITS.taskTimeout) issue = '文档图表数量、总大小或耗时超限'
    const code = Array.from(root.querySelectorAll('pre > code.language-mermaid')).find(node => Number(node.getAttribute('data-source-from')) === diagram.from)
    if (!code?.parentElement) continue
    const figure = document.createElement('figure'); figure.className = 'markdown-mermaid'; figure.dataset.sourceFrom = String(diagram.from); figure.dataset.sourceTo = String(diagram.to)
    if (!issue) {
      try {
        const svg = await render(diagram.source, theme, signal, Math.max(1, Math.min(MERMAID_LIMITS.timeout, MERMAID_LIMITS.taskTimeout - (Date.now() - started))))
        if (signal.aborted) return parsed
        const image = document.createElement('img'); image.src = mermaidDataUrl(svg); image.alt = 'Mermaid 图表'; image.dataset.mermaidImage = 'true'; figure.append(image)
      } catch (error) { issue = error instanceof Error ? error.message : '图表渲染失败' }
    }
    if (signal.aborted) return parsed
    const label = document.createElement('figcaption'); label.textContent = issue ? `Mermaid：${issue}，已保留源码。` : 'Mermaid 图表'; figure.append(label)
    const details = document.createElement('details'); details.open = !!issue
    const summary = document.createElement('summary'); summary.textContent = '图表源码'
    const pre = document.createElement('pre'); const source = document.createElement('code'); source.textContent = diagram.raw; pre.append(source); details.append(summary, pre); figure.append(details)
    code.parentElement.replaceWith(figure)
    const block = blocks?.find(block => block.from === diagram.from)
    if (block) { block.type = 'mermaid'; block.html = figure.outerHTML }
  }
  return { ...parsed, html: root.innerHTML, blocks }
}
