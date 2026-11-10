/**
 * `<img>` tags inside raw HTML source, with the exact source spans of their `src` and `alt`
 * values, so an edited image copy can be written back without touching `width`, `align` or any
 * surrounding markup. Offsets are relative to the scanned string; callers add the node offset.
 */
export interface HtmlAttribute { from: number; to: number; value: string }
export interface HtmlImageTag {
  /** The whole `<img …>` tag. */
  from: number; to: number
  /** Value spans include their quotes; `value` is entity-decoded. */
  src: HtmlAttribute | null; alt: HtmlAttribute | null
  /** Just after `<img`, where a missing attribute is inserted. */
  nameEnd: number
}

const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] !== '#') return named[body.toLowerCase()] ?? match
    const code = /^#x/i.test(body) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
  })
}

/** Scans tags the way an HTML tokenizer reads attributes; comments are skipped, unclosed tags ignored. */
export function htmlImageTags(source: string): HtmlImageTag[] {
  const tags: HtmlImageTag[] = []
  let at = 0
  while (at < source.length) {
    const open = source.indexOf('<', at)
    if (open < 0) break
    if (source.startsWith('<!--', open)) { const close = source.indexOf('-->', open + 4); if (close < 0) break; at = close + 3; continue }
    if (!/^<img[\s/>]/i.test(source.slice(open, open + 5))) { at = open + 1; continue }
    let pos = open + 4, src: HtmlAttribute | null = null, alt: HtmlAttribute | null = null, closed = false
    while (pos < source.length) {
      while (pos < source.length && /[\s/]/.test(source[pos])) pos++
      if (source[pos] === '>') { closed = true; pos++; break }
      const nameStart = pos
      while (pos < source.length && !/[\s/>="']/.test(source[pos])) pos++
      if (pos === nameStart) { pos++; continue }
      const name = source.slice(nameStart, pos).toLowerCase()
      let value = pos
      while (value < source.length && /\s/.test(source[value])) value++
      if (source[value] !== '=') continue
      value++
      while (value < source.length && /\s/.test(source[value])) value++
      let raw: string, end: number
      if (source[value] === '"' || source[value] === "'") {
        const close = source.indexOf(source[value], value + 1)
        if (close < 0) { pos = source.length; break }
        raw = source.slice(value + 1, close); end = close + 1
      } else {
        end = value
        while (end < source.length && !/[\s>]/.test(source[end])) end++
        raw = source.slice(value, end)
      }
      pos = end
      const attribute = { from: value, to: end, value: decodeEntities(raw) }
      if (name === 'src' && !src) src = attribute
      if (name === 'alt' && !alt) alt = attribute
    }
    if (!closed) break
    tags.push({ from: open, to: pos, src, alt, nameEnd: open + 4 })
    at = pos
  }
  return tags
}

const quoted = (value: string) => `"${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`

/** The tag text with only `src` and `alt` replaced (or inserted after `<img` when absent). */
export function rewriteHtmlImage(source: string, tag: HtmlImageTag, src: string, alt: string): string {
  const edits = [
    tag.src ? { from: tag.src.from, to: tag.src.to, insert: quoted(src) } : { from: tag.nameEnd, to: tag.nameEnd, insert: ` src=${quoted(src)}` },
    tag.alt ? { from: tag.alt.from, to: tag.alt.to, insert: quoted(alt) } : { from: tag.nameEnd, to: tag.nameEnd, insert: ` alt=${quoted(alt)}` },
  ].sort((a, b) => b.from - a.from)
  let text = source.slice(tag.from, tag.to)
  for (const edit of edits) text = text.slice(0, edit.from - tag.from) + edit.insert + text.slice(edit.to - tag.from)
  return text
}

/** Shifts a tag found in `node.value` to document offsets. */
export function offsetTag(tag: HtmlImageTag, by: number): HtmlImageTag {
  const shift = (a: HtmlAttribute | null) => a && { ...a, from: a.from + by, to: a.to + by }
  return { from: tag.from + by, to: tag.to + by, src: shift(tag.src), alt: shift(tag.alt), nameEnd: tag.nameEnd + by }
}
