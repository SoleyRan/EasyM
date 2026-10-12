import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import type { Root } from 'mdast'

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml', 'toml'])

// Each consumer receives its own unmodified tree, including original resource URLs.
export function parseMarkdownAst(text: string): Root {
  return parser.parse(text) as Root
}
