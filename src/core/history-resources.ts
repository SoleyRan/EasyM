import { parseMarkdownAst } from './markdown-ast'
import { localImagePath } from './export-resource'
import { visit } from 'unist-util-visit'

/** Collect image URLs without rendering/highlighting the entire document on every save. */
export function historyImageUrls(text: string): string[] {
  const tree = parseMarkdownAst(text), references = new Set<string>(), definitions = new Map<string, string>(), urls = new Set<string>()
  visit(tree, node => {
    if (node.type === 'image') urls.add(node.url)
    else if (node.type === 'imageReference') references.add(node.identifier)
    else if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url)
  })
  for (const ref of references) { const url = definitions.get(ref); if (url) urls.add(url) }
  return [...urls]
}
export function historyReferences(text: string): string[] {
  return historyResourceSets(text).references
}
export function unarchivedHistoryReferences(text: string): string[] {
  return historyResourceSets(text).unarchivedReferences
}
export function historyResourceSets(text: string): { references: string[]; unarchivedReferences: string[] } {
  const urls = historyImageUrls(text)
  return {
    references: [...new Set(urls.flatMap(url => { const path = localImagePath(url); return path ? [path] : [] }))],
    unarchivedReferences: urls.filter(url => !/^https?:\/\//i.test(url) && !localImagePath(url)),
  }
}
