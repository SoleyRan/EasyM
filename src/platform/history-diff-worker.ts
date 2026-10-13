import { historyDiff } from '../core/history-diff'
import { historyResourceSets } from '../core/history-resources'
import { batchReferences } from '../core/batch-images'
self.onmessage = (event: MessageEvent<{ type?: string; texts?: string[]; before: string; after: string }>) => {
  if (event.data.type === 'references') {
    try { self.postMessage({ references: event.data.texts!.map(historyResourceSets) }) }
    catch { self.postMessage({ error: 'history_analysis_failed' }) }
    return
  }
  if (event.data.type === 'batchReferences') {
    try { self.postMessage({ references: batchReferences(event.data.texts![0]) }) }
    catch { self.postMessage({ error: 'batch_analysis_failed' }) }
    return
  }
  try { self.postMessage(historyDiff(event.data.before, event.data.after)) }
  catch { self.postMessage({ lines: [], additions: 0, deletions: 0, fallback: 'HISTORY_DIFF_FAILED：未生成逐行差异；请查看双方全文。' }) }
}
