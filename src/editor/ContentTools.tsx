import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { OverlayPortal, PositionedOverlay, useModalOverlay, useOverlays } from './Overlay'
import type { OverlayLease } from '../core/overlays'
import type { CommandContext, CommandStatus } from '../core/commands'
import type { LinkTarget } from '../core/links'
import { paragraphKinds, type ParagraphKind, type ParagraphTarget } from '../core/content-tools'

export const selectionActions = [['bold', 'B', '加粗'], ['italic', 'I', '斜体'], ['strike', 'S̶', '删除线'], ['inlineCode', '`…`', '行内代码'], ['link', '↗', '链接']] as const
export interface SelectionAnchor { rect: DOMRect; context: CommandContext }
export function SelectionToolbar({ anchor, status, execute, dismiss }: { anchor: SelectionAnchor; status(id: string, context: CommandContext): CommandStatus; execute(id: string, argument: unknown, context: CommandContext): void; dismiss(): void }) {
  const { manager } = useOverlays(), lease = useRef<OverlayLease | null>(null), element = useRef<HTMLDivElement>(null)
  const close = useRef(dismiss); close.current = dismiss
  const [visible, setVisible] = useState(false)
  useLayoutEffect(() => {
    lease.current = manager.open('selection', () => { const focused = element.current?.contains(document.activeElement); close.current(); if (focused) document.querySelector<HTMLElement>('.document-panel:not([hidden]) .cm-content')?.focus() })
    setVisible(!!lease.current)
    const outside = (event: PointerEvent) => { if (!element.current?.contains(event.target as Node)) close.current() }
    document.addEventListener('pointerdown', outside)
    return () => { lease.current?.release(); document.removeEventListener('pointerdown', outside) }
  }, [manager, anchor])
  if (!visible) return null
  return <PositionedOverlay role="toolbar" label="选区格式工具栏" className="selection-toolbar" element={element} lease={lease} anchor={() => anchor.rect} onMouseDown={event => event.preventDefault()} onKeyDown={event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      const buttons = [...element.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')], index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      event.preventDefault(); buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
    }
  }}>{selectionActions.map(([kind, icon, label]) => {
    const value = status('format.' + kind, anchor.context)
    return <button key={kind} aria-label={label} title={value.reason ?? label} disabled={!value.enabled} aria-pressed={value.checked} onClick={() => execute('format.' + kind, undefined, anchor.context)}>{icon}</button>
  })}</PositionedOverlay>
}

function ToolDialog({ title, onCancel, onComposing, children }: { title: string; onCancel(): void; onComposing(value: boolean): void; children: ReactNode }) {
  const element = useRef<HTMLDivElement>(null), composing = useRef(false)
  useModalOverlay(element)
  useEffect(() => { element.current?.querySelector<HTMLElement>('input,select,button')?.focus() }, [])
  useEffect(() => () => onComposing(false), [])
  return <OverlayPortal><div className="modal-backdrop" onKeyDown={event => {
    if (event.nativeEvent.isComposing || composing.current) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel() }
    if (event.key === 'Tab') {
      const nodes = [...element.current!.querySelectorAll<HTMLElement>('input,select,button:not(:disabled)')]
      if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus() }
      else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus() }
    }
  }}><div className="content-tool-dialog close-dialog" ref={element} role="dialog" aria-modal="true" aria-label={title} onCompositionStart={() => { composing.current = true; onComposing(true) }} onCompositionEnd={() => queueMicrotask(() => { composing.current = false; onComposing(false) })}><h2>{title}</h2>{children}</div></div></OverlayPortal>
}
export function LinkDialog({ existing, label: initialLabel, error, onSubmit, onUnlink, onOpen, onCancel, onComposing }: { existing: LinkTarget | null; label: string; error: string; onSubmit(label: string, url: string): void; onUnlink(): void; onOpen(): void; onCancel(): void; onComposing(value: boolean): void }) {
  const [label, setLabel] = useState(initialLabel), [url, setUrl] = useState(existing?.url ?? '')
  return <ToolDialog title="插入 / 编辑链接" onCancel={onCancel} onComposing={onComposing}><form onSubmit={event => { event.preventDefault(); onSubmit(label, url) }}>
    <label>显示文字（保留行内 Markdown）<input aria-label="链接显示文字" value={label} maxLength={10000} onChange={event => setLabel(event.target.value)} /></label>
    <label>地址<input aria-label="链接地址" value={url} maxLength={4096} placeholder="https://、mailto:、#锚点或相对文档路径" onChange={event => setUrl(event.target.value)} /></label>
    {existing?.reference && <p>确认后仅将此处引用链接转换为行内链接，定义和其他引用保持原样。</p>}
    {error && <p role="alert" className="image-error">{error}</p>}
    <div className="panel-actions">{existing && <><button type="button" onClick={onUnlink}>解除链接</button><button type="button" title="打开当前正文中的已保存地址；不会应用输入" onClick={onOpen}>打开现有地址</button></>}<button type="button" onClick={onCancel}>取消</button><button type="submit" className="apply-button">确认链接</button></div>
  </form></ToolDialog>
}

export const codeLanguages = [['', '无语言'], ['javascript', 'JavaScript'], ['typescript', 'TypeScript'], ['python', 'Python'], ['rust', 'Rust'], ['java', 'Java'], ['c', 'C'], ['cpp', 'C++'], ['csharp', 'C#'], ['go', 'Go'], ['html', 'HTML 网页'], ['css', 'CSS 样式'], ['json', 'JSON 数据'], ['yaml', 'YAML 配置'], ['sql', 'SQL 数据库'], ['bash', 'Bash 命令行'], ['powershell', 'PowerShell 命令行'], ['markdown', 'Markdown 文档'], ['text', '纯文本']] as const
export function LanguageDialog({ language, error, onSubmit, onCancel, onComposing }: { language: string; error: string; onSubmit(language: string): void; onCancel(): void; onComposing(value: boolean): void }) {
  const [query, setQuery] = useState(''), [value, setValue] = useState(language)
  const candidates: Array<readonly [string, string]> = [...codeLanguages]
  if (!candidates.some(([tag]) => tag === language)) candidates.unshift([language, `${language}（自定义，保留原标记）`])
  const filtered = candidates.filter(([tag, label]) => `${tag} ${label}`.toLowerCase().includes(query.toLowerCase()))
  return <ToolDialog title="选择代码语言" onCancel={onCancel} onComposing={onComposing}><p>当前：{language || '无语言'}。仅修改此代码块的语言标记，代码正文和围栏保持原样。</p><input aria-label="搜索代码语言" type="search" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && filtered.length) { event.preventDefault(); onSubmit(filtered[0][0]) } }} />
    <div className="language-options" role="group" aria-label="代码语言选项">{filtered.map(([tag, label]) => <button key={tag} aria-pressed={value === tag} onClick={() => setValue(tag)}>{label}{tag && <small>{tag}</small>}</button>)}{!filtered.length && <p>没有匹配语言</p>}</div>
    {error && <p role="alert">{error}</p>}<div className="panel-actions"><button onClick={onCancel}>取消</button><button className="apply-button" onClick={() => onSubmit(value)}>应用语言</button></div>
  </ToolDialog>
}
export function ParagraphDialog({ target, error, onSubmit, onCancel, onComposing }: { target: ParagraphTarget; error: string; onSubmit(kind: ParagraphKind): void; onCancel(): void; onComposing(value: boolean): void }) {
  const [kind, setKind] = useState<ParagraphKind>('paragraph')
  return <ToolDialog title="转换为" onCancel={onCancel} onComposing={onComposing}><p>作用范围：第 {target.lineFrom}–{target.lineTo} 行的完整段落 / 逻辑行，保留文字与行内 Markdown。</p><label>段落类型<select aria-label="转换段落类型" value={kind} onChange={event => setKind(event.target.value as ParagraphKind)}>{paragraphKinds.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>{error && <p role="alert">{error}</p>}<div className="panel-actions"><button onClick={onCancel}>取消</button><button className="apply-button" onClick={() => onSubmit(kind)}>应用转换</button></div></ToolDialog>
}
