// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))
vi.mock('./storage', () => ({ desktop: true }))

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); native.invoke.mockReset() })

it('uses the native dialog on macOS, where WKWebView answers window.confirm with false', async () => {
  vi.stubGlobal('navigator', { platform: 'MacIntel' })
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  const { confirmAction } = await import('./dialogs')
  native.invoke.mockResolvedValueOnce(true)
  expect(await confirmAction('删除？')).toBe(true)
  native.invoke.mockResolvedValueOnce(false)
  expect(await confirmAction('删除？')).toBe(false)
  expect(native.invoke).toHaveBeenCalledWith('confirm_dialog', { message: '删除？' })
  expect(confirm).not.toHaveBeenCalled()
})

it('keeps window.confirm on Windows and Linux, whose WebViews show it', async () => {
  const { confirmAction } = await import('./dialogs')
  for (const platform of ['Win32', 'Linux x86_64']) {
    vi.stubGlobal('navigator', { platform })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    expect(await confirmAction('删除？')).toBe(true)
    expect(confirm).toHaveBeenCalledWith('删除？')
  }
  expect(native.invoke).not.toHaveBeenCalled()
})
