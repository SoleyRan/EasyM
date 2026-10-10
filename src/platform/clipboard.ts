import { invoke, isTauri } from '@tauri-apps/api/core'

export const nativeClipboardFiles = () => isTauri() && /Win/i.test(navigator.platform)

export function supportedImageFiles(files: Iterable<File>): File[] {
  return Array.from(files).filter((file) => file.type.startsWith('image/') || (!file.type && /\.(png|jpe?g)$/i.test(file.name)))
}

export async function readClipboardImageFiles(): Promise<File[]> {
  if (!nativeClipboardFiles()) return []
  const images = await invoke<Array<{ name: string; bytes: number[]; mime: string }>>('read_clipboard_image_files')
  return images.map((image) => new File([new Uint8Array(image.bytes)], image.name, { type: image.mime }))
}
