import { parseMarkdownAst } from './markdown-ast'
import { visit } from 'unist-util-visit'
import { localImagePath } from './export-resource'
import { applyPatches, imageMarkdown, type TextPatch } from './document'
import type { ImageInstance } from './images'

export { batchRecipe, validateBatchOptions, type BatchOptions } from './batch-options'
export interface BatchReference { from: number; to: number; url: string; path: string | null; alt: string; title?: string | null }
export function batchReferences(text: string): BatchReference[] {
  const tree = parseMarkdownAst(text), definitions = new Map<string, { url: string; title?: string | null }>(), result: BatchReference[] = []
  visit(tree, 'definition', node => { if (!definitions.has(node.identifier)) definitions.set(node.identifier, node) })
  visit(tree, node => {
    if (node.type !== 'image' && node.type !== 'imageReference') return
    const value = node.type === 'image' ? node : definitions.get(node.identifier), url = value?.url
    const from = node.position?.start.offset, to = node.position?.end.offset
    if (url !== undefined && from !== undefined && to !== undefined) result.push({ from, to, url, path: localImagePath(url), alt: node.alt ?? '', title: value?.title })
  })
  return result
}
export function batchPatches(text: string, changes: { reference: BatchReference; instance: ImageInstance }[], current = batchReferences(text)): TextPatch[] {
  if (!changes.length || changes.length > 100) throw new Error('每批请选择 1–100 个图片实例。')
  const patches = changes.map(({ reference, instance }) => {
    if (!current.some(r => r.from === reference.from && r.to === reference.to && r.url === reference.url)) throw new Error('图片引用已变化，请重新预检。')
    // Inline replacement isolates an occurrence of a shared reference definition.
    const markdown = imageMarkdown(reference.alt, instance.displayPath)
    return { from: reference.from, to: reference.to, insert: reference.title ? markdown.slice(0, -1) + ' "' + reference.title.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '")' : markdown }
  }).sort((a, b) => b.from - a.from)
  applyPatches(text, patches)
  return patches
}
