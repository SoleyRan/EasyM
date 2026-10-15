import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import type { Root } from 'mdast'

declare module 'mdast' {
  interface Data { staticSource?: string }
  interface Toml extends Literal { type: 'toml'; data?: Data }
  interface BlockContentMap { toml: Toml }
  interface RootContentMap { toml: Toml }
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml', 'toml'])

// Each consumer receives its own unmodified tree, including original resource URLs.
export function parseMarkdownAst(text: string): Root {
  return parser.parse(text) as Root
}
