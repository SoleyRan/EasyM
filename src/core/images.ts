export interface ImageRecipe {
  version: 1
  orientationNormalized: boolean
  crop?: { unit: 'sourcePixel'; x: number; y: number; width: number; height: number }
  rotateDegrees: 0 | 90 | 180 | 270
  flipHorizontal: boolean
  flipVertical: boolean
  resize?: { width: number; height: number }
  output: { mime: 'image/png' | 'image/jpeg' }
}

export interface ImageInstance {
  instanceId: string
  documentId: string | null
  sourcePath: string
  sourceHash: string
  displayPath: string
  recipe: ImageRecipe
  referenceRevision: number
}

export interface ImageMetadata {
  schemaVersion: 1
  instances: ImageInstance[]
}

export const defaultRecipe = (mime: ImageRecipe['output']['mime'] = 'image/png'): ImageRecipe => ({
  version: 1,
  orientationNormalized: false,
  rotateDegrees: 0,
  flipHorizontal: false,
  flipVertical: false,
  output: { mime },
})

export function validateRecipe(recipe: ImageRecipe): void {
  if (recipe.version !== 1) throw new Error('Unsupported image recipe version')
  if (![0, 90, 180, 270].includes(recipe.rotateDegrees)) throw new Error('Invalid rotation')
  if (!['image/png', 'image/jpeg'].includes(recipe.output.mime)) throw new Error('Unsupported image format')
  if (recipe.crop && (!Object.values(recipe.crop).filter((v) => typeof v === 'number').every(Number.isSafeInteger) || recipe.crop.unit !== 'sourcePixel' || recipe.crop.width <= 0 || recipe.crop.height <= 0 || recipe.crop.x < 0 || recipe.crop.y < 0)) throw new Error('Invalid crop bounds')
  if (recipe.resize) validateDimensions(recipe.resize.width, recipe.resize.height)
}

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_ASSET_BYTES = 128 * 1024 * 1024
export const MAX_PIXELS = 24_000_000
export const MAX_SIDE = 8192

export function validateDimensions(width: number, height: number): void {
  if (![width, height].every((v) => Number.isSafeInteger(v) && v > 0 && v <= MAX_SIDE) || width * height > MAX_PIXELS) throw new Error('图片尺寸超限：单边最多 8192 像素，总像素最多 2400 万。')
}

export function imageGeometry(width: number, height: number, recipe: ImageRecipe) {
  validateDimensions(width, height)
  validateRecipe(recipe)
  const crop = recipe.crop ?? { unit: 'sourcePixel' as const, x: 0, y: 0, width, height }
  if (crop.x + crop.width > width || crop.y + crop.height > height) throw new Error('裁剪范围超过源图片。')
  const quarterTurn = recipe.rotateDegrees === 90 || recipe.rotateDegrees === 270
  const rotated = { width: quarterTurn ? crop.height : crop.width, height: quarterTurn ? crop.width : crop.height }
  const output = recipe.resize ?? rotated
  validateDimensions(output.width, output.height)
  return { crop, rotated, output }
}

// Inspect dimensions before allocating a decoded bitmap. The decoder is still the final authority.
export function inspectImage(bytes: Uint8Array): { mime: ImageRecipe['output']['mime']; width: number; height: number } {
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('图片文件超过 20 MB。')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let width = 0, height = 0
  let mime: ImageRecipe['output']['mime']
  if (bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v) && String.fromCharCode(...bytes.slice(12, 16)) === 'IHDR') {
    mime = 'image/png'; width = view.getUint32(16); height = view.getUint32(20)
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    mime = 'image/jpeg'
    let offset = 2
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) throw new Error('JPEG 文件损坏。')
      while (bytes[offset] === 255) offset++
      const marker = bytes[offset++]
      if (marker === 0xd9 || marker === 0xda) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (offset + 2 > bytes.length) break
      const length = view.getUint16(offset)
      if (length < 2 || offset + length > bytes.length) throw new Error('JPEG 文件损坏。')
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8) throw new Error('JPEG 文件损坏。')
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5); break
      }
      offset += length
    }
  } else throw new Error('仅支持可解码的 PNG / JPEG 图片。')
  validateDimensions(width, height)
  return { mime, width, height }
}

export function assetPath(path: string): boolean {
  return /^assets\/(?:\.originals\/)?img-[a-zA-Z0-9-]+\.(?:png|jpg)$/.test(path)
}
