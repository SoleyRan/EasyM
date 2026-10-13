import { historyResourceSets } from '../core/history-resources'
import HistoryWorker from './history-diff-worker?worker&inline'

/** Large AST scans must not block keystrokes during ordinary automatic saving. */
export async function collectHistoryResources(texts: string[]): Promise<ReturnType<typeof historyResourceSets>[]> {
  if (texts.every(text => text.length < 65536)) return Promise.resolve(texts.map(historyResourceSets))
  return new Promise((resolve, reject) => {
    const worker = new HistoryWorker()
    const finish = () => { clearTimeout(timer); worker.terminate() }
    const timer = globalThis.setTimeout(() => { finish(); reject(new Error('history_analysis_failed')) }, 10000)
    worker.onmessage = event => { finish(); if (event.data.error) reject(new Error('history_analysis_failed')); else resolve(event.data.references) }
    worker.onerror = () => { finish(); reject(new Error('history_analysis_failed')) }
    try { worker.postMessage({ type: 'references', texts }) } catch { finish(); reject(new Error('history_analysis_failed')) }
  })
}
