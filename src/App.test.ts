// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { Blob as CloneableBlob } from 'node:buffer'
import { act, createElement, forwardRef, useImperativeHandle, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { applyPatches, type TextPatch } from './core/document'
import { blankSnapshot } from './core/codec'
import { defaultRecipe } from './core/images'
import { drafts } from './platform/drafts'

const native = vi.hoisted(() => ({ requestClose: vi.fn(), close: vi.fn(), save: vi.fn(), open: vi.fn(), reload: vi.fn(), workspace: vi.fn(), workspaceOpen: vi.fn(), search: vi.fn(), cancelSearch: vi.fn(), jump: vi.fn(), composing: false, minimize: vi.fn(), maximize: vi.fn(), drag: vi.fn(), fullscreen: vi.fn(), state: vi.fn(), stateListener: vi.fn() }))
vi.mock('./platform/workspace', async (original) => ({ ...await original<object>(), openWorkspace: native.workspace, openWorkspaceDocument: native.workspaceOpen, searchWorkspace: native.search, cancelWorkspaceSearch: native.cancelSearch }))
vi.mock('./platform/window', () => ({ listenForClose: async (request: () => void) => { native.requestClose.mockImplementation(request); return () => undefined }, closeWindow: native.close, minimizeWindow: native.minimize, toggleMaximizeWindow: native.maximize, dragWindow: native.drag, setFullscreen: native.fullscreen, windowState: native.state, listenWindowState: async (changed: () => void) => { native.stateListener.mockImplementation(changed); return () => undefined } }))
vi.mock('./platform/storage', () => ({ desktop: true, releaseDocument: vi.fn(), openDocument: native.open, reloadDocument: native.reload, saveDocument: native.save, materializeResources: async (_id: unknown, resources: unknown) => resources, readImage: vi.fn(), readImageBlob: vi.fn() }))
vi.mock('./editor/usePreview', () => ({ usePreview: (text: string) => ({ parsed: { html: '', headings: [], images: [] }, parsedText: { current: text } }) }))
vi.mock('./platform/images', async (original) => ({ ...await original<object>(), processImage: async () => ({ blob: new Blob(['display'], { type: 'image/png' }), width: 1, height: 1, mime: 'image/png' }) }))
vi.mock('./editor/Editor', () => ({ Editor: forwardRef(function MockEditor(props: { initialText: string; onChange(text: string): void; onSave(): void }, ref) {
  const [body, setBody] = useState(props.initialText)
  useImperativeHandle(ref, () => ({
    selection: () => ({ anchor: 0, head: 0 }), composing: () => native.composing,
    patch: (patches: TextPatch[]) => { const next = applyPatches(body, patches); setBody(next); props.onChange(next); return true },
    jump: native.jump, undo: () => undefined, redo: () => undefined,
  }))
  return createElement('textarea', { 'aria-label': 'Markdown 源码编辑器', value: body, onKeyDown: (event: { key: string; ctrlKey: boolean }) => { if (event.ctrlKey && event.key === 's') props.onSave() }, onChange: (event: { target: { value: string } }) => { setBody(event.target.value); props.onChange(event.target.value) } })
}) }))
import App from './App'

let root: Root
let container: HTMLDivElement
beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // fake-indexeddb uses Node structuredClone, which cannot clone happy-dom's Blob.
  vi.stubGlobal('Blob', CloneableBlob)
  native.requestClose.mockReset(); native.close.mockReset(); native.close.mockResolvedValue(undefined); native.save.mockReset(); native.open.mockReset(); native.reload.mockReset()
  native.workspace.mockReset(); native.workspaceOpen.mockReset()
  native.search.mockReset(); native.cancelSearch.mockReset(); native.cancelSearch.mockResolvedValue(undefined); native.jump.mockReset()
  native.minimize.mockReset(); native.minimize.mockResolvedValue(undefined); native.maximize.mockReset(); native.maximize.mockResolvedValue(undefined); native.drag.mockReset(); native.drag.mockResolvedValue(undefined); native.fullscreen.mockReset(); native.fullscreen.mockResolvedValue(undefined); native.state.mockReset(); native.state.mockResolvedValue({ maximized: false, fullscreen: false }); native.stateListener.mockReset()
  native.composing = false
  localStorage.clear()
  for (const key of await drafts.keys()) await drafts.clear(key)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); for (const key of await drafts.keys()) await drafts.clear(key); vi.unstubAllGlobals(); vi.restoreAllMocks() })
async function settle() { await act(async () => { await drafts.load(); await new Promise<void>((resolve) => setTimeout(resolve, 10)) }) }
async function mount() { await act(async () => root.render(createElement(App))); await settle() }
async function click(label: string) {
  if (['新建文档', '打开文件', '打开工作区', '另存为 / 冲突副本', '重新加载外部版本'].includes(label) && !container.querySelector('[role=menu]')) await click('EM 菜单')
  const button = Array.from(container.querySelectorAll('button')).filter((button) => !button.closest('[hidden]')).find((button) => button.textContent === label || button.getAttribute('aria-label') === label || button.querySelector('span:last-child')?.textContent === label)
  if (!button) throw new Error(`Missing button ${label}`)
  await act(async () => button.click())
  await settle()
}
async function edit(text: string) {
  const editor = container.querySelector('.document-panel:not([hidden]) textarea')!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => { setter.call(editor, text); editor.dispatchEvent(new Event('input', { bubbles: true })); editor.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function requestClose() { await act(async () => native.requestClose()) }

async function workspaceQuery(value: string) {
  const input = container.querySelector('.document-panel:not([hidden]) input[aria-label="搜索工作区"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const searchReport = (path: string, revision = 'hash') => ({ results: [{ path, line: 2, preview: '中文 needle', revision }], scanned: 1, skipped: 0, limited: false, cancelled: false })
async function searchResult() {
  const button = container.querySelector<HTMLButtonElement>('.document-panel:not([hidden]) .workspace-search-result')!
  await act(async () => button.click()); await settle()
}

it('cancels obsolete workspace searches and ignores late results and failures', async () => {
  native.workspace.mockResolvedValue({ id: 'workspace', name: 'notes', entries: [] })
  let resolveOld!: (value: unknown) => void
  native.search.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
  native.search.mockResolvedValueOnce(searchReport('new.md'))
  await mount(); await click('打开工作区'); await workspaceQuery('old'); await click('搜索')
  const requestId = native.search.mock.calls[0][2]
  await workspaceQuery('new')
  expect(native.cancelSearch).toHaveBeenCalledWith(requestId)
  await click('搜索')
  await act(async () => resolveOld(searchReport('old.md'))); await settle()
  const panel = container.querySelector('.document-panel:not([hidden])')!
  expect(panel.querySelector('.workspace-search-results')?.textContent).toContain('new.md')
  expect(panel.querySelector('.workspace-search-results')?.textContent).not.toContain('old.md')
  expect(native.save).not.toHaveBeenCalled()
})

it('opens search results at the source line, reuses tabs, and rejects stale disk and dirty local versions', async () => {
  native.workspace.mockResolvedValue({ id: 'workspace', name: 'notes', entries: [] })
  native.search.mockResolvedValue(searchReport('中文.md'))
  native.workspaceOpen.mockResolvedValue({ id: 'file', name: '中文.md', bytes: new TextEncoder().encode('# title\r\n中文 needle'), revision: 'hash' })
  await mount(); await click('打开工作区'); await workspaceQuery('needle'); await click('搜索')
  await searchResult()
  expect(native.jump).toHaveBeenCalledWith(8)
  expect(container.querySelectorAll('[role=tab]')).toHaveLength(2)
  await click('未命名.md'); native.jump.mockClear(); await searchResult()
  expect(native.jump).toHaveBeenCalledWith(8)
  expect(container.querySelectorAll('[role=tab]')).toHaveLength(2)
  await edit('unsaved local'); await click('未命名.md'); native.jump.mockClear(); await searchResult()
  expect(container.querySelector('.document-panel:not([hidden]) [role=alert]')?.textContent).toContain('本地编辑已变化')
  expect(native.jump).not.toHaveBeenCalled()
  await click('未命名.md')
  native.workspaceOpen.mockResolvedValue({ id: 'file', name: '中文.md', bytes: new TextEncoder().encode('changed'), revision: 'new' })
  await searchResult()
  expect(container.querySelector('.document-panel:not([hidden]) [role=alert]')?.textContent).toContain('文件已变化')
  expect(container.querySelector('.document-panel:not([hidden]) textarea')?.textContent).not.toContain('changed')
})

it('exposes workspace search limits and cancels a running search on demand', async () => {
  native.workspace.mockResolvedValue({ id: 'workspace', name: 'notes', entries: [] })
  native.search.mockResolvedValueOnce({ ...searchReport('note.md'), skipped: 2, limited: true })
  await mount(); await click('打开工作区'); await workspaceQuery('needle'); await click('搜索')
  expect(container.textContent).toContain('跳过 2 项')
  expect(container.textContent).toContain('结果不完整')
  let resolve!: (value: unknown) => void
  native.search.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await click('搜索'); await click('取消')
  expect(native.cancelSearch).toHaveBeenCalledWith(native.search.mock.calls[1][2])
  await act(async () => resolve(searchReport('cancelled.md'))); await settle()
  expect(container.textContent).not.toContain('cancelled.md')
})

it('closes an unchanged document and keeps an undisposed recovery draft', async () => {
  await mount(); await requestClose()
  expect(native.close).toHaveBeenCalledOnce()
  expect(native.save).not.toHaveBeenCalled()
})

it('cancel exit retains local text, and failed save does not close the window', async () => {
  await mount(); await edit('中文 local'); await requestClose()
  expect(container.textContent).toContain('关闭前保留修改')
  await click('返回编辑')
  expect(container.querySelector('textarea')?.value).toBe('中文 local')
  expect(native.close).not.toHaveBeenCalled()
  await requestClose()
  native.save.mockRejectedValue(new Error('disk full'))
  await click('保存并退出')
  expect(container.textContent).toContain('disk full')
  expect(native.close).not.toHaveBeenCalled()
})

it('retains a fresh body draft before closing, even before the debounce timer fires', async () => {
  await mount(); await edit('# 未保存'); await requestClose(); await click('保留草稿并退出')
  expect((await drafts.load())?.text).toBe('# 未保存')
  expect(native.close).toHaveBeenCalledOnce()
})

it('save dialog cancellation keeps the editor open; successful save clears the draft then closes', async () => {
  await mount(); await edit('body'); await requestClose()
  native.save.mockResolvedValueOnce(null)
  await click('保存并退出')
  expect(native.close).not.toHaveBeenCalled()
  native.save.mockResolvedValueOnce({ id: 'id', name: 'note.md', revision: 'hash', destination: 'disk' })
  await click('保存并退出')
  expect(native.close).toHaveBeenCalledOnce()
  expect(await drafts.load()).toBeUndefined()
})

it('restores pending crop and alt, then retains them when exiting without applying', async () => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  const recipe = { ...defaultRecipe(), rotateDegrees: 90 as const }
  await drafts.save({ version: 1, name: 'pending.md', text: '# body', snapshot: blankSnapshot(), updatedAt: 1,
    imageSession: { source: new Blob(['source'], { type: 'image/png' }), width: 10, height: 10, alt: '原 Alt', recipe, target: null, selection: { anchor: 0, head: 0 }, baseText: '# body', operationId: crypto.randomUUID(), displayToken: crypto.randomUUID(),
      instance: { instanceId: 'img-one', documentId: null, sourcePath: 'assets/.originals/img-one-source.png', sourceHash: 'hash', displayPath: '', recipe, referenceRevision: 0 } },
  })
  await mount(); await click('恢复草稿')
  const alt = container.querySelector<HTMLInputElement>('.alt-input')!
  expect(alt.value).toBe('原 Alt')
  await requestClose()
  const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存并退出')!
  expect(saveButton.disabled).toBe(true)
  await click('保留草稿并退出')
  const recovered = await drafts.load()
  expect(recovered?.imageSession?.recipe.rotateDegrees).toBe(90)
  expect(await recovered?.imageSession?.source.text()).toBe('source')
  expect(native.save).not.toHaveBeenCalled()
  expect(native.close).toHaveBeenCalledOnce()
})

it('opens workspace files in independent tabs and preserves edits when switching', async () => {
  native.workspace.mockResolvedValue({ id: 'workspace', name: 'notes', entries: [{ name: '文档.md', path: '文档.md', kind: 'document' }] })
  native.workspaceOpen.mockResolvedValue({ id: 'file', name: '文档.md', bytes: new TextEncoder().encode('# 磁盘正文'), revision: 'hash' })
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  await mount(); await edit('# 本地修改'); await click('打开工作区')
  expect(container.querySelector('textarea')?.value).toBe('# 本地修改')
  await click('文档.md')
  expect(container.querySelector('.document-panel:not([hidden]) .left-sidebar')).not.toBeNull()
  expect(native.workspaceOpen).toHaveBeenCalledWith('workspace', '文档.md')
  expect(container.querySelector('.document-panel:not([hidden]) textarea')?.getAttribute('aria-label')).toBe('Markdown 源码编辑器')
  expect((container.querySelector('.document-panel:not([hidden]) textarea') as HTMLTextAreaElement).value).toBe('# 磁盘正文')
  expect(confirm).not.toHaveBeenCalled()
  await click('未命名.md *')
  expect((container.querySelector('.document-panel:not([hidden]) textarea') as HTMLTextAreaElement).value).toBe('# 本地修改')
  await click('文档.md')
  expect(container.querySelectorAll('[role=tab]').length).toBe(2)
  expect(container.querySelector('.document-panel:not([hidden]) .left-sidebar')).not.toBeNull()
})

it('flushes the newest draft on loss of focus before the debounce fires', async () => {
  await mount(); await edit('# 失焦前的修改')
  await act(async () => window.dispatchEvent(new Event('blur')))
  await settle()
  expect((await drafts.load())?.text).toBe('# 失焦前的修改')
  expect(native.close).not.toHaveBeenCalled()
})

it('retains all dirty tabs on exit and recovers each independently on restart', async () => {
  await mount(); await edit('first edit'); await click('新建标签'); await edit('second edit')
  await requestClose(); await click('保留草稿并退出')
  const keys = await drafts.keys()
  expect(keys).toHaveLength(2)
  expect((await drafts.load())?.text).toBe('first edit')
  expect((await drafts.load(keys.find((key) => key !== 'current')!))?.text).toBe('second edit')
  await act(async () => root.unmount()); root = createRoot(container); await mount()
  expect(container.querySelectorAll('[role=tab]')).toHaveLength(2)
  await click('恢复草稿')
  expect((container.querySelector('.document-panel:not([hidden]) textarea') as HTMLTextAreaElement).value).toBe('first edit')
  const tabs = container.querySelectorAll<HTMLButtonElement>('[role=tab]')
  await act(async () => tabs[1].click()); await settle(); await click('恢复草稿')
  expect((container.querySelector('.document-panel:not([hidden]) textarea') as HTMLTextAreaElement).value).toBe('second edit')
})

it('closing one dirty tab saves only that tab and preserves the other draft', async () => {
  await mount(); await edit('first edit'); await act(async () => window.dispatchEvent(new Event('blur'))); await settle()
  await click('新建标签'); await edit('second edit')
  const close = container.querySelectorAll<HTMLButtonElement>('.tab-close')[1]
  await act(async () => close.click()); await settle()
  await click('返回编辑')
  expect(container.querySelectorAll('[role=tab]')).toHaveLength(2)
  await act(async () => close.click()); await settle()
  native.save.mockResolvedValue({ id: 'second', name: 'second.md', revision: 'hash', destination: 'disk' })
  await click('保存并关闭')
  expect(native.save).toHaveBeenCalledOnce()
  expect(new TextDecoder().decode(native.save.mock.calls[0][1])).toBe('second edit')
  expect(container.querySelectorAll('[role=tab]')).toHaveLength(1)
  expect((await drafts.load())?.text).toBe('first edit')
  expect(await drafts.keys()).toEqual(['current'])
})

it('aborts save-all on cancellation and leaves every document open', async () => {
  await mount(); await edit('first'); await click('新建标签'); await edit('second')
  native.save.mockResolvedValueOnce({ id: 'first', name: 'first.md', revision: 'hash', destination: 'disk' }).mockResolvedValueOnce(null)
  await requestClose(); await click('保存并退出')
  expect(native.close).not.toHaveBeenCalled()
  expect(container.querySelectorAll('[role=tab]')).toHaveLength(2)
  await click('返回编辑')
  expect((container.querySelector('.document-panel:not([hidden]) textarea') as HTMLTextAreaElement).value).toBe('second')
})

it('retains incompatible drafts while allowing other tabs to be edited and closed', async () => {
  const key = 'document:future'
  const future = { version: 2, name: 'future.md', text: 'future data', snapshot: blankSnapshot(), updatedAt: 1 }
  await drafts.save(future as unknown as Parameters<typeof drafts.save>[0], key)
  await mount()
  const tabs = container.querySelectorAll<HTMLButtonElement>('[role=tab]')
  await act(async () => tabs[1].click()); await settle()
  expect(container.textContent).toContain('草稿格式不兼容，已保留原数据。')
  expect((container.querySelector('.document-panel:not([hidden]) .content-grid') as HTMLElement).inert).toBe(true)
  await act(async () => tabs[0].click()); await settle(); await edit('safe edit')
  await requestClose(); await click('保留草稿并退出')
  expect(native.close).toHaveBeenCalledOnce()
  expect((await drafts.load())?.text).toBe('safe edit')
  await expect(drafts.load(key)).rejects.toThrow('草稿格式不兼容')
  expect(await drafts.keys()).toContain(key)
})

it('discards only the closed tab and does not recreate its draft on blur', async () => {
  await mount(); await edit('first edit'); await act(async () => window.dispatchEvent(new Event('blur'))); await settle()
  await click('新建文档'); await edit('discard this')
  await act(async () => window.dispatchEvent(new Event('blur'))); await settle()
  expect(await drafts.keys()).toHaveLength(2)
  await act(async () => container.querySelectorAll<HTMLButtonElement>('.tab-close')[1].click()); await settle()
  await click('不保存关闭')
  await act(async () => window.dispatchEvent(new Event('blur'))); await settle()
  expect(await drafts.keys()).toEqual(['current'])
  expect((await drafts.load())?.text).toBe('first edit')
  expect(container.querySelectorAll('[role=tab]')).toHaveLength(1)
  expect(native.save).not.toHaveBeenCalled()
})

it('discards every open draft on exit without saving', async () => {
  await mount(); await edit('first'); await click('新建文档'); await edit('second')
  await act(async () => window.dispatchEvent(new Event('blur'))); await settle()
  await requestClose(); await click('不保存退出')
  await act(async () => window.dispatchEvent(new Event('blur'))); await settle()
  expect(await drafts.keys()).toEqual([])
  expect(native.save).not.toHaveBeenCalled()
  expect(native.close).toHaveBeenCalledOnce()
})

it('resumes draft protection if discarding fails to close the window', async () => {
  await mount(); await edit('keep after failure')
  native.close.mockRejectedValue(new Error('close failed'))
  await requestClose(); await click('不保存退出')
  expect(container.textContent).toContain('close failed')
  await click('返回编辑')
  await act(async () => window.dispatchEvent(new Event('blur'))); await settle()
  expect((await drafts.load())?.text).toBe('keep after failure')
})

it('shows file commands only in the EM menu and dismisses it on Escape', async () => {
  await mount()
  expect(container.querySelector('[role=menu]')).toBeNull()
  await click('EM 菜单')
  expect(container.querySelectorAll('[role=menuitem]')).toHaveLength(7)
  const trigger = container.querySelector<HTMLButtonElement>('.app-menu-trigger')!
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(container.querySelector('[role=menu]')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

it('creates a template in a new tab without replacing the current document', async () => {
  await mount(); await edit('current document')
  await click('EM 菜单'); await click('从模板新建')
  expect(container.querySelector('[role=dialog]')).not.toBeNull()
  const templateSelect = container.querySelector<HTMLSelectElement>('.template-dialog select')!
  await act(async () => { templateSelect.value = 'meeting'; templateSelect.dispatchEvent(new Event('change', { bubbles: true })) }); await settle()
  const title = container.querySelector<HTMLInputElement>('.template-dialog input')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title, '季度评审'); title.dispatchEvent(new Event('input', { bubbles: true })) })
  await click('创建文档')
  expect(container.querySelectorAll('[role=tab]')).toHaveLength(2)
  expect((container.querySelector('.document-panel:not([hidden]) textarea') as HTMLTextAreaElement).value).toContain('# 季度评审')
  await click('未命名.md *')
  expect((container.querySelector('.document-panel:not([hidden]) textarea') as HTMLTextAreaElement).value).toBe('current document')
})

it('keeps a non-empty template as a recoverable draft and closes blank templates cleanly', async () => {
  await mount(); await click('EM 菜单'); await click('从模板新建')
  const templateSelect = container.querySelector<HTMLSelectElement>('.template-dialog select')!
  await act(async () => { templateSelect.value = 'project'; templateSelect.dispatchEvent(new Event('change', { bubbles: true })) }); await settle(); await click('创建文档')
  await act(async () => window.dispatchEvent(new Event('blur'))); await settle()
  expect(await drafts.keys()).toHaveLength(1)
  await requestClose(); expect(container.querySelector('.close-dialog')).not.toBeNull()
  await click('保留草稿并退出'); expect(native.close).toHaveBeenCalledOnce()
  await act(async () => root.unmount()); root = createRoot(container); await mount()
  expect(container.querySelectorAll('[role=tab]')).toHaveLength(2)
  await act(async () => container.querySelectorAll<HTMLButtonElement>('[role=tab]')[1].click()); await settle()
  await click('恢复草稿')
  expect((container.querySelector('.document-panel:not([hidden]) textarea') as HTMLTextAreaElement).value).toContain('# 项目说明')
  await click('EM 菜单'); await click('从模板新建'); await click('创建文档')
  await act(async () => container.querySelectorAll<HTMLButtonElement>('.tab-close')[2].click()); await settle()
  expect(container.querySelector('.close-dialog')).toBeNull()
  expect(container.querySelectorAll('[role=tab]')).toHaveLength(2)
  expect(native.save).not.toHaveBeenCalled()
})

it('first saves a template with no disk identity and clears its draft', async () => {
  await mount(); await click('EM 菜单'); await click('从模板新建')
  const select = container.querySelector<HTMLSelectElement>('.template-dialog select')!
  await act(async () => { select.value = 'meeting'; select.dispatchEvent(new Event('change', { bubbles: true })) }); await settle(); await click('创建文档')
  await act(async () => window.dispatchEvent(new Event('blur'))); await settle()
  native.save.mockResolvedValue({ id: 'created', name: '会议纪要.md', revision: 'hash', destination: 'disk' })
  await click('另存为 / 冲突副本')
  expect(native.save.mock.calls[0][0]).toEqual({ id: null, name: '会议纪要.md', revision: null })
  expect(new TextDecoder().decode(native.save.mock.calls[0][1])).toContain('# 会议纪要')
  expect(native.save.mock.calls[0][2]).toBe(true)
  expect(await drafts.keys()).toEqual([])
})

it('cancels the template dialog on Escape and returns focus to EM without adding tabs', async () => {
  await mount(); await click('EM 菜单'); await click('从模板新建')
  const select = container.querySelector<HTMLSelectElement>('.template-dialog select')!
  expect(document.activeElement).toBe(select)
  await act(async () => select.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); await settle()
  expect(container.querySelector('.template-dialog')).toBeNull()
  expect(document.activeElement).toBe(container.querySelector('.app-menu-trigger'))
  expect(container.querySelectorAll('[role=tab]')).toHaveLength(1)
  expect(await drafts.keys()).toEqual([])
})
async function waitAuto(ms = 1300) { await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, ms)) }); await settle() }
async function openLocal(bytes = new TextEncoder().encode('disk')) {
  native.open.mockResolvedValue({ id: 'local', name: 'local.md', bytes, revision: 'r0' })
  await mount(); await click('打开文件')
}

it('toggles formatting globally and persists the preference without a save header', async () => {
  await mount()
  expect(container.querySelector('.document-status')).toBeNull()
  await click('隐藏格式工具栏'); expect(container.querySelector('[role=toolbar]')).toBeNull()
  await click('新建文档'); expect(container.querySelector('[role=toolbar]')).toBeNull()
  await act(async () => root.unmount()); root = createRoot(container); await mount()
  expect(container.querySelector('[role=toolbar]')).toBeNull()
  await click('显示格式工具栏'); expect(container.querySelector('[role=toolbar]')).not.toBeNull()
})

it('automatically writes a known file after idle and clears its draft', async () => {
  await openLocal()
  native.save.mockResolvedValue({ id: 'local', name: 'local.md', revision: 'r1', destination: 'disk' })
  await edit('latest'); expect(native.save).not.toHaveBeenCalled()
  await waitAuto()
  expect(native.save).toHaveBeenCalledOnce()
  expect(native.save.mock.calls[0][0]).toMatchObject({ id: 'local', revision: 'r0' })
  expect(new TextDecoder().decode(native.save.mock.calls[0][1])).toBe('latest')
  expect(native.save.mock.calls[0][2]).toBe(false)
  expect(container.textContent).toContain('已自动保存')
  expect(await drafts.keys()).toEqual([])
})

it('keeps unnamed and recovered documents as drafts without showing save dialogs', async () => {
  await mount(); await edit('new body'); await waitAuto()
  expect((await drafts.load())?.text).toBe('new body')
  expect(native.save).not.toHaveBeenCalled()
  await act(async () => root.unmount()); root = createRoot(container); await mount(); await click('恢复草稿'); await waitAuto()
  expect(native.save).not.toHaveBeenCalled()
  expect((await drafts.load())?.text).toBe('new body')
})

it('serializes automatic writes and preserves edits made while a save is in flight', async () => {
  await openLocal()
  let finish!: (result: unknown) => void
  native.save.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve })).mockResolvedValue({ id: 'local', name: 'local.md', revision: 'r2', destination: 'disk' })
  await edit('first'); await waitAuto()
  await edit('second'); await act(async () => window.dispatchEvent(new Event('blur'))); await settle()
  expect(new TextDecoder().decode(native.save.mock.calls[0][1])).toBe('first')
  await act(async () => finish({ id: 'local', name: 'local.md', revision: 'r1', destination: 'disk' })); await settle()
  const key = (await drafts.keys())[0]
  expect((await drafts.load(key))?.text).toBe('second')
  await waitAuto()
  expect(native.save).toHaveBeenCalledTimes(2)
  expect(native.save.mock.calls[1][0]).toMatchObject({ revision: 'r1' })
  expect(new TextDecoder().decode(native.save.mock.calls[1][1])).toBe('second')
  expect(await drafts.keys()).toEqual([])
})

it('pauses autosave after an external conflict and allows a manual retry', async () => {
  await openLocal(); native.save.mockRejectedValueOnce(new Error('revision_conflict'))
  await edit('keep'); await waitAuto(); await edit('keep newer'); await waitAuto()
  expect(native.save).toHaveBeenCalledOnce()
  expect(container.textContent).toContain('文件已被外部修改')
  expect((await drafts.load((await drafts.keys())[0]))?.text).toBe('keep newer')
  native.save.mockResolvedValue({ id: 'local', name: 'local.md', revision: 'r1', destination: 'disk' })
  await act(async () => container.querySelector('.document-panel:not([hidden]) textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))); await settle()
  expect(native.save).toHaveBeenCalledTimes(2)
  expect(await drafts.keys()).toEqual([])
})

it('suspends autosave during close decisions and discards without writing', async () => {
  await openLocal(); await edit('discard'); await requestClose(); await waitAuto()
  expect(native.save).not.toHaveBeenCalled()
  await click('不保存退出'); await waitAuto()
  expect(native.save).not.toHaveBeenCalled()
  expect(await drafts.keys()).toEqual([])
})

it('pauses mixed-line-ending autosave without a confirmation prompt', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
  await openLocal(new TextEncoder().encode('one\r\ntwo\n')); await edit('changed\nbody'); await waitAuto()
  expect(native.save).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled()
  expect(container.textContent).toContain('自动保存已暂停')
  expect((await drafts.load((await drafts.keys())[0]))?.text).toBe('changed\nbody')
})

it('waits until IME composition ends before automatically saving', async () => {
  await openLocal(); native.save.mockResolvedValue({ id: 'local', name: 'local.md', revision: 'r1', destination: 'disk' })
  await edit('中文'); native.composing = true; await waitAuto()
  expect(native.save).not.toHaveBeenCalled()
  native.composing = false; await waitAuto(350)
  expect(native.save).toHaveBeenCalledOnce()
})

it('preserves a new edit arriving during asynchronous draft cleanup after saving', async () => {
  await openLocal()
  native.save.mockResolvedValue({ id: 'local', name: 'local.md', revision: 'r1', destination: 'disk' })
  const originalClear = drafts.clear.bind(drafts)
  let finishClear!: () => void
  vi.spyOn(drafts, 'clear').mockImplementationOnce(async (key) => {
    await new Promise<void>((resolve) => { finishClear = resolve })
    await originalClear(key)
  })
  await edit('saved'); await waitAuto()
  expect(finishClear).toBeTypeOf('function')
  await edit('new during cleanup')
  await act(async () => finishClear()); await settle()
  await act(async () => window.dispatchEvent(new Event('blur'))); await settle()
  expect((await drafts.load((await drafts.keys())[0]))?.text).toBe('new during cleanup')
  expect(container.querySelector('[role=tab][aria-selected=true]')?.textContent).toContain('*')
})

it('does not recreate a clean draft while saved-draft cleanup is slow', async () => {
  await openLocal()
  native.save.mockResolvedValue({ id: 'local', name: 'local.md', revision: 'r1', destination: 'disk' })
  const originalClear = drafts.clear.bind(drafts)
  let finishClear!: () => void
  vi.spyOn(drafts, 'clear').mockImplementationOnce(async (key) => {
    await new Promise<void>((resolve) => { finishClear = resolve })
    await originalClear(key)
  })
  await edit('clean'); await waitAuto(); await waitAuto(800)
  await act(async () => window.dispatchEvent(new Event('blur')))
  await act(async () => finishClear()); await settle()
  expect(await drafts.keys()).toEqual([])
  expect(container.querySelector('[role=tab][aria-selected=true]')?.textContent).not.toContain('*')
})

it('uses themed custom window controls and protects dirty content on window close', async () => {
  await mount(); await click('最小化窗口'); await click('最大化窗口')
  expect(native.minimize).toHaveBeenCalledOnce(); expect(native.maximize).toHaveBeenCalledOnce()
  expect(container.querySelector('.theme-picker')).toBeNull()
  await click('EM 菜单')
  await click('Style · 配色主题')
  const dark = container.querySelector<HTMLButtonElement>('[role=menuitemradio]:nth-last-child(3)')!
  await act(async () => dark.click()); await settle()
  expect(container.querySelector('.application')?.getAttribute('data-theme')).toBe('dark')
  expect(localStorage.getItem('easym-theme')).toBe('dark')
  await edit('keep'); await click('关闭窗口')
  expect(container.querySelector('.close-dialog')).not.toBeNull()
  expect(native.close).not.toHaveBeenCalled()
})

it('enters fullscreen preview reading and restores editing on Escape and the exit button', async () => {
  await mount(); await edit('中文 😀\nsecond line'); await waitAuto(300); await click('分屏'); await click('阅读模式')
  expect(native.fullscreen).toHaveBeenLastCalledWith(true)
  expect((container.querySelector('.document-strip') as HTMLElement).hidden).toBe(true)
  expect(container.querySelector('.document-panel:not([hidden]) .source-pane')?.hasAttribute('hidden')).toBe(true)
  expect(container.querySelector('.document-panel:not([hidden]) .preview')).not.toBeNull()
  expect(container.querySelector('.document-panel:not([hidden]) [role=toolbar]')).toBeNull()
  expect(Array.from(container.querySelectorAll('.document-panel:not([hidden]) .view-switcher button')).map((button) => button.textContent)).toEqual(['文件树', '大纲', '退出阅读模式'])
  expect(container.querySelector('.document-panel:not([hidden]) .statusbar')?.textContent).toContain('2 行 · 13 字')
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))); await settle()
  expect(native.fullscreen).toHaveBeenLastCalledWith(false)
  expect((container.querySelector('.document-strip') as HTMLElement).hidden).toBe(false)
  expect(container.querySelector('.content-grid.view-split')).not.toBeNull()
  expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('中文 😀\nsecond line')
  await click('阅读模式'); await click('退出阅读模式')
  expect(native.fullscreen).toHaveBeenLastCalledWith(false)
})

it('keeps editing available if fullscreen entry fails', async () => {
  await mount(); native.fullscreen.mockRejectedValueOnce(new Error('fullscreen unavailable')); await click('阅读模式')
  expect((container.querySelector('.document-strip') as HTMLElement).hidden).toBe(false)
  expect(container.textContent).toContain('fullscreen unavailable')
})

it('follows native maximize and external fullscreen exit state', async () => {
  await mount(); native.state.mockResolvedValue({ maximized: true, fullscreen: false })
  await act(async () => native.stateListener()); await settle()
  expect(container.querySelector('[aria-label="还原窗口"]')).not.toBeNull()
  await click('阅读模式')
  await act(async () => native.stateListener()); await settle()
  expect((container.querySelector('.document-strip') as HTMLElement).hidden).toBe(false)
})

it('closes untouched new tabs directly without creating drafts or changing other edits', async () => {
  await mount(); await edit('existing edit'); await click('新建文档'); await waitAuto(800)
  expect(container.querySelector('[role=tab][aria-selected=true]')?.textContent).toBe('未命名.md')
  const cleanKey = (await drafts.keys()).filter((key) => key !== 'current')
  expect(cleanKey).toEqual([])
  await act(async () => container.querySelector('.document-tab.active .tab-close')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))); await settle()
  expect(container.querySelector('.close-dialog')).toBeNull()
  expect(container.querySelectorAll('[role=tab]')).toHaveLength(1)
  expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('existing edit')
  expect(native.save).not.toHaveBeenCalled()
})

it('exits with only untouched new documents without prompting or saving', async () => {
  await mount(); await click('新建标签'); await click('新建标签'); await requestClose()
  expect(container.querySelector('.close-dialog')).toBeNull()
  expect(native.close).toHaveBeenCalledOnce()
  expect(native.save).not.toHaveBeenCalled(); expect(await drafts.keys()).toEqual([])
})

it('opens the Style submenu explicitly and handles hierarchical keyboard navigation', async () => {
  await mount(); await click('EM 菜单')
  expect(container.querySelector('#style-menu')).toBeNull()
  await click('Style · 配色主题')
  const trigger = container.querySelector<HTMLButtonElement>('.style-menu-trigger')!
  const selected = container.querySelector<HTMLButtonElement>('[role=menuitemradio][aria-checked=true]')!
  expect(document.activeElement).toBe(selected)
  await act(async () => selected.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  expect(document.activeElement?.textContent).toContain('午夜深色')
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(container.querySelector('#style-menu')).toBeNull(); expect(container.querySelector('#file-menu')).not.toBeNull(); expect(document.activeElement).toBe(trigger)
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  expect(container.querySelector('#style-menu')).not.toBeNull()
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
  expect(document.activeElement).toBe(trigger)
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(container.querySelector('#file-menu')).toBeNull()
})
