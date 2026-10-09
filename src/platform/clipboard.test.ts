import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { nativeClipboardFiles, readClipboardImageFiles, supportedImageFiles } from './clipboard'

const platform = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => platform)

beforeEach(() => { platform.invoke.mockReset(); platform.isTauri.mockReturnValue(true); vi.stubGlobal('navigator', { platform: 'Win32' }) })
afterEach(() => vi.unstubAllGlobals())

it('reads named PNG/JPEG bytes only on the supported desktop platform', async () => {
  platform.invoke.mockResolvedValue([{ name: '中文.PNG', bytes: [137, 80, 78, 71], mime: 'image/png' }])
  const [file] = await readClipboardImageFiles()
  expect(platform.invoke).toHaveBeenCalledWith('read_clipboard_image_files')
  expect(file.name).toBe('中文.PNG'); expect(file.type).toBe('image/png')
  expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([137, 80, 78, 71])
  vi.stubGlobal('navigator', { platform: 'MacIntel' })
  expect(nativeClipboardFiles()).toBe(false)
  expect(await readClipboardImageFiles()).toEqual([])
  expect(platform.invoke).toHaveBeenCalledTimes(1)
})

it('accepts a file without MIME only when it has a supported image extension', () => {
  const png = new File(['png'], '图片.PNG'), text = new File(['text'], 'note.md')
  const explicitText = new File(['text'], 'fake.png', { type: 'text/plain' })
  expect(supportedImageFiles([png, text, explicitText])).toEqual([png])
})
