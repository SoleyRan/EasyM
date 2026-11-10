import type { Processor } from 'unified'
import type { MarkdownConfig, InlineContext } from '@lezer/markdown'
import { parser as lezerMarkdown } from '@lezer/markdown'
import { cjkFriendlyExtension } from 'micromark-extension-cjk-friendly'
import { classifyCharacter, classifyPrecedingCharacter, isCjk, isCjkOrIvs, isNonCjkPunctuation, isSpaceOrPunctuation, isUnicodeWhitespace } from 'micromark-extension-cjk-friendly-util'

/**
 * CommonMark only closes `**注意:**` when the closing `**` is followed by whitespace or punctuation,
 * which breaks common Chinese/Japanese/Korean writing such as `**注意:**后文`. Both parsers use the
 * CJK-friendly rule (github.com/tats-u/markdown-cjk-friendly): it relaxes flanking only next to CJK
 * characters, so non-CJK Markdown keeps standard CommonMark behaviour.
 */

/** Preview, export, DOCX and batch images: remark-parse reads micromark extensions from `data`. */
export function remarkCjkFriendly(this: Processor) {
  const data = this.data() as { micromarkExtensions?: unknown[] }
  ;(data.micromarkExtensions ??= []).push(cjkFriendlyExtension())
}

const ASTERISK = 42, UNDERSCORE = 95, TILDE = 126

function codeBefore(cx: InlineContext, pos: number): { code: number | null; at: number } {
  if (pos <= cx.offset) return { code: null, at: pos }
  const low = cx.char(pos - 1)
  if (low >= 0xdc00 && low <= 0xdfff && pos - 2 >= cx.offset) {
    const high = cx.char(pos - 2)
    if (high >= 0xd800 && high <= 0xdbff) return { code: (high - 0xd800) * 0x400 + low - 0xdc00 + 0x10000, at: pos - 2 }
  }
  return { code: low, at: pos - 1 }
}
function codeAfter(cx: InlineContext, pos: number): number | null {
  if (pos >= cx.end) return null
  const high = cx.char(pos)
  if (high >= 0xd800 && high <= 0xdbff && pos + 1 < cx.end) {
    const low = cx.char(pos + 1)
    if (low >= 0xdc00 && low <= 0xdfff) return (high - 0xd800) * 0x400 + low - 0xdc00 + 0x10000
  }
  return high
}

/** Open/close flags for a `*`/`_` run at [from, to), mirroring micromark-extension-cjk-friendly's attention. */
export function cjkFlanking(cx: InlineContext, marker: number, from: number, to: number): { open: boolean; close: boolean } {
  const previous = codeBefore(cx, from), next = codeAfter(cx, to)
  const before = classifyPrecedingCharacter(classifyCharacter(previous.code), () => codeBefore(cx, previous.at).code, previous.code)
  const after = classifyCharacter(next)
  const beforeNonCjkPunctuation = isNonCjkPunctuation(before)
  const beforeSpaceOrNonCjkPunctuation = beforeNonCjkPunctuation || isUnicodeWhitespace(before) || previous.code === ASTERISK || previous.code === UNDERSCORE
  const afterNonCjkPunctuation = isNonCjkPunctuation(after)
  const afterSpaceOrNonCjkPunctuation = afterNonCjkPunctuation || isUnicodeWhitespace(after) || next === ASTERISK || next === UNDERSCORE
  const open = !afterSpaceOrNonCjkPunctuation || afterNonCjkPunctuation && (beforeSpaceOrNonCjkPunctuation || isCjkOrIvs(before)) || next === TILDE
  const close = !beforeSpaceOrNonCjkPunctuation || beforeNonCjkPunctuation && (afterSpaceOrNonCjkPunctuation || isCjk(after)) || previous.code === TILDE
  return marker === ASTERISK ? { open, close } : { open: open && (isSpaceOrPunctuation(before) || !close), close: close && (isSpaceOrPunctuation(after) || !open) }
}

// lezer has no option for emphasis flanking, and its emphasis delimiter type is internal (it decides
// Emphasis vs StrongEmphasis). So the built-in parser still creates the delimiter and only its
// open/close side is recomputed. @lezer/markdown is pinned; cjk-emphasis.test.ts fails if this changes.
type Internal = { inlineNames: string[]; inlineParsers: Array<(cx: InlineContext, next: number, start: number) => number> }
type Delimiter = { from: number; to: number; side: number }
const internal = lezerMarkdown as unknown as Internal
const builtinEmphasis = internal.inlineParsers[internal.inlineNames.indexOf('Emphasis')]

/** Editor (live preview, toolbar state, formatting): same rule as the preview. */
export const cjkEmphasis: MarkdownConfig = {
  parseInline: [{
    name: 'Emphasis',
    parse(cx, next, start) {
      const end = builtinEmphasis(cx, next, start)
      if (end < 0) return end
      const parts = (cx as unknown as { parts: Array<Delimiter | null> }).parts
      const delimiter = parts[parts.length - 1]
      if (!delimiter || delimiter.from !== start || delimiter.to !== end) return end
      const { open, close } = cjkFlanking(cx, next, start, end)
      delimiter.side = (open ? 1 : 0) | (close ? 2 : 0)
      return end
    },
  }],
}
