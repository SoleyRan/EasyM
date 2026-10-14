// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { Blob as CloneableBlob } from 'node:buffer'
import { act, createElement, forwardRef, useImperativeHandle, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { applyPatches, type TextPatch } from './core/document'
import { validateCommandEdit, type CommandContext } from './core/commands'
import type { EditCommandResult } from './core/document'
import { blankSnapshot } from './core/codec'
import { defaultRecipe } from './core/images'
import { drafts } from './platform/drafts'
import { SESSION_KEY, saveSession } from './platform/session'
import type { RecentState } from './platform/recent'

const recentApi = vi.hoisted(() => ({ state: vi.fn(), remember: vi.fn(), forget: vi.fn(), file: vi.fn(), workspace: vi.fn() }))
vi.mock('./platform/recent', async original => ({ ...await original<object>(), recentState: recentApi.state, rememberSession: recentApi.remember, forgetRecent: recentApi.forget, reopenRecentFile: recentApi.file, reopenRecentWorkspace: recentApi.workspace }))

const native = vi.hoisted(() => ({ exportHtml: vi.fn(), print: vi.fn(), requestClose: vi.fn(), close: vi.fn(), save: vi.fn(), open: vi.fn(), reload: vi.fn(), workspace: vi.fn(), workspaceOpen: vi.fn(), search: vi.fn(), cancelSearch: vi.fn(), jump: vi.fn(), composing: false, minimize: vi.fn(), maximize: vi.fn(), drag: vi.fn(), fullscreen: vi.fn(), state: vi.fn(), stateListener: vi.fn() }))
const docxApi = vi.hoisted(() => ({ preflight: vi.fn(), render: vi.fn(), save: vi.fn() }))
vi.mock('./platform/docx', () => ({ preflightDocx: docxApi.preflight, renderDocx: docxApi.render, saveDocx: docxApi.save }))
vi.mock('./platform/export', async () => ({ parseForExport: async (text: string) => (await import('./core/markdown')).parseDocument(text), saveHtml: native.exportHtml, printDocument: native.print }))
vi.mock('./platform/workspace', async (original) => ({ ...await original<object>(), openWorkspace: native.workspace, openWorkspaceDocument: native.workspaceOpen, searchWorkspace: native.search, cancelWorkspaceSearch: native.cancelSearch }))
vi.mock('./platform/window', () => ({ listenForFocus: async () => () => undefined, listenForClose: async (request: () => void) => { native.requestClose.mockImplementation(request); return () => undefined }, closeWindow: native.close, minimizeWindow: native.minimize, toggleMaximizeWindow: native.maximize, dragWindow: native.drag, setFullscreen: native.fullscreen, windowState: native.state, listenWindowState: async (changed: () => void) => { native.stateListener.mockImplementation(changed); return () => undefined } }))
vi.mock('./platform/storage', () => ({ desktop: true, inspectDocument: async (_id: string, revision: string) => ({ revision, bytes: null }), releaseDocument: vi.fn(), openDocument: native.open, reloadDocument: native.reload, saveDocument: native.save, materializeResources: async (_id: unknown, resources: unknown) => resources, readImage: vi.fn(), readImageBlob: vi.fn() }))
vi.mock('./editor/usePreview', () => ({ usePreview: (text: string) => ({ parsed: { html: '', headings: [], images: [] }, parsedText: { current: text } }) }))
vi.mock('./platform/images', async (original) => ({ ...await original<object>(), processImage: async () => ({ blob: new Blob(['display'], { type: 'image/png' }), width: 1, height: 1, mime: 'image/png' }) }))
vi.mock('./editor/Editor', () => ({ Editor: forwardRef(function MockEditor(props: { initialText: string; onChange(text: string): void; onSave(): void; onCommand(id: string): void; commandContext(): CommandContext }, ref) {
  const [body, setBody] = useState(props.initialText)
  useImperativeHandle(ref, () => ({
    selection: () => ({ anchor: 0, head: 0 }), composing: () => native.composing,
    contentStatus: () => ({ enabled: true }),
    patch: (patches: TextPatch[]) => { const next = applyPatches(body, patches); setBody(next); props.onChange(next); return true },
    applyCommand: (result: EditCommandResult, context: CommandContext) => {
      try { if (!validateCommandEdit(body, result, context, props.commandContext())) return true; const next = applyPatches(body, result.patches); setBody(next); props.onChange(next); return true } catch { return false }
    },
    focus: () => undefined, jump: native.jump, undo: () => undefined, redo: () => undefined,
  }))
  return createElement('textarea', { 'aria-label': 'Markdown 源码编辑器', value: body, onKeyDown: (event: { key: string; ctrlKey: boolean }) => { if (event.ctrlKey && event.key === 's') props.onSave(); if (event.ctrlKey && event.key === 'p') props.onCommand('file.print') }, onChange: (event: { target: { value: string } }) => { setBody(event.target.value); props.onChange(event.target.value) } })
}) }))
import App from './App'
import { appVersion } from './platform/preferences'

let root: Root
let container: HTMLDivElement
beforeEach(async () => {
  recentApi.state.mockReset(); recentApi.state.mockResolvedValue({ entries: [], session: { tabs: [], activeDraftKey: null, workspaceId: null } }); recentApi.remember.mockReset(); recentApi.remember.mockResolvedValue(undefined); recentApi.forget.mockReset(); recentApi.forget.mockResolvedValue(undefined); recentApi.file.mockReset(); recentApi.workspace.mockReset()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // fake-indexeddb uses Node structuredClone, which cannot clone happy-dom's Blob.
  vi.stubGlobal('Blob', CloneableBlob)
  native.requestClose.mockReset(); native.close.mockReset(); native.close.mockResolvedValue(undefined); native.save.mockReset(); native.open.mockReset(); native.reload.mockReset()
  native.workspace.mockReset(); native.workspaceOpen.mockReset()
  native.search.mockReset(); native.cancelSearch.mockReset(); native.cancelSearch.mockResolvedValue(undefined); native.jump.mockReset()
  native.minimize.mockReset(); native.minimize.mockResolvedValue(undefined); native.maximize.mockReset(); native.maximize.mockResolvedValue(undefined); native.drag.mockReset(); native.drag.mockResolvedValue(undefined); native.fullscreen.mockReset(); native.fullscreen.mockResolvedValue(undefined); native.state.mockReset(); native.state.mockResolvedValue({ maximized: false, fullscreen: false }); native.stateListener.mockReset()
  native.composing = false
  native.exportHtml.mockReset(); native.exportHtml.mockResolvedValue(true); native.print.mockReset(); native.print.mockResolvedValue(undefined)
  docxApi.preflight.mockReset(); docxApi.preflight.mockImplementation(async ({ text, name }) => ({ model: (await import('./core/docx-model')).createDocxModel(text, name), assets: [] }))
  docxApi.render.mockReset(); docxApi.render.mockResolvedValue(new ArrayBuffer(8)); docxApi.save.mockReset(); docxApi.save.mockResolvedValue(true)
  localStorage.clear()
  localStorage.setItem('easym-guide-version', appVersion)
  for (const key of await drafts.keys()) await drafts.clear(key)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); for (const key of await drafts.keys()) await drafts.clear(key); vi.unstubAllGlobals(); vi.restoreAllMocks() })
async function settle() { await act(async () => { await drafts.load(); await new Promise<void>((resolve) => setTimeout(resolve, 10)) }) }
async function mount() { await act(async () => root.render(createElement(App))); await settle(); await settle() }
async function click(label: string) {
  if (['新建文档', '打开文件', '打开工作区', '另存为 / 冲突副本', '重新加载外部版本', '导出 HTML', '导出 DOCX', '打印文档'].includes(label) && !container.querySelector('[role=menu]')) await click('EM 菜单')
  const exportLabels: Record<string, string> = { '导出 HTML': 'HTML', '导出 DOCX': 'DOCX', '打印文档': 'PDF' }
  if (exportLabels[label]) {
    if (!container.querySelector('#export-menu')) await click('导出')
    // A blocked parent intentionally keeps its submenu closed.
    if (!container.querySelector('#export-menu')) return
    label = exportLabels[label]
  }
  if (label === '开始使用') {
    while (container.querySelector('[aria-label="下一页"]')) await click('下一页')
  }
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

it('shows first-run onboarding, acknowledges Escape and restores menu focus', async () => {
  localStorage.removeItem('easym-guide-version')
  await mount()
  expect(container.querySelector('[aria-label="EasyM 使用导引"]')).not.toBeNull()
  expect(container.querySelector('.document-panel')?.hasAttribute('inert')).toBe(true)
  const dialog = container.querySelector('[aria-label="EasyM 使用导引"]')!
  await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(container.querySelector('[aria-label="EasyM 使用导引"]')).toBeNull()
  expect(localStorage.getItem('easym-guide-version')).toBe(appVersion)
})
it('shows one guide page at a time, navigates both directions and starts manual guides on page one', async () => {
  localStorage.removeItem('easym-guide-version'); await mount()
  const dialog = () => container.querySelector('[aria-label="EasyM 使用导引"]')!
  expect(dialog().querySelectorAll('section')).toHaveLength(1)
  expect(dialog().textContent).toContain('开始写作')
  expect(dialog().textContent).not.toContain('找回以前的内容')
  expect(dialog().querySelector<HTMLButtonElement>('[aria-label="上一页"]')!.disabled).toBe(true)
  expect(dialog().querySelector('[aria-label="开始使用"]')).toBeNull()
  await click('下一页'); expect(dialog().textContent).toContain('编辑与自动保存')
  await click('下一页'); expect(dialog().textContent).toContain('找回以前的内容')
  await click('上一页'); expect(dialog().textContent).toContain('2 / 4')
  await act(async () => dialog().querySelector('[aria-label="下一页"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  expect(dialog().textContent).toContain('3 / 4')
  await click('下一页'); expect(dialog().textContent).toContain('图片、导出与阅读')
  expect(dialog().textContent).toContain('4 / 4'); expect(dialog().querySelectorAll('section')).toHaveLength(1)
  await click('开始使用'); expect(localStorage.getItem('easym-guide-version')).toBe(appVersion)
  await click('EM 菜单'); await click('设置'); await click('查看使用导引')
  expect(dialog().textContent).toContain('1 / 4')
})
it('shows an update guide and supports manual reopening in settings with persisted appearance', async () => {
  localStorage.setItem('easym-guide-version', '0.2.0')
  await mount(); expect(container.textContent).toContain(`已更新到 EasyM ${appVersion}`)
  await click('开始使用'); await click('EM 菜单'); await click('设置')
  expect(container.querySelector('[aria-label="设置"]')).not.toBeNull()
  expect(container.textContent).toContain('请先打开或另存一个文档')
  const font = container.querySelector<HTMLSelectElement>('[aria-label="编辑字号"]')!
  await act(async () => { font.value = '20'; font.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(localStorage.getItem('easym-editor-font-size')).toBe('20')
  expect(container.querySelector<HTMLElement>('.application')?.style.getPropertyValue('--editor-font-size')).toBe('20px')
  await click('查看使用导引'); expect(container.querySelector('[aria-label="设置"]')).toBeNull()
  await click('开始使用'); await act(async () => root.unmount()); root = createRoot(container)
  await mount(); expect(container.querySelector('[aria-label="EasyM 使用导引"]')).toBeNull()
  expect(container.querySelector<HTMLElement>('.application')?.style.getPropertyValue('--editor-font-size')).toBe('20px')
})

async function tabContext(index: number) {
  const tab = container.querySelectorAll('[role=tab]')[index]
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 20 })
  await act(async () => tab.dispatchEvent(event)); await settle()
  expect(event.defaultPrevented).toBe(true)
}

it('closes the right-clicked background tab without changing other dirty documents', async () => {
  await mount(); await click('新建标签'); await edit('keep active body')
  await tabContext(0); await click('关闭当前')
  expect(container.querySelectorAll('[role=tab]')).toHaveLength(1)
  expect(container.querySelector('textarea')?.value).toBe('keep active body')
  expect(container.querySelector('.close-dialog')).toBeNull()
  expect(native.close).not.toHaveBeenCalled()
})

it('closes other tabs relative to the clicked tab and keeps its edits intact', async () => {
  await mount(); await edit('keep clicked body'); await click('新建标签'); await click('新建标签')
  await tabContext(0); await click('关闭所有其他')
  expect(container.querySelectorAll('[role=tab]')).toHaveLength(1)
  expect(container.querySelector('textarea')?.value).toBe('keep clicked body')
  expect(container.querySelector('.close-dialog')).toBeNull()
  await tabContext(0)
  expect([...container.querySelectorAll<HTMLButtonElement>('.context-menu button')].find(button => button.textContent === '关闭所有其他')?.disabled).toBe(true)
})

it('protects all targeted tabs on cancel and closes all without exiting the app on discard', async () => {
  await mount(); await edit('first body'); await click('新建标签'); await edit('second body')
  await tabContext(0); await click('关闭所有'); await click('返回编辑')
  expect(container.querySelectorAll('[role=tab]')).toHaveLength(2)
  expect([...container.querySelectorAll<HTMLTextAreaElement>('textarea')].map(input => input.value)).toEqual(['first body', 'second body'])
  await tabContext(1); await click('关闭所有'); await click('不保存关闭')
  expect(container.querySelectorAll('[role=tab]')).toHaveLength(1)
  expect(container.querySelector('textarea')?.value).toBe('')
  expect(await drafts.keys()).toEqual([])
  expect(native.close).not.toHaveBeenCalled()
})

it('retains only the closing tabs as drafts and preserves the excluded tab', async () => {
  await mount(); await edit('retain first'); await click('新建标签'); await edit('retain second'); await click('新建标签')
  await tabContext(2); await click('关闭所有其他'); await click('保留草稿并关闭')
  expect(container.querySelectorAll('[role=tab]')).toHaveLength(1)
  expect(container.querySelector('textarea')?.value).toBe('')
  const bodies = await Promise.all((await drafts.keys()).map(async key => (await drafts.load(key))?.text))
  expect(bodies.sort()).toEqual(['retain first', 'retain second'])
})

it('keeps every target tab open when a batch save is cancelled after an earlier save succeeds', async () => {
  await mount(); await edit('first saved'); await click('新建标签'); await edit('second cancelled')
  native.save.mockResolvedValueOnce({ id: 'saved-first', name: 'first.md', revision: 'r1', destination: 'disk' }).mockResolvedValueOnce(null)
  await tabContext(0); await click('关闭所有'); await click('保存并关闭')
  expect(native.save).toHaveBeenCalledTimes(2)
  expect(container.querySelectorAll('[role=tab]')).toHaveLength(2)
  expect(container.querySelector('.close-dialog')).not.toBeNull()
  expect(container.querySelectorAll<HTMLTextAreaElement>('textarea')[1].value).toBe('second cancelled')
  await click('返回编辑')
  expect(container.querySelectorAll('[role=tab]')).toHaveLength(2)
  expect(container.querySelectorAll('[role=tab]')[1].textContent).toContain('*')
})

it('exports current source without saving or clearing dirty drafts, including cancellation and failure', async () => {
  await mount(); await edit('# 新正文\n\n**bold**'); await click('导出 HTML')
  expect(native.exportHtml).toHaveBeenCalledWith('未命名.html', expect.stringContaining('<strong>bold</strong>'))
  expect(native.save).not.toHaveBeenCalled()
  expect(container.querySelector('[role=tab]')?.textContent).toContain('*')
  expect(container.querySelector('textarea')?.value).toBe('# 新正文\n\n**bold**')
  native.exportHtml.mockResolvedValueOnce(false); await click('导出 HTML')
  expect(container.textContent).toContain('HTML 导出已取消')
  native.exportHtml.mockRejectedValueOnce(new Error('disk full')); await click('导出 HTML')
  expect(container.textContent).toContain('disk full')
  expect(container.querySelector('[role=tab]')?.textContent).toContain('*')
  await requestClose(); await click('保留草稿并退出')
  expect((await drafts.load())?.text).toBe('# 新正文\n\n**bold**')
})

it('exports DOCX from unsaved memory with office options and preserves the draft on native cancellation', async () => {
  await mount(); await edit('# 当前未保存正文\n\n**中文**'); await click('导出 DOCX')
  expect(docxApi.preflight).toHaveBeenCalledWith(expect.objectContaining({ text: '# 当前未保存正文\n\n**中文**', id: null }), expect.any(AbortSignal))
  expect(container.querySelector('.docx-dialog')?.textContent).toContain('未命名.docx')
  for (const [label, value] of [['DOCX 纸张', 'letter'], ['DOCX 办公样式', 'compact']]) {
    const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!
    await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) })
  }
  docxApi.save.mockResolvedValueOnce(false)
  await click('生成 DOCX')
  expect(docxApi.render).toHaveBeenCalledWith(expect.objectContaining({ assets: [] }), { page: 'letter', style: 'compact' }, expect.any(AbortSignal))
  expect(docxApi.save).toHaveBeenCalledWith('未命名.docx', expect.any(ArrayBuffer), expect.any(AbortSignal))
  expect(container.textContent).toContain('DOCX 导出已取消')
  expect(container.querySelector('.docx-dialog')).toBeNull()
  expect(native.save).not.toHaveBeenCalled()
  expect(container.querySelector('[role=tab]')?.textContent).toContain('*')
  await requestClose(); await click('保留草稿并退出')
  expect((await drafts.load())?.text).toBe('# 当前未保存正文\n\n**中文**')
})

it('requires explicit DOCX image placeholders and can locate a warning without changing the source', async () => {
  const body = '# 图\n\n![remote](https://example.test/a.png)'
  await mount(); await edit(body); await click('导出 DOCX')
  const generate = container.querySelector<HTMLButtonElement>('.docx-dialog button[type=submit]')!
  expect(generate.disabled).toBe(true)
  expect(container.querySelector('.docx-dialog')?.textContent).toContain('1 项图片无法导出')
  await click('第 3 行 · 第 1 列 · 定位')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  expect(native.jump).toHaveBeenCalledWith(5)
  expect(container.querySelector('.docx-dialog')).toBeNull()
  expect(container.querySelector('textarea')?.value).toBe(body)
  await click('导出 DOCX')
  await act(async () => container.querySelector<HTMLInputElement>('.docx-dialog input[type=checkbox]')!.click())
  await click('生成 DOCX')
  expect(docxApi.render).toHaveBeenCalledWith(expect.anything(), { page: 'a4', style: 'default', allowImagePlaceholders: true }, expect.any(AbortSignal))
  expect(container.textContent).toContain('DOCX 已导出，有 1 项降级提示')
  expect(native.save).not.toHaveBeenCalled()
})

it('locks DOCX preflight, cancels immediately, ignores late results and recovers from generation failure', async () => {
  let resolve!: (value: unknown) => void
  docxApi.preflight.mockImplementationOnce(() => new Promise(value => { resolve = value }))
  await mount(); await edit('protected'); await click('导出 DOCX')
  expect(container.querySelector('.app-shell')?.hasAttribute('inert')).toBe(true)
  await click('EM 菜单')
  expect([...container.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].filter(button => ['重新加载外部版本', '导出', '另存为 / 冲突副本'].includes(button.textContent!)).every(button => button.disabled)).toBe(true)
  await requestClose()
  expect(native.close).not.toHaveBeenCalled()
  expect(container.querySelector('.close-dialog')).toBeNull()
  const signal = docxApi.preflight.mock.calls[0][1] as AbortSignal
  await click('取消')
  expect(signal.aborted).toBe(true)
  await click('导出 DOCX')
  await act(async () => resolve({ model: { name: 'stale.docx' } })); await settle()
  expect(container.querySelector('.docx-dialog')?.textContent).toContain('未命名.docx')
  docxApi.render.mockRejectedValueOnce(new Error('生成失败'))
  await click('生成 DOCX')
  expect(container.textContent).toContain('生成失败')
  expect(container.querySelector('.docx-dialog')).toBeNull()
  expect(container.querySelector('.app-shell')?.hasAttribute('inert')).toBe(false)
  expect(container.querySelector('[role=tab]')?.textContent).toContain('*')
  expect(native.save).not.toHaveBeenCalled()
  await click('导出 DOCX'); await click('生成 DOCX')
  expect(container.textContent).toContain('DOCX 已导出')
})

it('keeps other tabs readable during DOCX preparation without unlocking or closing the target', async () => {
  let prepared!: (value: unknown) => void
  let generated!: (value: ArrayBuffer) => void
  await mount(); await edit('export target'); await click('新建文档'); await edit('other readable document')
  await act(async () => container.querySelectorAll<HTMLButtonElement>('[role=tab]')[0].click()); await settle()
  docxApi.preflight.mockImplementationOnce(() => new Promise(resolve => { prepared = resolve }))
  await click('导出 DOCX'); await click('阅读其他文档')
  expect(container.querySelector('.docx-dialog')).toBeNull()
  expect((container.querySelector('.document-panel:not([hidden]) textarea') as HTMLTextAreaElement).value).toBe('other readable document')
  await requestClose(); expect(native.close).not.toHaveBeenCalled()
  await act(async () => container.querySelectorAll<HTMLButtonElement>('[role=tab]')[0].click()); await settle()
  expect(container.querySelector('.docx-dialog')?.textContent).toContain('正在预检')
  expect(container.querySelector('.document-panel:not([hidden]) .app-shell')?.hasAttribute('inert')).toBe(true)
  await act(async () => prepared({ model: (await import('./core/docx-model')).createDocxModel('export target', '未命名.md'), assets: [] })); await settle()
  expect(container.querySelector('.docx-dialog')?.textContent).toContain('预检完成')
  docxApi.render.mockImplementationOnce(() => new Promise(resolve => { generated = resolve }))
  await click('生成 DOCX')
  await click('阅读其他文档')
  const otherTab = container.querySelectorAll<HTMLButtonElement>('[role=tab]')[1]
  await act(async () => otherTab.focus())
  await act(async () => generated(new ArrayBuffer(8))); await settle()
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  expect(document.activeElement).toBe(otherTab)
  expect(container.querySelector('.docx-dialog')).toBeNull()
  expect((container.querySelector('.document-panel:not([hidden]) textarea') as HTMLTextAreaElement).value).toBe('other readable document')
  expect(docxApi.preflight.mock.calls[0][0].text).toBe('export target')
  expect(docxApi.save).toHaveBeenCalledOnce()
  expect(native.save).not.toHaveBeenCalled()
})

it('cancels DOCX generation, traps focus and prevents cancellation after native save is dispatched', async () => {
  let generated!: (value: ArrayBuffer) => void, saved!: (value: boolean) => void
  await mount(); await click('导出 DOCX')
  expect(document.activeElement?.getAttribute('aria-label')).toBe('DOCX 纸张')
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })))
  expect(document.activeElement?.textContent).toBe('生成 DOCX')
  docxApi.render.mockImplementationOnce(() => new Promise(resolve => { generated = resolve }))
  await click('生成 DOCX')
  const signal = docxApi.render.mock.calls[0][2] as AbortSignal
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(signal.aborted).toBe(true)
  await act(async () => generated(new ArrayBuffer(8))); await settle()
  expect(docxApi.save).not.toHaveBeenCalled()
  await click('导出 DOCX')
  docxApi.save.mockImplementationOnce(() => new Promise(resolve => { saved = resolve }))
  await click('生成 DOCX')
  expect(container.querySelector<HTMLButtonElement>('.docx-dialog button[type=button]')?.disabled).toBe(true)
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(container.querySelector('.docx-dialog')).not.toBeNull()
  await act(async () => saved(true)); await settle()
  expect(container.querySelector('.docx-dialog')).toBeNull()
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  expect(document.activeElement?.getAttribute('aria-label')).toBe('EM 菜单')
})

it('refuses DOCX during IME; preflight/save errors release the lock', async () => {
  await mount()
  native.composing = true; await click('EM 菜单')
  expect([...container.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].find(button => button.getAttribute('aria-label') === '导出')?.disabled).toBe(true)
  native.composing = false; await click('EM 菜单')
  docxApi.preflight.mockRejectedValueOnce(new Error('预检失败'))
  await click('导出 DOCX')
  expect(container.textContent).toContain('预检失败')
  expect(container.querySelector('.docx-dialog')).toBeNull()
  docxApi.save.mockRejectedValueOnce(new Error('permission_denied'))
  await click('导出 DOCX'); await click('生成 DOCX')
  expect(container.textContent).toContain('没有文件访问权限')
  expect(container.querySelector('.app-shell')?.hasAttribute('inert')).toBe(false)
  expect(native.save).not.toHaveBeenCalled()
})

it('prepares a dedicated print root, protects editing, reports missing images and returns with Escape', async () => {
  await mount(); await edit('# 打印中文\n\n![remote](https://example.test/a.png)'); await click('打印文档')
  expect(container.querySelector('.print-dialog')?.textContent).toContain('有 1 项图片未加载')
  expect(document.querySelector('#easym-print-root h1')?.textContent).toBe('打印中文')
  expect(container.querySelector('.app-shell')?.hasAttribute('inert')).toBe(true)
  await click('打开系统打印')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)) })
  expect(native.print).toHaveBeenCalledOnce()
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.querySelector('#easym-print-root')).toBeNull()
  expect(container.querySelector('textarea')?.value).toContain('# 打印中文')
  expect(native.save).not.toHaveBeenCalled()
})

it('rejects output during composition and protects a running export from save and close actions', async () => {
  await mount(); await edit('retained source'); native.composing = true
  await click('导出 HTML'); expect(native.exportHtml).not.toHaveBeenCalled()
  native.composing = false
  let complete!: (value: boolean) => void
  native.exportHtml.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  // Closing and reopening the menu refreshes disabled state after composition.
  await click('EM 菜单'); await click('导出 HTML'); await requestClose()
  expect(container.querySelector('.close-dialog')).toBeNull()
  expect(native.close).not.toHaveBeenCalled()
  await act(async () => container.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, key: 's', bubbles: true })))
  expect(native.save).not.toHaveBeenCalled()
  await act(async () => complete(false)); await settle()
  expect(container.querySelector('textarea')?.value).toBe('retained source')
  expect(container.querySelector('[role=tab]')?.textContent).toContain('*')
})

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
  await click('EM 菜单')
  expect(container.querySelector('[aria-label="文件菜单"]')).toBeNull()
  expect(docxApi.preflight).not.toHaveBeenCalled()
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
  expect((container.querySelector('.document-panel:not([hidden]) textarea') as HTMLTextAreaElement).value).toBe('second edit')
  const tabs = container.querySelectorAll<HTMLButtonElement>('[role=tab]')
  await act(async () => tabs[0].click()); await settle(); await click('恢复草稿')
  expect((container.querySelector('.document-panel:not([hidden]) textarea') as HTMLTextAreaElement).value).toBe('first edit')
})

it('restores index order and active draft, drops missing entries and recovers orphan drafts', async () => {
  for (const key of ['document:a', 'document:b', 'document:orphan']) await drafts.save({ version: 1, name: `${key}.md`, text: key, snapshot: blankSnapshot(), updatedAt: 1, fileId: 'expired-native-id' }, key)
  saveSession({ version: 1, tabs: [{ draftKey: 'document:b', name: 'b.md' }, { draftKey: 'document:gone', name: 'gone.md' }, { draftKey: 'document:a', name: 'a.md' }], activeDraftKey: 'document:a' })
  await mount()
  expect([...container.querySelectorAll('[role=tab]')].map(tab => tab.textContent)).toEqual(['document:b.md *', 'document:a.md *', 'document:orphan.md *'])
  expect(container.querySelector('[role=tab][aria-selected=true]')?.id).toBe('tab-document:a')
  await click('恢复草稿')
  expect((container.querySelector('.document-panel:not([hidden]) textarea') as HTMLTextAreaElement).value).toBe('document:a')
  expect(native.open).not.toHaveBeenCalled(); expect(native.reload).not.toHaveBeenCalled(); expect(native.save).not.toHaveBeenCalled()
  expect(localStorage.getItem(SESSION_KEY)).not.toContain('expired-native-id')
})

it('reopens saved tabs in order with fresh handles while independently recovering drafts', async () => {
  await drafts.save({ version: 1, name: '草稿.md', text: 'local only', snapshot: blankSnapshot(), updatedAt: 1, fileId: 'old-process' }, 'document:dirty')
  const state: RecentState = { entries: [{ id: 'saved', kind: 'file', name: '同名.md', location: 'D:/one/同名.md' }, { id: 'dirty', kind: 'file', name: '草稿.md', location: 'D:/two/草稿.md' }], session: { tabs: [{ draftKey: 'document:saved', recentId: 'saved' }, { draftKey: 'document:dirty', recentId: 'dirty' }], activeDraftKey: 'document:saved', workspaceId: 'workspace' } }
  recentApi.state.mockResolvedValue(state)
  recentApi.file.mockResolvedValue({ id: 'fresh-process', recentId: 'saved', name: '同名.md', bytes: new TextEncoder().encode('disk body'), revision: 'new' })
  recentApi.workspace.mockResolvedValue({ id: 'new-workspace', recentId: 'workspace', name: '项目', entries: [] })
  await mount()
  expect(container.querySelectorAll('[role=tab]')).toHaveLength(2)
  expect((container.querySelector('.document-panel:not([hidden]) textarea') as HTMLTextAreaElement).value).toBe('disk body')
  expect(recentApi.file.mock.calls).toEqual([['saved']]); expect(recentApi.workspace).toHaveBeenCalledWith('workspace')
  await act(async () => container.querySelectorAll<HTMLButtonElement>('[role=tab]')[1].click()); await settle(); await click('恢复草稿')
  expect((container.querySelector('.document-panel:not([hidden]) textarea') as HTMLTextAreaElement).value).toBe('local only')
  expect(native.save).not.toHaveBeenCalled(); expect(native.reload).not.toHaveBeenCalled()
})

it('keeps other restored tabs when one saved file is missing and preserves incompatible native records', async () => {
  const entry = (id: string) => ({ id, kind: 'file' as const, name: `${id}.md`, location: `D:/${id}.md` })
  recentApi.state.mockResolvedValue({ entries: [entry('missing'), entry('good')], session: { tabs: [{ draftKey: 'document:m', recentId: 'missing' }, { draftKey: 'document:g', recentId: 'good' }], activeDraftKey: 'document:m', workspaceId: null } })
  recentApi.file.mockImplementation(async id => { if (id === 'missing') throw 'resource_missing'; return { id: 'fresh', recentId: 'good', name: 'good.md', bytes: new TextEncoder().encode('survives'), revision: 'r' } })
  await mount()
  expect(container.textContent).toContain('目标已移动或删除')
  expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('survives')
  await act(async () => root.unmount()); root = createRoot(container)
  recentApi.state.mockRejectedValue('recent_invalid_record'); recentApi.remember.mockClear()
  await mount(); await edit('still editable'); await settle()
  expect(container.textContent).toContain('原记录已保留')
  expect(recentApi.remember).not.toHaveBeenCalled()
})

it('recent open reuses a saved tab with edits and cancellation releases only unused fresh handles', async () => {
  const entries = [{ id: 'saved', kind: 'file', name: 'note.md', location: 'D:/note.md' }]
  recentApi.state.mockResolvedValue({ entries, session: { tabs: [], activeDraftKey: null, workspaceId: null } })
  native.open.mockResolvedValue({ id: 'live', recentId: 'saved', name: 'note.md', bytes: new TextEncoder().encode('disk'), revision: 'r' })
  await mount(); await click('打开文件'); await settle(); await edit('unsaved edit')
  recentApi.file.mockResolvedValue({ id: 'live', recentId: 'saved', name: 'note.md', bytes: new TextEncoder().encode('older disk'), revision: 'r' })
  await click('EM 菜单'); await click('最近打开'); await settle(); await click('note.mdD:/note.md'); await settle()
  expect(container.querySelectorAll('[role=tab]')).toHaveLength(2)
  expect((container.querySelector('.document-panel:not([hidden]) textarea') as HTMLTextAreaElement).value).toBe('unsaved edit')
  let complete!: (value: unknown) => void
  recentApi.file.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  await click('EM 菜单'); await click('最近打开'); await settle(); await click('note.mdD:/note.md'); await click('完成')
  await act(async () => complete({ id: 'unused-new', recentId: 'saved', name: 'note.md', bytes: new TextEncoder().encode('late'), revision: 'r' })); await settle()
  const { releaseDocument } = await import('./platform/storage')
  expect(releaseDocument).toHaveBeenCalledWith('unused-new')
  expect(container.querySelectorAll('[role=tab]')).toHaveLength(2)
})

it('preserves an incompatible session index while independently recovering and editing drafts', async () => {
  const raw = '{"version":2,"future":"keep"}'
  localStorage.setItem(SESSION_KEY, raw)
  await drafts.save({ version: 1, name: 'draft.md', text: 'safe body', snapshot: blankSnapshot(), updatedAt: 1 })
  await mount(); expect(container.textContent).toContain('无法读取会话索引')
  await click('恢复草稿'); await edit('safe changed')
  await act(async () => window.dispatchEvent(new Event('blur'))); await settle()
  expect((await drafts.load())?.text).toBe('safe changed')
  expect(localStorage.getItem(SESSION_KEY)).toBe(raw)
})

it('reports failed index writes while preserving independently retained draft bodies', async () => {
  await mount(); const previous = localStorage.getItem(SESSION_KEY)
  const storage = localStorage
  vi.stubGlobal('localStorage', { getItem: storage.getItem.bind(storage), setItem: (key: string, value: string) => { if (key === SESSION_KEY) throw new Error('session quota'); storage.setItem(key, value) } })
  await edit('body survives'); await requestClose(); await click('保留草稿并退出')
  expect((await drafts.load())?.text).toBe('body survives')
  expect(storage.getItem(SESSION_KEY)).toBe(previous)
})

it('waits for the startup draft inventory before mounting editable documents', async () => {
  const enumerate = vi.spyOn(drafts, 'keys').mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  let complete!: (keys: string[]) => void
  await act(async () => root.render(createElement(App)))
  expect(container.querySelector('textarea')).toBeNull()
  expect(container.textContent).toContain('正在检查上次会话与草稿')
  expect(container.querySelector<HTMLButtonElement>('.new-document')?.disabled).toBe(true)
  await requestClose(); expect(native.close).not.toHaveBeenCalled()
  await act(async () => complete([])); await settle(); await settle()
  expect(container.querySelector('textarea')).not.toBeNull()
  expect(container.querySelector<HTMLButtonElement>('.new-document')?.disabled).toBe(false)
  enumerate.mockRestore()
})

it('retains the original index on failed inventory and still opens the default editor', async () => {
  saveSession({ version: 1, tabs: [{ draftKey: 'document:untouched', name: 'keep.md' }], activeDraftKey: 'document:untouched' })
  const raw = localStorage.getItem(SESSION_KEY)
  vi.spyOn(drafts, 'keys').mockRejectedValueOnce(new Error('inventory unavailable'))
  await mount(); expect(container.textContent).toContain('inventory unavailable')
  await edit('safe new draft'); await act(async () => window.dispatchEvent(new Event('blur'))); await settle()
  expect((await drafts.load())?.text).toBe('safe new draft')
  expect(localStorage.getItem(SESSION_KEY)).toBe(raw)
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
  expect(container.querySelector('.export-menu-trigger')).not.toBeNull()
  expect(container.querySelector('#export-menu')).toBeNull()
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
  expect(container.querySelectorAll('[role=tab]')).toHaveLength(1)
  await click('恢复草稿')
  expect((container.querySelector('.document-panel:not([hidden]) textarea') as HTMLTextAreaElement).value).toContain('# 项目说明')
  await click('EM 菜单'); await click('从模板新建'); await click('创建文档')
  await act(async () => container.querySelectorAll<HTMLButtonElement>('.tab-close')[1].click()); await settle()
  expect(container.querySelector('.close-dialog')).toBeNull()
  expect(container.querySelectorAll('[role=tab]')).toHaveLength(1)
  expect(native.save).not.toHaveBeenCalled()
})

it('first saves a template with no disk identity and clears its draft', async () => {
  await mount(); await click('EM 菜单'); await click('从模板新建')
  const select = container.querySelector<HTMLSelectElement>('.template-dialog select')!
  await act(async () => { select.value = 'meeting'; select.dispatchEvent(new Event('change', { bubbles: true })) }); await settle(); await click('创建文档')
  await act(async () => window.dispatchEvent(new Event('blur'))); await settle()
  native.save.mockResolvedValue({ id: 'created', name: '会议纪要.md', revision: 'hash', destination: 'disk' })
  await click('另存为 / 冲突副本')
  expect(native.save.mock.calls[0][0]).toEqual({ id: null, name: '会议纪要.md', revision: null, originalText: '' })
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
  await click('EM 菜单')
  expect([...container.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].find(button => button.getAttribute('aria-label') === '导出')?.disabled).toBe(true)
  expect(docxApi.preflight).not.toHaveBeenCalled()
  await click('EM 菜单')
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
  expect(container.querySelector('[role=menuitemradio]')).toBeNull()
  expect(container.textContent).not.toContain('Style · 配色主题')
  await click('设置')
  const picker = container.querySelector<HTMLSelectElement>('[aria-label="设置配色主题"]')!
  await act(async () => { picker.value = 'dark'; picker.dispatchEvent(new Event('change', { bubbles: true })) }); await settle()
  await click('完成')
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

it('opens the export submenu explicitly and handles hierarchical keyboard navigation', async () => {
  await mount(); await click('EM 菜单')
  expect(container.querySelector('#export-menu')).toBeNull()
  expect(container.textContent).not.toContain('Style · 配色主题')
  await click('导出')
  const trigger = container.querySelector<HTMLButtonElement>('.export-menu-trigger')!
  const selected = container.querySelector<HTMLButtonElement>('#export-menu [role=menuitem]')!
  expect(Array.from(container.querySelectorAll('#export-menu [role=menuitem]'), item => item.textContent)).toEqual(['HTML', 'DOCX', 'PDF'])
  expect(document.activeElement).toBe(selected)
  await act(async () => selected.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  expect(document.activeElement?.textContent).toBe('DOCX')
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(container.querySelector('#export-menu')).toBeNull(); expect(container.querySelector('#file-menu')).not.toBeNull(); expect(document.activeElement).toBe(trigger)
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  expect(container.querySelector('#export-menu')).not.toBeNull()
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
  expect(document.activeElement).toBe(trigger)
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(container.querySelector('#file-menu')).toBeNull()
})

const tableFixture = '| name | value |\n| --- | --- |\n| x | y |'
async function tableDraft(value: string) {
  const input = container.querySelector<HTMLTextAreaElement>('[aria-label="单元格 Markdown"]')!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })) })
}
it('refuses stale table targets and preserves the input when applying before export fails', async () => {
  await mount(); await edit(tableFixture); await click('编辑表格'); await tableDraft('kept draft')
  await edit(tableFixture.replace('x', 'external'))
  await click('确认')
  expect(container.querySelector('[aria-label="单元格 Markdown"]')).not.toBeNull()
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="单元格 Markdown"]')!.value).toBe('kept draft')
  expect(container.textContent).toContain('正文或选区已变化')
  const source = container.querySelector('.document-panel:not([hidden]) textarea')!
  await act(async () => source.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true })))
  await settle()
  expect(container.querySelector('[aria-label="未应用的表格输入"]')).not.toBeNull()
  const decision = container.querySelector('[aria-label="未应用的表格输入"]')!
  await act(async () => [...decision.querySelectorAll('button')].find(button => button.textContent === '应用')!.click())
  await settle()
  expect(container.querySelector('.print-dialog')).toBeNull()
  expect(container.querySelector('[aria-label="单元格 Markdown"]')!.textContent).toBe('kept draft')
  await act(async () => [...decision.querySelectorAll('button')].find(button => button.textContent === '放弃')!.click())
  await new Promise(resolve => setTimeout(resolve, 30)); await settle()
  expect(container.querySelector('.print-dialog')).not.toBeNull()
  expect(container.querySelector('.print-dialog')!.textContent).toContain('external')
})
it('requires a table draft decision before switching tabs and proceeding with print', async () => {
  await mount(); await edit(tableFixture); await click('编辑表格'); await tableDraft('applied')
  await click('新建标签')
  expect(container.querySelectorAll('[role=tab]')).toHaveLength(1)
  const choose = async (name: string) => { const decision = container.querySelector('[aria-label="未应用的表格输入"]')!; await act(async () => [...decision.querySelectorAll('button')].find(button => button.textContent === name)!.click()); await new Promise(resolve => setTimeout(resolve, 30)); await settle() }
  await choose('取消')
  expect(container.querySelector('[aria-label="单元格 Markdown"]')!.textContent).toBe('applied')
  const source = container.querySelector('.document-panel:not([hidden]) textarea')!
  await act(async () => source.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }))); await settle()
  await choose('应用')
  expect(container.querySelector('.print-dialog')!.textContent).toContain('applied')
  expect(container.querySelector('[aria-label="单元格 Markdown"]')).toBeNull()
})
