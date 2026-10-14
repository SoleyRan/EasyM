import { defaultRecipe, validateDimensions, type ImageRecipe } from './images'
export interface BatchOptions { maxSide: number; format: 'keep' | 'image/png' | 'image/jpeg'; quality: number; stripMetadata: boolean; background: string | null }
export function validateBatchOptions(options: BatchOptions) {
  if (!Number.isInteger(options.maxSide) || options.maxSide < 1 || options.maxSide > 8192 || !['keep', 'image/png', 'image/jpeg'].includes(options.format) || !Number.isFinite(options.quality) || options.quality < 0.1 || options.quality > 1 || typeof options.stripMetadata !== 'boolean' || (options.background !== null && !/^#[0-9a-f]{6}$/i.test(options.background))) throw new Error('批量图片选项无效。')
}
export function batchRecipe(width: number, height: number, mime: ImageRecipe['output']['mime'], options: BatchOptions): ImageRecipe {
  validateDimensions(width, height); validateBatchOptions(options)
  const scale = Math.min(1, options.maxSide / Math.max(width, height))
  return { ...defaultRecipe(options.format === 'keep' ? mime : options.format), orientationNormalized: true, resize: { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) } }
}
