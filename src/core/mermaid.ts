export const MERMAID_LIMITS = { source: 8000, lines: 120, statements: 120, count: 12, total: 32000, timeout: 5000, taskTimeout: 20000, svg: 1024 * 1024, elements: 10000, dimension: 8192 } as const
export interface MermaidSource { from: number; to: number; source: string; raw: string }

export function mermaidIssue(source: string): string | null {
  if (source.length > MERMAID_LIMITS.source || source.split('\n').length > MERMAID_LIMITS.lines || source.split(/[;\n]/).length > MERMAID_LIMITS.statements) return '图表过大，请缩减后重试'
  if (!/^\s*(?:(?:%%[^\n]*\n)\s*)*(?:flowchart\b|graph\b|sequenceDiagram\b)/.test(source)) return '本阶段仅支持流程图与时序图'
  if (/%%\s*\{|^\s*---|<[a-z/!]|[\\@]|!\[|\]\s*\(|(?:https?|file|data|javascript|vbscript):|\b(?:click|href|link|links|image|img|style|classDef|linkStyle|accDescr)\b/im.test(source)) return '包含不支持的配置、交互、资源或样式指令'
  return null
}
