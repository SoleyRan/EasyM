import { StateEffect, StateField, type EditorState, type Text } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import type { PreviewBlock } from '../core/markdown'
import { activeSourceRanges, frontmatterEnd, liveTokens, MAX_LIVE_BLOCK, MAX_LIVE_DOCUMENT, touches } from '../core/live-preview'
import { largeLines } from './large-lines'

interface Host { image(resource: string): Promise<string | null>; editImage(from: number): void }
interface Phase { composing?: boolean; dragging?: boolean }
interface LiveValue { enabled: boolean; composing: boolean; dragging: boolean; headerEnd: number; blocks: PreviewBlock[]; context: unknown; decorations: DecorationSet }
export const setLiveEnabled = StateEffect.define<boolean>()
export const setLiveBlocks = StateEffect.define<{ doc: Text; blocks: PreviewBlock[]; context: unknown }>()
const setLivePhase = StateEffect.define<Phase>()

export function liveAvailable(state: EditorState): boolean {
  return state.doc.length <= MAX_LIVE_DOCUMENT && state.field(largeLines, false) !== undefined && state.field(largeLines) === 0
}

class SymbolWidget extends WidgetType {
  constructor(readonly text: string, readonly className: string) { super() }
  eq(other: SymbolWidget) { return this.text === other.text && this.className === other.className }
  toDOM() { const node = document.createElement('span'); node.className = this.className; node.textContent = this.text; return node }
  ignoreEvent() { return false }
}

class BlockWidget extends WidgetType {
  private cleanups = new WeakMap<HTMLElement, () => void>()
  constructor(readonly block: PreviewBlock, readonly doc: Text, readonly context: unknown, readonly host: Host) { super() }
  eq(other: BlockWidget) { return this.doc === other.doc && this.context === other.context && this.block.from === other.block.from && this.block.html === other.block.html }
  toDOM(view: EditorView) {
    const node = document.createElement('div')
    node.className = `live-rendered-block live-block-${this.block.type}`
    node.dataset.sourceFrom = String(this.block.from)
    // HTML originates from the same sanitised Worker output as the preview pane.
    const body = document.createElement('div'); body.innerHTML = this.block.html
    const button = document.createElement('button')
    button.type = 'button'; button.className = 'live-source-button'; button.textContent = '源码'
    const labels: Record<string, string> = { code: '代码块', table: '表格', image: '图片', thematicBreak: '分隔线' }
    button.setAttribute('aria-label', `显示${labels[this.block.type] ?? '块'}源码`)
    const current = () => view.state.doc === this.doc && !view.composing
    const reveal = (offset = this.block.from) => {
      if (!current()) return
      const position = Math.min(this.block.to, Math.max(this.block.from, offset))
      view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'nearest' }) })
      view.focus()
    }
    button.addEventListener('mousedown', event => event.preventDefault())
    button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); reveal() })
    node.append(button, body)
    node.addEventListener('click', event => {
      if ((event.target as HTMLElement).closest('button')) return
      event.preventDefault()
      if (this.block.type === 'image') { node.classList.toggle('live-image-selected'); return }
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-source-from]')
      reveal(Number(target?.dataset.sourceFrom ?? this.block.from))
    })
    node.addEventListener('dblclick', event => {
      event.preventDefault()
      if (this.block.type === 'image' && current()) this.host.editImage(this.block.from)
    })
    let alive = true
    const urls: string[] = []
    for (const image of body.querySelectorAll<HTMLImageElement>('img[data-resource]')) {
      image.removeAttribute('src')
      const resource = image.dataset.resource ?? ''
      this.host.image(resource).then(url => {
        if (!url) { if (alive) image.alt += '（图片缺失或未授权）'; return }
        if (!alive) { URL.revokeObjectURL(url); return }
        urls.push(url); image.src = url
        image.addEventListener('load', () => view.requestMeasure(), { once: true })
      }).catch(() => { if (alive) image.alt += '（图片缺失或未授权）' })
    }
    this.cleanups.set(node, () => { alive = false; urls.forEach(URL.revokeObjectURL) })
    return node
  }
  destroy(node: HTMLElement) { this.cleanups.get(node)?.(); this.cleanups.delete(node) }
  ignoreEvent() { return true }
  get estimatedHeight() { return this.block.type === 'image' ? 240 : this.block.type === 'table' ? 120 : 100 }
}

export function liveRendering(host: Host) {
  const field = StateField.define<LiveValue>({
    create: state => ({ enabled: false, composing: false, dragging: false, headerEnd: frontmatterEnd(state.doc), blocks: [], context: null, decorations: Decoration.none }),
    update(value, transaction) {
      let { enabled, composing, dragging, headerEnd, blocks, context } = value
      let changed = transaction.docChanged || !!transaction.selection || syntaxTree(transaction.startState) !== syntaxTree(transaction.state)
      if (transaction.docChanged) { blocks = []; headerEnd = frontmatterEnd(transaction.newDoc); dragging = false }
      for (const effect of transaction.effects) {
        if (effect.is(setLiveEnabled)) { enabled = effect.value; changed = true }
        if (effect.is(setLiveBlocks) && effect.value.doc === transaction.state.doc) { blocks = effect.value.blocks; context = effect.value.context; changed = true }
        if (effect.is(setLivePhase)) { composing = effect.value.composing ?? composing; dragging = effect.value.dragging ?? dragging; changed = true }
      }
      let decorations = value.decorations
      if (changed && (!enabled || composing || !dragging || transaction.docChanged)) {
        const active = activeSourceRanges(transaction.state, syntaxTree(transaction.state))
        decorations = enabled && !composing && liveAvailable(transaction.state) ? Decoration.set(blocks.filter(block => block.from >= headerEnd && block.to <= transaction.state.doc.length && block.to - block.from <= MAX_LIVE_BLOCK && !touches(active, block.from, block.to)).map(block => Decoration.replace({ widget: new BlockWidget(block, transaction.state.doc, context, host), block: true }).range(block.from, block.to)), true) : Decoration.none
      }
      return changed ? { enabled, composing, dragging, headerEnd, blocks, context, decorations } : value
    },
    provide: value => EditorView.decorations.from(value, state => state.decorations),
  })
  const inline = ViewPlugin.fromClass(class {
    decorations: DecorationSet = Decoration.none
    constructor(view: EditorView) { this.build(view) }
    update(update: ViewUpdate) {
      const model = update.state.field(field)
      if (!model.enabled || model.composing || !model.dragging || update.docChanged) this.build(update.view)
    }
    build(view: EditorView) {
      const model = view.state.field(field)
      if (!model.enabled || model.composing || !liveAvailable(view.state)) { this.decorations = Decoration.none; return }
      const tree = syntaxTree(view.state)
      const active = activeSourceRanges(view.state, tree)
      const protectedRanges = [...active, ...model.blocks.filter(block => !touches(active, block.from, block.to))]
      this.decorations = Decoration.set(liveTokens(view.state, tree, view.visibleRanges, protectedRanges, model.headerEnd).map(token => {
        if (token.kind === 'hide') return Decoration.replace({}).range(token.from, token.to)
        if (token.kind === 'line') return Decoration.line({ class: token.className }).range(token.from)
        if (token.kind === 'symbol') return Decoration.replace({ widget: new SymbolWidget(token.text!, token.className!) }).range(token.from, token.to)
        return Decoration.mark({ class: token.className }).range(token.from, token.to)
      }), true)
    }
  }, { decorations: value => value.decorations })
  const drag = ViewPlugin.fromClass(class {
    constructor(readonly view: EditorView) { window.addEventListener('mouseup', this.release); window.addEventListener('blur', this.release) }
    release = () => { if (this.view.state.field(field).dragging) this.view.dispatch({ effects: setLivePhase.of({ dragging: false }) }) }
    destroy() { window.removeEventListener('mouseup', this.release); window.removeEventListener('blur', this.release) }
  })
  return [field, inline, drag, EditorView.domEventHandlers({
    mousedown: (event, view) => {
      if (event.button === 0 && view.state.field(field).enabled && !(event.target as HTMLElement).closest('.live-rendered-block')) view.dispatch({ effects: setLivePhase.of({ dragging: true }) })
      return false
    },
    compositionstart: (_event, view) => { view.dispatch({ effects: setLivePhase.of({ composing: true }) }); return false },
    compositionend: (_event, view) => { queueMicrotask(() => { if (view.dom.isConnected) view.dispatch({ effects: setLivePhase.of({ composing: false }) }) }); return false },
  }), EditorView.editorAttributes.compute([field, largeLines], state => ({ class: state.field(field).enabled && !state.field(field).composing && liveAvailable(state) ? 'cm-live-preview' : '' }))]
}
