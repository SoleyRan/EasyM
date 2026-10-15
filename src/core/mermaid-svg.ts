import { MERMAID_LIMITS } from './mermaid'

const tags = new Set('svg g defs marker path rect circle ellipse line polyline polygon text tspan title desc style clipPath'.split(' '))
const attributes = new Set('id class viewBox width height x y x1 y1 x2 y2 cx cy r rx ry d points transform fill stroke stroke-width stroke-dasharray stroke-linecap stroke-linejoin opacity fill-opacity stroke-opacity font-size font-family font-weight font-style text-anchor dominant-baseline alignment-baseline dy dx marker-start marker-mid marker-end markerWidth markerHeight refX refY orient markerUnits preserveAspectRatio clip-path style role aria-label'.split(' '))
const safeCss = (value: string) => !/[<>\\@]|expression|javascript|data:|https?:|file:|\/\*/i.test(value) && !/url\((?!\s*#[\w-]+\s*\))/i.test(value)
const cssProperties = new Set('fill stroke stroke-width stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin opacity fill-opacity stroke-opacity font-size font-family font-weight font-style text-anchor dominant-baseline alignment-baseline color background-color text-align marker-start marker-mid marker-end'.split(' '))
function declarations(value: string): string {
  return value.split(';').filter(entry => {
    const colon = entry.indexOf(':')
    return colon > 0 && cssProperties.has(entry.slice(0, colon).trim()) && safeCss(entry.slice(colon + 1))
  }).join(';')
}
function stylesheet(value: string): string {
  // Ignore at-rules (including Mermaid's default animations). Keep only plain
  // scoped selectors and paint/font declarations; SVG remains a static image.
  return Array.from(value.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map(([, selector, body]) => {
    if (!/^[#.][\w\s#.,:[\]="'()>+~*-]+$/.test(selector.trim()) || !safeCss(selector)) return ''
    return `${selector}{${declarations(body)}}`
  }).join('')
}

// Rebuild a detached SVG. No input node is ever inserted in the live DOM.
export function cleanMermaidSvg(value: string): string {
  if (value.length > MERMAID_LIMITS.svg || /<!DOCTYPE|<!ENTITY/i.test(value)) throw new Error('图像输出超限或格式不安全')
  const parsed = new DOMParser().parseFromString(value, 'image/svg+xml')
  const root = parsed.documentElement
  if (root.localName !== 'svg' || parsed.querySelector('parsererror')) throw new Error('图像格式无效')
  const box = (root.getAttribute('viewBox') ?? '').trim().split(/[ ,]+/).map(Number)
  if (box.length !== 4 || box.some(n => !Number.isFinite(n)) || box[2] <= 0 || box[3] <= 0 || Math.max(box[2], box[3]) > MERMAID_LIMITS.dimension) throw new Error('图像尺寸超限')
  let count = 0
  const doc = document.implementation.createDocument('http://www.w3.org/2000/svg', 'svg')
  const copy = (node: Element): Element | null => {
    if (++count > MERMAID_LIMITS.elements) throw new Error('图像元素超限')
    if (!tags.has(node.localName) || node.namespaceURI !== 'http://www.w3.org/2000/svg') return null
    const out = doc.createElementNS('http://www.w3.org/2000/svg', node.localName)
    for (const attr of Array.from(node.attributes)) {
      if (!attributes.has(attr.name) || !safeCss(attr.value)) continue
      out.setAttribute(attr.name, attr.name === 'style' ? declarations(attr.value) : attr.value)
    }
    if (node.localName === 'style') { out.textContent = stylesheet(node.textContent ?? ''); return out }
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) out.append(doc.createTextNode(child.textContent ?? ''))
      else if (child.nodeType === 1) { const safe = copy(child as Element); if (safe) out.append(safe) }
    }
    return out
  }
  const output = copy(root)!
  output.setAttribute('width', String(box[2])); output.setAttribute('height', String(box[3]))
  return new XMLSerializer().serializeToString(output)
}

export const mermaidDataUrl = (svg: string) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(cleanMermaidSvg(svg))
