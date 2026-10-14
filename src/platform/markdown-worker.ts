import { parseDocument } from '../core/markdown'

self.onmessage = (event: MessageEvent<{ text: string; revision: number }>) => {
  try { self.postMessage({ revision: event.data.revision, parsed: parseDocument(event.data.text) }) }
  catch { self.postMessage({ revision: event.data.revision, error: '预览解析失败，源码保持可编辑。' }) }
}
