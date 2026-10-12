import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import remarkRehype from 'remark-rehype'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import { visit } from 'unist-util-visit'
import type { Root, Nodes } from 'mdast'
import type { Root as HtmlRoot, Element } from 'hast'
import { createLowlight, common } from 'lowlight'
import powershell from 'highlight.js/lib/languages/powershell'
import { MAX_LIVE_BLOCK, MAX_LIVE_DOCUMENT } from './live-preview'

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
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml', 'toml'])
const renderer = unified().use(remarkRehype, { allowDangerousHtml: false }).use(highlightCode).use(rehypeSanitize, {
  ...defaultSchema,
  attributes: { ...defaultSchema.attributes, '*': [...(defaultSchema.attributes?.['*'] ?? []), 'dataSourceFrom', 'dataSourceTo', 'dataResource'], span: [['className', /^hljs-[\w-]+$/, /^[\w-]+_$/]] },
}).use(rehypeStringify)

function plainText(node: Nodes): string {
  if ('value' in node) return node.value
  if ('children' in node) return node.children.map((child) => plainText(child as Nodes)).join('')
  return 'alt' in node ? node.alt ?? '' : ''
}

export function parseDocument(text: string): ParsedDocument {
  const tree = parser.parse(text) as Root
  const headings: ParsedDocument['headings'] = []
  const images: ImageReference[] = []
  const definitions = new Map<string, string>()
  visit(tree, 'definition', (node) => { definitions.set(node.identifier.toLowerCase(), node.url) })
  visit(tree, (node) => {
    const from = node.position?.start.offset
    const to = node.position?.end.offset
    if (from === undefined || to === undefined) return
    if (node.type === 'heading') headings.push({ level: node.depth, title: plainText(node), offset: from })
    node.data = { ...node.data, hProperties: { dataSourceFrom: from, dataSourceTo: to } }
    if (node.type === 'image' || node.type === 'imageReference') {
      const url = node.type === 'image' ? node.url : definitions.get(node.identifier.toLowerCase())
      if (url === undefined) return
      images.push({ from, to, url, alt: node.alt ?? '' })
      node.data.hProperties = { ...node.data.hProperties, dataResource: url }
      Object.assign(node, { type: 'image', url: '' })
    }
  })
  const output = renderer.runSync(tree)
  const blocks: PreviewBlock[] = []
  const elements = new Map(output.children.filter((node): node is Element => node.type === 'element').map(node => {
    const inner = node.children.find((child): child is Element => child.type === 'element' && child.properties.dataSourceFrom !== undefined)
    return [Number(node.properties.dataSourceFrom ?? inner?.properties.dataSourceFrom), node]
  }))
  for (const child of text.length <= MAX_LIVE_DOCUMENT ? tree.children : []) {
    const from = child.position?.start.offset, to = child.position?.end.offset
    if (from === undefined || to === undefined || to - from > MAX_LIVE_BLOCK) continue
    const element = elements.get(from)
    const type = child.type === 'paragraph' && child.children.length === 1 && /^(image|imageReference)$/.test(child.children[0].type) ? 'image' : child.type
    if (element && /^(code|table|image|thematicBreak)$/.test(type)) blocks.push({ from, to, type, html: String(renderer.stringify({ type: 'root', children: [element] })) })
  }
  return { html: String(renderer.stringify(output)), headings, images, blocks }
}

export const renderMarkdown = (text: string): string => parseDocument(text).html
