import { expect, it, vi } from 'vitest'
const native = vi.hoisted(() => ({ listen: vi.fn(), destroy: vi.fn() }))
vi.mock('./storage', () => ({ desktop: true }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onCloseRequested: native.listen, destroy: native.destroy }) }))
import { listenForClose, closeWindow } from './window'

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
