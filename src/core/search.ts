import { Text } from '@codemirror/state'
import { SearchQuery } from '@codemirror/search'

export const MAX_SEARCH_MATCHES = 10_000
export interface SearchOptions { search: string; caseSensitive: boolean; wholeWord: boolean }
export interface SearchMatch { from: number; to: number }
export interface SearchResults { matches: SearchMatch[]; limited: boolean }

// Share the editor's literal/Unicode matching rules with background counting.
export function countSearchMatches(text: string, options: SearchOptions): SearchResults {
  const query = new SearchQuery({ ...options, literal: true })
  const matches: SearchMatch[] = []
  if (!query.valid) return { matches, limited: false }
  const cursor = query.getCursor(Text.of(text.split('\n')))
  for (let item = cursor.next(); !item.done; item = cursor.next()) {
    if (matches.length === MAX_SEARCH_MATCHES) return { matches, limited: true }
    matches.push({ from: item.value.from, to: item.value.to })
  }
  return { matches, limited: false }
}

export function currentSearchMatch(matches: SearchMatch[], from: number, to: number): number {
  let low = 0, high = matches.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (matches[middle].from < from) low = middle + 1
    else high = middle
  }
  return matches[low]?.from === from && matches[low]?.to === to ? low + 1 : 0
}
