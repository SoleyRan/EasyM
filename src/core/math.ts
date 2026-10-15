import katex from 'katex'
import { fromHtml } from 'hast-util-from-html'
import { unified } from 'unified'
import rehypeSanitize from 'rehype-sanitize'
import type { Element, Root } from 'hast'
import type { Nodes } from 'mdast'

export const MATH_LIMITS = { formula: 16 * 1024, count: 200, total: 128 * 1024, output: 256 * 1024, timeout: 5000 } as const
export interface MathBudget { count: number; total: number }
const tags = ['math', 'semantics', 'annotation', 'mrow', 'mi', 'mn', 'mo', 'mtext', 'mspace', 'mfrac', 'msqrt', 'mroot', 'msub', 'msup', 'msubsup', 'munder', 'mover', 'munderover', 'mtable', 'mtr', 'mtd', 'mstyle', 'mpadded', 'mphantom', 'menclose']
const attributes = ['mathvariant', 'displaystyle', 'scriptlevel', 'stretchy', 'fence', 'separator', 'accent', 'accentunder', 'largeop', 'movablelimits', 'symmetric', 'lspace', 'rspace', 'width', 'height', 'depth', 'voffset', 'columnalign', 'rowalign', 'columnspacing', 'rowspacing', 'columnlines', 'rowlines', 'columnspan', 'rowspan', 'linethickness', 'notation', 'minsize', 'maxsize']
// Only KaTeX's generated MathML passes through this schema. No HTML, styles,
// IDs, URLs, SVG, annotations containing markup, or event handlers survive.
const cleaner = unified().use(rehypeSanitize, {
  tagNames: tags, attributes: { '*': attributes, math: [...attributes, ['xmlns', 'http://www.w3.org/1998/Math/MathML'], ['display', 'block', 'inline']], annotation: [['encoding', 'application/x-tex']] },
  strip: ['script', 'style', 'annotation-xml', 'svg'], clobber: ['id', 'name'], protocols: {},
})
export function cleanMath(tree: Root): Root { return cleaner.runSync(tree) as Root }
const blocked = /\\(?:href|url|includegraphics|html\w*|class|cssId|style|def|gdef|edef|xdef|let|futurelet|newcommand|renewcommand|providecommand|global|catcode|csname|expandafter|input|include|write|openout|read|require|usepackage|color|textcolor|colorbox|fcolorbox|pagecolor|rule|raisebox|vcenter|kern|mkern|hskip|vskip)\b/i

export function renderMath(node: Extract<Nodes, { type: 'math' | 'inlineMath' }>, source: string, enabled: boolean, budget: MathBudget): Element {
  const display = node.type === 'math'
  let reason = ''
  if (!enabled) reason = '公式渲染已关闭'
  else if (++budget.count > MATH_LIMITS.count || (budget.total += node.value.length) > MATH_LIMITS.total || node.value.length > MATH_LIMITS.formula) reason = '公式超过渲染限制'
  else if (display && !/\n[\t >]*\${2,}[^\S\n]*$/.test(source.trimEnd())) reason = '公式围栏未闭合'
  else if (blocked.test(node.value)) reason = '公式包含不支持的命令'
  let children: Element['children'] = []
  if (!reason) {
    try {
      const html = katex.renderToString(node.value, { displayMode: display, output: 'mathml', throwOnError: true, trust: false, strict: 'error', maxExpand: 1000, maxSize: 20, macros: {}, globalGroup: false })
      if (html.length > MATH_LIMITS.output) reason = '公式输出超过渲染限制'
      else children = cleanMath(fromHtml(html, { fragment: true })).children.filter((child): child is Element => child.type === 'element')
    } catch { reason = '公式语法错误或命令不受支持' }
  }
  if (reason) children = [
    { type: 'element', tagName: 'code', properties: {}, children: [{ type: 'text', value: source }] },
    { type: 'element', tagName: 'span', properties: { className: ['math-message'] }, children: [{ type: 'text', value: `（${reason}）` }] },
  ]
  return { type: 'element', tagName: display ? 'div' : 'span', properties: { ...node.data?.hProperties, className: ['markdown-math', display ? 'math-block' : 'math-inline', ...(reason ? ['math-source'] : [])] }, children }
}
