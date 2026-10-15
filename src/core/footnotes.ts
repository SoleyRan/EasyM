import type { FootnoteDefinition, Nodes, Root } from 'mdast'

const key = (identifier: string) => identifier.toUpperCase()

// Number from document references first, then from referenced note contents.
// Iterate each definition once, so cyclic notes never expand recursively.
export function indexFootnotes(tree: Root) {
  const definitions = new Map<string, FootnoteDefinition>()
  const all: FootnoteDefinition[] = []
  const walk = (node: Nodes, enter: (node: Nodes) => boolean) => {
    const queue = [node]
    while (queue.length) {
      const next = queue.pop()!
      if (!enter(next)) continue
      if ('children' in next) for (let i = next.children.length - 1; i >= 0; i--) queue.push(next.children[i] as Nodes)
    }
  }
  walk(tree, node => {
    if (node.type === 'footnoteDefinition') { all.push(node); if (!definitions.has(key(node.identifier))) definitions.set(key(node.identifier), node) }
    return true
  })
  const order: FootnoteDefinition[] = []
  const numbers = new Map<string, number>()
  const reference = (node: Nodes) => {
    if (node.type === 'footnoteDefinition') return false
    if (node.type === 'footnoteReference') {
      const id = key(node.identifier), definition = definitions.get(id)
      if (definition && !numbers.has(id)) { order.push(definition); numbers.set(id, order.length) }
    }
    return true
  }
  walk(tree, reference)
  for (let i = 0; i < order.length; i++) for (const child of order[i].children) walk(child, reference)
  const used = new Set(order)
  return { order, retained: all.filter(node => !used.has(node)), number: (identifier: string) => numbers.get(key(identifier)) }
}
