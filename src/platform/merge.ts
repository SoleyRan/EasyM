import DiffWorker from './history-diff-worker?worker&inline'
import { unavailableMerge, type MergePlan } from '../core/merge'

/** One isolated task per request; closing its owner terminates computation. */
export function analyzeMerge(base: string | null, local: string, disk: string, signal?: AbortSignal): Promise<MergePlan> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('已取消', 'AbortError')); return }
    let worker: Worker
    try { worker = new DiffWorker() }
    catch { resolve(unavailableMerge('合并分析未能启动，请比较双方全文或另存副本。')); return }
    let settled = false
    const finish = () => {
      settled = true; clearTimeout(timer); worker.terminate(); signal?.removeEventListener('abort', abort)
    }
    const abort = () => { if (!settled) { finish(); reject(new DOMException('已取消', 'AbortError')) } }
    const fallback = (reason: string) => { if (!settled) { finish(); resolve(unavailableMerge(reason)) } }
    const timer = globalThis.setTimeout(() => fallback('合并分析超过 10 秒，请比较双方全文或另存副本。'), 10000)
    signal?.addEventListener('abort', abort, { once: true })
    worker.onmessage = (event: MessageEvent<MergePlan>) => { if (!settled) { finish(); resolve(event.data) } }
    worker.onerror = () => fallback('后台合并分析失败，请比较双方全文或另存副本。')
    worker.onmessageerror = () => fallback('合并分析结果无法读取，请比较双方全文或另存副本。')
    try { worker.postMessage({ type: 'merge', base, local, disk }) }
    catch { fallback('合并任务未能发送，请比较双方全文或另存副本。') }
  })
}
