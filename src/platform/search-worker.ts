import { countSearchMatches, type SearchOptions } from '../core/search'

self.onmessage = (event: MessageEvent<{ text: string; options: SearchOptions; revision: number }>) => {
  const { text, options, revision } = event.data
  try { self.postMessage({ revision, results: countSearchMatches(text, options) }) }
  catch { self.postMessage({ revision, error: 'SEARCH_COUNT_FAILED' }) }
}
