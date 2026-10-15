import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import remarkMath from 'remark-math'
import { visit } from 'unist-util-visit'
import type { Root } from 'mdast'

declare module 'mdast' {
  interface Data { staticSource?: string; mathResult?: import('hast').Element }
  interface Toml extends Literal { type: 'toml'; data?: Data }
  interface BlockContentMap { toml: Toml }
  interface RootContentMap { toml: Toml }
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml', 'toml']).use(remarkMath)

// Each consumer receives its own unmodified tree, including original resource URLs.
export function parseMarkdownAst(text: string): Root {
  const tree = parser.parse(text) as Root
  visit(tree, (node, index, parent) => {
    if (node.type !== 'inlineMath' || !parent || index === undefined) return
    const from = node.position?.start.offset ?? 0, to = node.position?.end.offset ?? 0
    const raw = text.slice(from, to)
    // Single-dollar math is deliberately conservative around common prices.
    if (raw.startsWith('$$') || /[\r\n]/.test(raw) || /^\$\s|\s\$$/.test(raw) || /\d/.test(text.charAt(to))) {
      parent.children[index] = { type: 'text', value: raw, position: node.position }
    }
  })
  return tree
}
