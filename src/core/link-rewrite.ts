import type { Nodes } from 'mdast'
import { parseMarkdownAst } from './markdown-ast'

/**
 * v2 step 2B: rewrites relative document/image links when a Markdown file moves inside a
 * workspace. Pure and byte-exact: only the URL span of each affected link or definition
 * changes; every other byte (BOM, line endings, formatting) is preserved.
 */
export interface TextPatch { from: number; to: number; insert: string }

/** Workspace-relative `/` paths. Returns null when the URL is not a rewritable relative path. */
function split(url: string): { path: string; suffix: string } | null {
  if (!url || /^[a-z][a-z\d+.-]*:|^[#/]|^\\/i.test(url) || /[\x00-\x1f\\]/.test(url)) return null
  const at = url.search(/[?#]/)
  return at < 0 ? { path: url, suffix: '' } : { path: url.slice(0, at), suffix: url.slice(at) }
}
const directory = (path: string) => path.split('/').slice(0, -1)

/** Resolves `relative` against the directory of `from`; null if it escapes the workspace. */
export function resolveRelative(from: string, relative: string): string | null {
  let decoded: string
  try { decoded = decodeURIComponent(relative) } catch { return null }
  const parts = directory(from)
  for (const part of decoded.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { if (!parts.length) return null; parts.pop() } else parts.push(part)
  }
  return parts.join('/')
}

/** Shortest relative path from the directory of `from` to `target`, percent-encoding only what Markdown needs. */
export function relativeTo(from: string, target: string): string {
  const base = directory(from), parts = target.split('/')
  let common = 0
  while (common < base.length && common < parts.length - 1 && base[common] === parts[common]) common++
  const up = Array(base.length - common).fill('..')
  return [...up, ...parts.slice(common)].map((part) => part === '..' ? part : encodeURI(part).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')
}

interface UrlSpan { from: number; to: number; url: string; bracketed: boolean }

/** Locates the exact source span of each link/image/definition URL (inline `( … )` or `<…>`). */
function urlSpans(text: string): UrlSpan[] {
  const bom = text.startsWith('﻿') ? 1 : 0
  const source = bom ? text.slice(1) : text
  const tree = parseMarkdownAst(source), spans: UrlSpan[] = []
  const visit = (node: Nodes) => {
    if ((node.type === 'link' || node.type === 'image' || node.type === 'definition') && node.position && node.url) {
      const start = node.position.start.offset!, end = node.position.end.offset!
      const raw = source.slice(start, end)
      // Definitions: `[id]: url`; links/images: last `](` that opens the destination.
      const open = node.type === 'definition' ? raw.search(/\]:[ \t]*(?:\r?\n[ \t]*)?/) : raw.lastIndexOf('](')
      if (open >= 0) {
        let at = start + open + 2
        if (node.type === 'definition') { while (/[ \t\r\n]/.test(source[at])) at++ }
        const bracketed = source[at] === '<'
        const urlStart = bracketed ? at + 1 : at
        const urlEnd = bracketed ? source.indexOf('>', urlStart) : (() => { let i = urlStart, depth = 0; while (i < end && !/[ \t\r\n]/.test(source[i]) && !(source[i] === ')' && depth === 0)) { if (source[i] === '(') depth++; else if (source[i] === ')') depth--; i++ } return i })()
        // Only rewrite spans whose raw text decodes to the parsed URL; anything else is left as-is.
        if (urlEnd > urlStart && unescape(source.slice(urlStart, urlEnd)) === node.url) spans.push({ from: urlStart + bom, to: urlEnd + bom, url: node.url, bracketed })
      }
    }
    if ('children' in node) node.children.forEach((child) => visit(child as Nodes))
  }
  visit(tree)
  return spans
}
// Markdown backslash escapes and entity-free raw URLs only; other forms are skipped, never guessed.
const unescape = (raw: string) => raw.replace(/\\([!-/:-@[-`{-~])/g, '$1')

/** Parsed URLs of every link, image and definition in the document (code is excluded). */
export const linkUrls = (text: string): string[] => urlSpans(text).map((span) => span.url)

export interface LinkRewrite { patches: TextPatch[]; text: string; changed: number; skipped: number }

function apply(text: string, patches: TextPatch[]): string {
  let result = '', cursor = 0
  for (const patch of [...patches].sort((a, b) => a.from - b.from)) { result += text.slice(cursor, patch.from) + patch.insert; cursor = patch.to }
  return result + text.slice(cursor)
}
function format(url: string, bracketed: boolean): string {
  return bracketed ? url.replace(/[<>]/g, (c) => encodeURIComponent(c)) : url.replace(/[ <>]/g, (c) => encodeURIComponent(c))
}

/**
 * Links inside a moved document: every relative URL that resolved to `target` from `oldPath`
 * is rewritten to reach the same target from `newPath`. Targets moving with the document
 * (managed `assets/` copied in 2C) are listed in `moved`.
 */
export function rewriteOutgoing(text: string, oldPath: string, newPath: string, moved: ReadonlyMap<string, string> = new Map()): LinkRewrite {
  const patches: TextPatch[] = []; let skipped = 0
  for (const span of urlSpans(text)) {
    const parts = split(span.url); if (!parts || !parts.path) continue
    const target = resolveRelative(oldPath, parts.path)
    if (target === null) { skipped++; continue }
    const destination = moved.get(target) ?? target
    // A link that already resolves to the right place from the new location is left byte-exact.
    if (resolveRelative(newPath, parts.path) === destination) continue
    const next = relativeTo(newPath, destination) + parts.suffix
    if (resolveRelative(newPath, next.split(/[?#]/)[0]) === destination && next !== span.url) patches.push({ from: span.from, to: span.to, insert: format(next, span.bracketed) })
  }
  return { patches, text: apply(text, patches), changed: patches.length, skipped }
}

/** Links in another document `path` that pointed at `oldTarget` now point at `newTarget`. */
export function rewriteIncoming(text: string, path: string, oldTarget: string, newTarget: string): LinkRewrite {
  const patches: TextPatch[] = []
  for (const span of urlSpans(text)) {
    const parts = split(span.url); if (!parts || !parts.path) continue
    if (resolveRelative(path, parts.path) !== oldTarget) continue
    const next = relativeTo(path, newTarget) + parts.suffix
    if (next !== span.url) patches.push({ from: span.from, to: span.to, insert: format(next, span.bracketed) })
  }
  return { patches, text: apply(text, patches), changed: patches.length, skipped: 0 }
}
