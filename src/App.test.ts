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

const native = vi.hoisted(() => ({ requestClose: vi.fn(), close: vi.fn(), save: vi.fn(), open: vi.fn(), reload: vi.fn(), workspace: vi.fn(), workspaceOpen: vi.fn() }))
vi.mock('./platform/workspace', async (original) => ({ ...await original<object>(), openWorkspace: native.workspace, openWorkspaceDocument: native.workspaceOpen }))
vi.mock('./platform/window', () => ({ listenForClose: async (request: () => void) => { native.requestClose.mockImplementation(request); return () => undefined }, closeWindow: native.close }))
vi.mock('./platform/storage', () => ({ desktop: true, openDocument: native.open, reloadDocument: native.reload, saveDocument: native.save, materializeResources: async (_id: unknown, resources: unknown) => resources, readImage: vi.fn(), readImageBlob: vi.fn() }))
vi.mock('./editor/usePreview', () => ({ usePreview: (text: string) => ({ parsed: { html: '', headings: [], images: [] }, parsedText: { current: text } }) }))
vi.mock('./platform/images', async (original) => ({ ...await original<object>(), processImage: async () => ({ blob: new Blob(['display'], { type: 'image/png' }), width: 1, height: 1, mime: 'image/png' }) }))
vi.mock('./editor/Editor', () => ({ Editor: forwardRef(function MockEditor(props: { initialText: string; onChange(text: string): void }, ref) {
  const [body, setBody] = useState(props.initialText)
  useImperativeHandle(ref, () => ({
    selection: () => ({ anchor: 0, head: 0 }), composing: () => false,
    patch: (patches: TextPatch[]) => { const next = applyPatches(body, patches); setBody(next); props.onChange(next); return true },
    jump: () => undefined, undo: () => undefined, redo: () => undefined,
  }))
  return createElement('textarea', { 'aria-label': 'Markdown 源码编辑器', value: body, onChange: (event: { target: { value: string } }) => { setBody(event.target.value); props.onChange(event.target.value) } })
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
  await drafts.clear()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); await drafts.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
async function settle() { await act(async () => { await drafts.load(); await new Promise<void>((resolve) => setTimeout(resolve, 10)) }) }
async function mount() { await act(async () => root.render(createElement(App))); await settle() }
async function click(label: string) {
  const button = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === label || button.getAttribute('aria-label') === label || button.querySelector('span:last-child')?.textContent === label)
  if (!button) throw new Error(`Missing button ${label}`)
  await act(async () => button.click())
  await settle()
}
async function edit(text: string) {
  const editor = container.querySelector('textarea')!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => { setter.call(editor, text); editor.dispatchEvent(new Event('input', { bubbles: true })); editor.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function requestClose() { await act(async () => native.requestClose()) }

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

it('choosing a workspace preserves local edits and opening a tree file requires replacement consent', async () => {
  native.workspace.mockResolvedValue({ id: 'workspace', name: 'notes', entries: [{ name: '文档.md', path: '文档.md', kind: 'document' }] })
  native.workspaceOpen.mockResolvedValue({ id: 'file', name: '文档.md', bytes: new TextEncoder().encode('# 磁盘正文'), revision: 'hash' })
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  await mount(); await edit('# 本地修改'); await click('打开工作区')
  expect(container.querySelector('textarea')?.value).toBe('# 本地修改')
  await click('文档.md')
  expect(native.workspaceOpen).not.toHaveBeenCalled()
  expect(container.querySelector('textarea')?.value).toBe('# 本地修改')
  confirm.mockReturnValue(true)
  await click('文档.md')
  expect(native.workspaceOpen).toHaveBeenCalledWith('workspace', '文档.md')
  expect(container.querySelector('textarea')?.value).toBe('# 磁盘正文')
  expect(await drafts.load()).toBeUndefined()
})

it('flushes the newest draft on loss of focus before the debounce fires', async () => {
  await mount(); await edit('# 失焦前的修改')
  await act(async () => window.dispatchEvent(new Event('blur')))
  await settle()
  expect((await drafts.load())?.text).toBe('# 失焦前的修改')
  expect(native.close).not.toHaveBeenCalled()
})
