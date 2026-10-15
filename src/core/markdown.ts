import { unified } from 'unified'
import remarkRehype from 'remark-rehype'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import { visit, SKIP } from 'unist-util-visit'
import type { Nodes } from 'mdast'
import { parseMarkdownAst } from './markdown-ast'
import { indexFootnotes } from './footnotes'
import { renderMath } from './math'
import type { MermaidSource } from './mermaid'
import type { Root as HtmlRoot, Element } from 'hast'
import { createLowlight, common } from 'lowlight'
import powershell from 'highlight.js/lib/languages/powershell'
import { MAX_LIVE_BLOCK, MAX_LIVE_DOCUMENT } from './live-preview'

declare module 'hast' { interface ElementData { mathResult?: Element } }

const highlighter = createLowlight({ ...common, powershell })
function highlightCode() {
  return (tree: HtmlRoot) => {
    visit(tree, 'element', (node: Element, _index, parent) => {
      if (node.tagName !== 'code' || !parent || !('tagName' in parent) || parent.tagName !== 'pre') return
      const language = (node.properties.className as string[] | undefined)?.find((name) => name.startsWith('language-'))?.slice(9)
      const body = node.children.map((child) => child.type === 'text' ? child.value : '').join('')
      // Bound highlighting work for huge blocks while retaining their complete text.
      if (language && highlighter.registered(language) && body.length <= 100_000) node.children = highlighter.highlight(language, body).children.filter((child) => child.type !== 'doctype')
    })
  }
}

export interface ImageReference { from: number; to: number; url: string; alt: string }
export interface PreviewBlock { from: number; to: number; type: string; html: string }
export interface ParsedDocument {
  html: string
  headings: Array<{ level: number; title: string; offset: number }>
  images: ImageReference[]
  blocks?: PreviewBlock[]
  diagrams?: MermaidSource[]
}

function sourceSection(_state: unknown, node: Nodes): Element | undefined {
  const value = node.data?.staticSource
  if (typeof value !== 'string') return
  const label = node.type === 'yaml' || node.type === 'toml' ? `Front Matter · ${node.type.toUpperCase()}` : '未引用或重复的脚注定义'
  return { type: 'element', tagName: 'section', properties: { ...node.data?.hProperties, className: ['markdown-metadata'] }, children: [
    { type: 'element', tagName: 'p', properties: {}, children: [{ type: 'text', value: label }] },
    { type: 'element', tagName: 'pre', properties: {}, children: [{ type: 'element', tagName: 'code', properties: {}, children: [{ type: 'text', value }] }] },
  ] }
}

function footnoteSourceRanges() {
  return (tree: HtmlRoot) => visit(tree, 'element', (node: Element) => {
    if (node.position?.start.offset !== undefined) {
      node.properties.dataSourceFrom = node.position.start.offset
      node.properties.dataSourceTo = node.position.end.offset
    }
  })
}

// Keep the sanitizer's DOM-clobber prefix, and repair only generated note links
// against IDs that actually survived sanitization in this document.
function footnoteAnchors() {
  return (tree: HtmlRoot) => {
    const targets = new Map<string, Element>()
    visit(tree, 'element', (node: Element) => { if (typeof node.properties.id === 'string') targets.set(node.properties.id, node) })
    visit(tree, 'element', (node: Element) => {
      const ref = node.properties.dataFootnoteRef !== undefined, back = node.properties.dataFootnoteBackref !== undefined
      if (node.tagName !== 'a' || !ref && !back || typeof node.properties.href !== 'string' || !node.properties.href.startsWith('#')) return
      const id = `${defaultSchema.clobberPrefix ?? ''}${node.properties.href.slice(1)}`
      const target = targets.get(id)
      if (!target) return
      node.properties.href = `#${id}`
      if (back) { node.properties.dataSourceFrom = target.properties.dataSourceFrom; node.properties.dataSourceTo = target.properties.dataSourceTo }
      else node.properties.ariaLabel = `查看脚注 ${node.children.filter(child => child.type === 'text').map(child => child.value).join('')}`
    })
  }
}

const renderer = unified().use(remarkRehype, {
  allowDangerousHtml: false, footnoteLabel: '脚注', footnoteLabelProperties: {},
  footnoteBackLabel: (index, count) => `返回脚注引用 ${index + 1}${count > 1 ? `（第 ${count} 次）` : ''}`,
  handlers: { yaml: sourceSection, toml: sourceSection, footnoteDefinition: sourceSection,
    math: (_state, node) => node.data?.mathResult, inlineMath: (_state, node) => node.data?.mathResult },
}).use(highlightCode).use(footnoteSourceRanges).use(rehypeSanitize, {
  ...defaultSchema,
  attributes: { ...defaultSchema.attributes, '*': [...(defaultSchema.attributes?.['*'] ?? []), 'dataSourceFrom', 'dataSourceTo', 'dataResource'], section: ['dataFootnotes', ['className', 'footnotes', 'markdown-metadata']], span: [['className', /^hljs-[\w-]+$/, /^[\w-]+_$/]] },
}).use(footnoteAnchors).use(restoreMath).use(rehypeStringify)

// Attach already sanitised math after ordinary Markdown sanitisation. Keeping
// it separate prevents Markdown from gaining access to the MathML schema.
function restoreMath() {
  return (tree: HtmlRoot) => visit(tree, 'element', (node: Element) => {
    const result = node.data?.mathResult as Element | undefined
    if (result) { node.tagName = result.tagName; node.properties = result.properties; node.children = result.children; delete node.data?.mathResult; return SKIP }
  })
}

function plainText(node: Nodes): string {
  if ('value' in node) return node.value
  if ('children' in node) return node.children.map((child) => plainText(child as Nodes)).join('')
  return 'alt' in node ? node.alt ?? '' : ''
}

export function parseDocument(text: string, options: { math?: boolean } = {}): ParsedDocument {
  const tree = parseMarkdownAst(text)
  const notes = indexFootnotes(tree)
  const retained = new Set(notes.retained)
  visit(tree, node => {
    if (node.type === 'yaml' || node.type === 'toml' || node.type === 'footnoteDefinition' && retained.has(node)) {
      node.data = { ...node.data, staticSource: text.slice(node.position?.start.offset, node.position?.end.offset) }
    }
  })
  const headings: ParsedDocument['headings'] = []
  const images: ImageReference[] = []
  const diagrams: MermaidSource[] = []
  const mathBudget = { count: 0, total: 0 }
  const mathSources: PreviewBlock[] = []
  visit(tree, node => {
    if (node.type === 'footnoteDefinition') return SKIP
    if (node.type === 'heading' && node.position?.start.offset !== undefined) headings.push({ level: node.depth, title: plainText(node), offset: node.position.start.offset })
  })
  const definitions = new Map<string, string>()
  visit(tree, 'definition', (node) => { definitions.set(node.identifier.toLowerCase(), node.url) })
  visit(tree, (node) => {
    const from = node.position?.start.offset
    const to = node.position?.end.offset
    if (from === undefined || to === undefined) return
    if (node.type === 'code' && node.lang === 'mermaid') diagrams.push({ from, to, source: node.value, raw: text.slice(from, to) })
    node.data = { ...node.data, hProperties: { ...node.data?.hProperties, dataSourceFrom: from, dataSourceTo: to } }
    if (node.type === 'math' || node.type === 'inlineMath') {
      if (node.type === 'inlineMath') mathSources.push({ from, to, type: 'mathInline', html: '' })
      const result = renderMath(node, text.slice(from, to), options.math !== false, mathBudget)
      // HAST data is preserved by sanitisation, but is never serialised.
      node.data.mathResult = { type: 'element', tagName: 'span', properties: {}, data: { mathResult: result, position: {} }, children: [] }
    }
    if (node.type === 'image' || node.type === 'imageReference') {
      const url = node.type === 'image' ? node.url : definitions.get(node.identifier.toLowerCase())
      if (url === undefined) return
      images.push({ from, to, url, alt: node.alt ?? '' })
      node.data.hProperties = { ...node.data.hProperties, dataResource: url }
      Object.assign(node, { type: 'image', url: '' })
    }
  })
  const output = renderer.runSync(tree)
  const blocks: PreviewBlock[] = text.length <= MAX_LIVE_DOCUMENT ? mathSources : []
  const elements = new Map(output.children.filter((node): node is Element => node.type === 'element').map(node => {
    const inner = node.children.find((child): child is Element => child.type === 'element' && child.properties.dataSourceFrom !== undefined)
    return [Number(node.properties.dataSourceFrom ?? inner?.properties.dataSourceFrom), node]
  }))
  for (const child of text.length <= MAX_LIVE_DOCUMENT ? tree.children : []) {
    const from = child.position?.start.offset, to = child.position?.end.offset
    if (from === undefined || to === undefined || to - from > MAX_LIVE_BLOCK) continue
    const element = elements.get(from)
    const type = child.type === 'paragraph' && child.children.length === 1 && /^(image|imageReference)$/.test(child.children[0].type) ? 'image' : child.type
    if (element && /^(code|table|image|thematicBreak|math)$/.test(type)) blocks.push({ from, to, type, html: String(renderer.stringify({ type: 'root', children: [element] })) })
  }
  return { html: String(renderer.stringify(output)), headings, images, blocks, diagrams }
}

export const renderMarkdown = (text: string): string => parseDocument(text).html
