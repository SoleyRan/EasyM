import { useEffect, useRef, useState, type ReactNode, type KeyboardEventHandler } from 'react'
import { appVersion, historyDirectory, themes, type Theme, type HistoryDirectory } from '../platform/preferences'
import { desktop } from '../platform/storage'
import { historyError } from '../platform/history'

function ApplicationDialog({ title, onClose, busy = false, children, onKeyDown }: { title: string; onClose(): void; busy?: boolean; children: ReactNode; onKeyDown?: KeyboardEventHandler<HTMLDivElement> }) {
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => { dialog.current?.focus() }, [])
  return <div className="modal-backdrop application-backdrop" onKeyDown={event => {
    onKeyDown?.(event)
    if (event.defaultPrevented) return
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); if (!busy) onClose() }
    if (event.key !== 'Tab') return
    const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]') ?? [])
    event.preventDefault()
    if (!controls.length) { dialog.current?.focus(); return }
    const index = controls.indexOf(document.activeElement as HTMLElement)
    controls[index < 0 ? (event.shiftKey ? controls.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus()
  }}>
    <div className="application-dialog" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} aria-busy={busy}>
      <div className="panel-title"><h2>{title}</h2><button disabled={busy} onClick={onClose} aria-label={`关闭${title}`}>×</button></div>
      {children}
    </div>
  </div>
}

export function SettingsDialog({ fileId, theme, onTheme, toolbar, onToolbar, fontSize, onFontSize, onGuide, onClose }: {
  fileId: string | null | undefined; theme: Theme; onTheme(value: Theme): void; toolbar: boolean; onToolbar(value: boolean): void;
  fontSize: number; onFontSize(value: number): void; onGuide(): void; onClose(): void
}) {
  const [directory, setDirectory] = useState<HistoryDirectory | null>(null)
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(!!fileId && desktop)
  const [error, setError] = useState(''), [message, setMessage] = useState('')
  useEffect(() => {
    if (!desktop || !fileId) return
    let alive = true
    historyDirectory(fileId, 'status').then(value => { if (alive) setDirectory(value) }).catch(e => { if (alive) setError(historyError(e)) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [fileId])
  async function change(action: 'choose' | 'reset') {
    if (!fileId || busy) return
    setBusy(true); setError(''); setMessage('')
    try {
      const value = await historyDirectory(fileId, action)
      if (value) { setDirectory(value); setMessage(`历史保存位置已更新。${value.retainedPath ? `原历史副本保留在 ${value.retainedPath}。` : ''}${value.backupPath ? `原默认目录副本保留在 ${value.backupPath}。` : ''}`) }
      else setMessage('已取消选择，历史位置未改变。')
    } catch (e) { setError(historyError(e)) }
    finally { setBusy(false) }
  }
  return <ApplicationDialog title="设置" onClose={onClose} busy={busy}>
    <section><h3>外观与编辑</h3>
      <label className="setting-row">配色主题<select aria-label="设置配色主题" value={theme} onChange={e => onTheme(e.target.value as Theme)}>{Object.entries(themes).map(([key, name]) => <option value={key} key={key}>{name}</option>)}</select></label>
      <label className="setting-row"><span>显示格式工具栏</span><input type="checkbox" checked={toolbar} onChange={e => onToolbar(e.target.checked)} /></label>
      <label className="setting-row">编辑字号<select aria-label="编辑字号" value={fontSize} onChange={e => onFontSize(Number(e.target.value))}>{[12, 14, 16, 18, 20, 22, 24].map(size => <option value={size} key={size}>{size} px</option>)}</select></label>
      <p>设置即时生效，并保存在本机。已保存文件停止输入后自动保存；新文档先保留本机草稿，首次请另存为。</p>
    </section>
    <section><h3>版本历史保存位置</h3>
      {!desktop ? <p>历史保存位置仅在桌面版中可设置。</p> : !fileId ? <p>请先打开或另存一个文档，再设置其历史保存位置。</p> : <>
        {loading && <p role="status">正在读取历史位置…</p>}
        {directory && <><p>适用于此目录中的文档：<code>{directory.documentDirectory}</code></p><p>当前位置（{directory.custom ? '自定义' : '默认'}）：<code>{directory.path}</code></p></>}
        <p>默认保存在文档目录的 .easym/history/。选择新位置时，会复制并校验该文档目录的全部历史，保留原副本；其他文档目录不受影响。此设置不会自动启用版本历史。</p>
        <div className="panel-actions"><button disabled={busy || loading || !directory} onClick={() => void change('choose')}>选择历史目录…</button><button disabled={busy || loading || !directory?.custom} onClick={() => void change('reset')}>恢复默认目录</button></div>
        <p>移动文档目录或跨设备使用时，请同时保留 .easym 中的位置配置，并确保自定义历史目录仍可访问。版本历史不能代替备份。</p>
      </>}
    </section>
    {error && <p className="image-error" role="alert">{error}</p>}
    <p role="status">{busy ? '正在复制并校验历史，请稍候…' : message}</p>
    <div className="panel-actions"><button disabled={busy} onClick={onGuide}>查看使用导引</button><button disabled={busy} className="apply-button" onClick={onClose}>完成</button></div>
  </ApplicationDialog>
}

export function GuideDialog({ previousVersion, onClose }: { previousVersion: string | null; onClose(): void }) {
  const [page, setPage] = useState(0)
  const pages = [
    <section className="guide-page" key="writing"><h3>开始写作</h3><p>点击 EM 菜单新建、从模板新建、打开文件或工作区。多个文件可以同时打开，右键标签可关闭当前、其他或全部文件。</p><p>配色、编辑字号和格式工具栏显示可在 EM → 设置中调整。</p></section>,
    <section className="guide-page" key="editing"><h3>编辑与自动保存</h3><p>使用源码、分屏或即时渲染模式写作。选中文字后点击格式按钮可应用或取消格式。</p><p>已保存文件会自动保存；新文档先保留草稿，需要首次另存为。</p></section>,
    <section className="guide-page" key="history"><h3>版本历史 · 找回以前的内容</h3><p>桌面版打开已保存文档后，在 EM → 版本历史中显式启用。之后可自动或手动记录正文与本地图片快照、查看差异、命名或固定版本，并恢复或另存旧版本。</p><p>默认历史位于文档目录的 .easym/history/，可在 EM → 设置中更改。历史保存在本地，不能代替备份。</p></section>,
    <section className="guide-page" key="reading"><h3>图片、导出与阅读</h3><p>粘贴或拖入 PNG/JPEG，双击预览图片可编辑副本。已启用历史的文档可批量缩小或转换图片。</p><p>EM → 导出提供 HTML、DOCX 和 PDF；PDF 通过系统打印窗口另存。阅读模式隐藏编辑区，按 Esc 退出。</p></section>,
  ]
  return <ApplicationDialog title="EasyM 使用导引" onClose={onClose} onKeyDown={event => {
      if (event.nativeEvent.isComposing || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
      event.preventDefault(); event.stopPropagation()
      setPage(current => Math.max(0, Math.min(pages.length - 1, current + (event.key === 'ArrowRight' ? 1 : -1))))
    }}>
    <p className="guide-intro">{previousVersion && previousVersion !== appVersion ? `已更新到 EasyM ${appVersion}` : `欢迎使用 EasyM ${appVersion}`} · 本地优先的 Markdown 编辑器</p>
    <div aria-live="polite" aria-atomic="true">{pages[page]}</div>
    <div className="guide-navigation">
      <button disabled={page === 0} aria-label="上一页" title="上一页" onClick={() => setPage(page - 1)}>←</button>
      <span className="guide-progress" role="status">{page + 1} / {pages.length}</span>
      <button className="apply-button" aria-label={page === pages.length - 1 ? '开始使用' : '下一页'} title={page === pages.length - 1 ? '开始使用' : '下一页'} onClick={() => page === pages.length - 1 ? onClose() : setPage(page + 1)}>{page === pages.length - 1 ? '开始使用' : '→'}</button>
    </div>
  </ApplicationDialog>
}
