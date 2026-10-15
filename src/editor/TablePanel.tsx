import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { parseDocument } from '../core/markdown'
import { escapeCell, type Alignment, type SourceTable, type TableOperation } from '../core/tables'
import { OverlayPortal, useModalOverlay, useOverlays } from './Overlay'

export interface TableSession { table: SourceTable; row: number; column: number; draft: string; version: number }
export function DraftDecision({ error, onChoose }: { error?: string; onChoose(choice: 'apply' | 'discard' | 'cancel'): void }) {
  const dialog = useRef<HTMLDivElement>(null)
  useModalOverlay(dialog)
  useEffect(() => { dialog.current?.querySelector<HTMLButtonElement>('button')?.focus() }, [])
  return <OverlayPortal><div className="modal-backdrop" onKeyDown={event => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onChoose('cancel') }
    if (event.key === 'Tab') {
      const buttons = [...dialog.current!.querySelectorAll<HTMLButtonElement>('button')]
      if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus() }
      else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus() }
    }
  }}><div ref={dialog} className="close-dialog" role="dialog" aria-modal="true" aria-label="未应用的表格输入"><h2>未应用的表格输入</h2><p>先应用到正文或放弃输入，再继续操作。取消会保留输入。</p>{error && <p role="alert">{error}</p>}<div className="panel-actions"><button onClick={() => onChoose('cancel')}>取消</button><button onClick={() => onChoose('discard')}>放弃</button><button className="apply-button" onClick={() => onChoose('apply')}>应用</button></div></div></div></OverlayPortal>
}
export function TableInsert({ error, onInsert, onClose }: { error?: string; onInsert(rows: number, columns: number): void; onClose(): void }) {
  const dialog = useRef<HTMLFormElement>(null), [rows, setRows] = useState(2), [columns, setColumns] = useState(3)
  const composing = useRef(false)
  useModalOverlay(dialog)
  useEffect(() => { dialog.current?.querySelector<HTMLInputElement>('input')?.focus() }, [])
  return <OverlayPortal><div className="modal-backdrop" onKeyDown={event => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
    if (event.key === 'Tab') {
      const nodes = [...dialog.current!.querySelectorAll<HTMLElement>('input,button')]
      if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus() }
      else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus() }
    }
  }}><form ref={dialog} className="close-dialog table-insert" role="dialog" aria-modal="true" aria-label="插入表格" onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { queueMicrotask(() => { composing.current = false }) }} onSubmit={event => { event.preventDefault(); if (!composing.current) onInsert(rows, columns) }}><h2>插入表格</h2><p>包含一行表头；默认 3 列、2 行正文。</p><div className="table-dimensions"><label>列数 <input type="number" aria-label="列数" min={1} max={20} value={columns} onChange={event => setColumns(Number(event.target.value))} /></label><label>正文行数 <input type="number" aria-label="正文行数" min={1} max={200} value={rows} onChange={event => setRows(Number(event.target.value))} /></label></div><div className="table-picker" role="group" aria-label="网格选择">{Array.from({ length: 30 }, (_, i) => <button type="button" key={i} aria-label={`${Math.floor(i / 6) + 1} 行正文 ${i % 6 + 1} 列`} aria-pressed={Math.floor(i / 6) < rows && i % 6 < columns} onClick={() => { setRows(Math.floor(i / 6) + 1); setColumns(i % 6 + 1) }} />)}</div>{error && <p role="alert">{error}</p>}<div className="panel-actions"><button type="button" onClick={onClose}>取消</button><button type="submit" className="apply-button">创建表格</button></div></form></div></OverlayPortal>
}
export function TablePanel({ session, error, decision, onComposing, onDraft, onCommit, onNavigate, onDismiss }: {
  session: TableSession; error: string; decision: boolean; onComposing(value: boolean): void; onDraft(value: string): void;
  onCommit(mode: 'end' | 'next' | 'previous' | 'stay', operation?: TableOperation, align?: Alignment): void;
  onNavigate(row: number, column: number): void; onDismiss(): void;
}) {
  const { manager } = useOverlays(), input = useRef<HTMLTextAreaElement>(null), dismiss = useRef(onDismiss)
  dismiss.current = onDismiss
  const composing = useRef(false)
  useLayoutEffect(() => {
    if (decision) return
    const lease = manager.open('content', () => dismiss.current())
    input.current?.focus()
    return () => lease?.release()
  }, [manager, decision])
  useEffect(() => { if (!decision) { input.current?.focus(); input.current?.setSelectionRange(0, input.current.value.length) } }, [session.row, session.column, session.version, decision])
  const { table, row, column, draft } = session
  const [rendered, setRendered] = useState('')
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try { setRendered(parseDocument(`| 单元格 |\n| --- |\n| ${escapeCell(draft)} |`, { math: false }).html) } catch { setRendered('') }
    }, 120)
    return () => window.clearTimeout(timer)
  }, [draft])
  const operation = (kind: TableOperation) => {
    if (composing.current) return
    const contents = kind === 'deleteRow' ? table.rows[row].map((cell, c) => c === column ? draft : cell.value) : kind === 'deleteColumn' ? table.rows.map((cells, r) => r === row ? draft : cells[column].value) : []
    if (contents.some(value => value.trim()) && !window.confirm('此行/列包含内容，确认删除？可一次撤销恢复。')) return
    onCommit('stay', kind)
  }
  return <OverlayPortal><section className="table-panel" role="dialog" aria-label="编辑表格" inert={decision} onKeyDown={event => {
    if (event.nativeEvent.isComposing || composing.current) return
    if (event.target === input.current && ['Enter', 'Tab', 'Escape'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation()
      if (event.key === 'Escape') onDraft(table.rows[row][column].value), onCommit('end')
      else onCommit(event.key === 'Enter' ? 'end' : event.shiftKey ? 'previous' : 'next')
    }
  }}><div className="table-panel-heading"><strong>{row === 0 ? '表头' : `正文第 ${row} 行`} · 第 {column + 1} 列</strong><button onClick={onDismiss}>源码 / 关闭</button></div><label>单元格 Markdown<textarea ref={input} aria-label="单元格 Markdown" value={draft} onChange={event => onDraft(event.target.value)} onCompositionStart={() => { composing.current = true; onComposing(true) }} onCompositionEnd={() => { queueMicrotask(() => { composing.current = false; onComposing(false) }) }} /></label><p className="table-help">Enter 确认 · Esc 取消输入 · Tab / Shift+Tab 换格。未转义的 | 提交时转为 \|。</p><div className="table-cell-preview" aria-label="单元格预览" dangerouslySetInnerHTML={{ __html: rendered }} /><div className="table-operations"><button onClick={() => operation('rowAbove')}>上方插行</button><button onClick={() => operation('rowBelow')}>下方插行</button><button disabled={row === 0 || table.rows.length <= 2} title="保留表头和至少一行正文" onClick={() => operation('deleteRow')}>删除当前行</button><button onClick={() => operation('columnLeft')}>左侧插列</button><button onClick={() => operation('columnRight')}>右侧插列</button><button disabled={table.align.length <= 1} title="至少保留一列" onClick={() => operation('deleteColumn')}>删除当前列</button><label>列对齐 <select aria-label="列对齐" value={table.align[column] ?? 'default'} onChange={event => { if (!composing.current) onCommit('stay', 'align', event.target.value === 'default' ? null : event.target.value as Alignment) }}><option value="default">默认</option><option value="left">左</option><option value="center">中</option><option value="right">右</option></select></label></div><div className="table-cell-map" role="group" aria-label="选择单元格">{table.rows.map((cells, r) => <div key={r}>{cells.map((cell, c) => <button key={c} aria-label={`${r === 0 ? '表头' : `正文第 ${r} 行`} 第 ${c + 1} 列`} aria-pressed={r === row && c === column} onClick={() => { if (!composing.current) onNavigate(r, c) }}>{cell.value || '空'}</button>)}</div>)}</div>{error && <p role="alert">{error} 输入仍保留；可重试、复制或取消。</p>}<div className="panel-actions"><button onClick={() => { void navigator.clipboard.writeText(draft) }}>复制草稿</button><button onClick={() => { if (!composing.current) { onDraft(table.rows[row][column].value); onCommit('end') } }}>取消输入</button><button className="apply-button" onClick={() => { if (!composing.current) onCommit('end') }}>确认</button></div></section></OverlayPortal>
}
