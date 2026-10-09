import { expect, it, vi } from 'vitest'
const native = vi.hoisted(() => ({ listen: vi.fn(), destroy: vi.fn(), minimize: vi.fn(), toggleMaximize: vi.fn(), startDragging: vi.fn(), isMaximized: vi.fn(), isFullscreen: vi.fn(), setFullscreen: vi.fn(), onResized: vi.fn() }))
vi.mock('./storage', () => ({ desktop: true }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ ...native, onCloseRequested: native.listen }) }))
import { listenForClose, closeWindow, minimizeWindow, toggleMaximizeWindow, dragWindow, windowState, setFullscreen, listenWindowState } from './window'

it('prevents native close before delegating to the application and unregisters cleanly', async () => {
  const stop = vi.fn(), request = vi.fn(), preventDefault = vi.fn()
  native.listen.mockResolvedValue(stop)
  const dispose = await listenForClose(request)
  native.listen.mock.calls[0][0]({ preventDefault })
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(request).toHaveBeenCalledOnce()
  expect(native.destroy).not.toHaveBeenCalled()
  dispose()
  expect(stop).toHaveBeenCalledOnce()
})

it('closes only through the explicit authorized completion path', async () => {
  await closeWindow()
  expect(native.destroy).toHaveBeenCalledOnce()
})

it('delegates custom titlebar and fullscreen actions to the native window', async () => {
  await minimizeWindow(); await toggleMaximizeWindow(); await dragWindow(); await setFullscreen(true); await setFullscreen(false)
  expect(native.minimize).toHaveBeenCalledOnce(); expect(native.toggleMaximize).toHaveBeenCalledOnce(); expect(native.startDragging).toHaveBeenCalledOnce()
  expect(native.setFullscreen.mock.calls).toEqual([[true], [false]])
  native.isMaximized.mockResolvedValue(true); native.isFullscreen.mockResolvedValue(false)
  expect(await windowState()).toEqual({ maximized: true, fullscreen: false })
  const changed = vi.fn(), stop = vi.fn(); native.onResized.mockResolvedValue(stop)
  const dispose = await listenWindowState(changed); native.onResized.mock.calls[0][0](); expect(changed).toHaveBeenCalledOnce(); dispose(); expect(stop).toHaveBeenCalledOnce()
})
