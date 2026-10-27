export const MERMAID_LIMITS = { source: 8000, lines: 120, statements: 120, count: 12, total: 32000, timeout: 5000, taskTimeout: 20000, svg: 1024 * 1024, elements: 10000, dimension: 8192 } as const
export interface MermaidSource { from: number; to: number; source: string; raw: string }

// Mermaid only honours directives as statements, at the start of a line or after `;`.
// The same words inside labels (`A[style guide]`, `B[image upload]`) are plain text.
const directive = /^(?:click|href|call|callback|link|links|properties|details|linkStyle|accDescr|image|img)\b/i
const styleKeyword = /^(?:style|classDef)\b/i
const name = String.raw`[\p{L}\p{N}_-]+`
// A colour (hex or name), a number/px, or a space-separated dash pattern. Without parentheses,
// quotes or separators a value cannot reach url(), expressions or another declaration.
const value = String.raw`(?:#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})|[a-z]+|\d+(?:\.\d+)?(?:px)?(?:\s+\d+(?:\.\d+)?(?:px)?)*)`
const declaration = String.raw`(?:fill|color|stroke|stroke-width|stroke-dasharray|font-weight|opacity)\s*:\s*${value}`
// The whole line must be the style statement: Mermaid drops a `;` from style lines containing
// `#`, which would otherwise join a following statement onto the declarations.
const styleLine = new RegExp(String.raw`^(?:style\s+${name}|classDef\s+${name}(?:\s*,\s*${name})*)\s+${declaration}(?:\s*,\s*${declaration})*\s*;?\s*$`, 'iu')

const lineBreak = /\\n|<br ?\/?>/gi

export function mermaidIssue(source: string): string | null {
  if (source.length > MERMAID_LIMITS.source || source.split('\n').length > MERMAID_LIMITS.lines || source.split(/[;\n]/).length > MERMAID_LIMITS.statements) return '图表过大，请缩减后重试'
  if (!/^\s*(?:(?:%%[^\n]*\n)\s*)*(?:flowchart\b|graph\b|sequenceDiagram\b)/.test(source)) return '本阶段仅支持流程图与时序图'
  // Label line breaks are the only allowed backslash sequence and HTML-like tag. Removing these exact
  // tokens first keeps every other escape (<, \x3c) and tag rejected.
  // Removed rather than replaced by a space, so neighbours join (<<br>img → <img) and stay rejected.
  const scanned = source.replace(lineBreak, '')
  if (/%%\s*\{|^\s*---|<[a-z/!]|[\\@]|!\[|\]\s*\(|(?:https?|file|data|javascript|vbscript):/im.test(scanned)) return '包含不支持的配置、交互、资源或样式指令'
  for (const line of scanned.split(/\r?\n|\r/)) {
    const statements = line.split(';').map(statement => statement.trim())
    if (statements.some(statement => directive.test(statement))) return '包含不支持的配置、交互、资源或样式指令'
    if (statements.some(statement => styleKeyword.test(statement)) && !styleLine.test(line.trim())) return '样式指令需单独成行，仅支持 fill、color、stroke、stroke-width、stroke-dasharray、font-weight、opacity 的颜色或数值'
  }
  return null
}
