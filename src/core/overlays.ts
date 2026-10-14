export type OverlayLevel = 'selection' | 'content' | 'menu' | 'modal'
const priorities: Record<OverlayLevel, number> = { selection: 0, content: 1, menu: 2, modal: 3 }
interface Entry { id: number; level: OverlayLevel; parent?: number; dismiss(): void }
export interface OverlayLease { id: number; current(): boolean; release(): void }

/** Generation identities keep an obsolete close/position callback from reviving a tool. */
export class OverlayManager {
  private entries: Entry[] = []
  private generation = 0
  open(level: OverlayLevel, dismiss: () => void, parent?: number): OverlayLease | null {
    const top = this.entries.at(-1)
    const parentIndex = parent === undefined ? -1 : this.entries.findIndex(entry => entry.id === parent)
    if (parent !== undefined && parentIndex < 0) return null
    if (top && parentIndex < 0 && priorities[level] < priorities[top.level]) return null
    const survivors = parentIndex >= 0 ? this.entries.slice(0, parentIndex + 1) : []
    const removed = this.entries.filter(entry => !survivors.includes(entry))
    const id = ++this.generation
    this.entries = [...survivors, { id, level, parent, dismiss }]
    removed.reverse().forEach(entry => entry.dismiss())
    return { id, current: () => this.entries.some(entry => entry.id === id), release: () => this.release(id) }
  }
  private release(id: number) {
    const index = this.entries.findIndex(entry => entry.id === id)
    if (index < 0) return
    const removed = this.entries.splice(index)
    this.generation++
    removed.slice(1).reverse().forEach(entry => entry.dismiss())
  }
  dismissTop() { const top = this.entries.at(-1); if (top) { this.release(top.id); top.dismiss() }; return !!top }
  top() { return this.entries.at(-1) }
  modal() { return [...this.entries].reverse().find(entry => entry.level === 'modal') }
  version() { return this.generation }
}

export function positionOverlay(anchor: { left: number; right: number; top: number; bottom: number }, size: { width: number; height: number }, viewport: { width: number; height: number }, side: 'below' | 'right' = 'below') {
  const gap = 6
  let left = side === 'right' ? anchor.right + gap : anchor.left
  let top = side === 'right' ? anchor.top : anchor.bottom + gap
  if (side === 'right' && left + size.width > viewport.width - gap) left = anchor.left - size.width - gap
  if (side === 'below' && top + size.height > viewport.height - gap) top = anchor.top - size.height - gap
  return { left: Math.max(gap, Math.min(left, viewport.width - size.width - gap)), top: Math.max(gap, Math.min(top, viewport.height - size.height - gap)) }
}
