import { imageGeometry, inspectImage, MAX_IMAGE_BYTES, validateDimensions, type ImageRecipe } from '../core/images'

interface Request { source: Blob; recipe?: ImageRecipe }

self.onmessage = async (event: MessageEvent<Request>) => {
  let bitmap: ImageBitmap | undefined
  try {
    const { source, recipe } = event.data
    const info = inspectImage(new Uint8Array(await source.arrayBuffer()))
    bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' })
    validateDimensions(bitmap.width, bitmap.height)
    const applied = recipe ?? { version: 1, orientationNormalized: true, rotateDegrees: 0, flipHorizontal: false, flipVertical: false, output: { mime: info.mime } }
    const { crop, rotated, output } = imageGeometry(bitmap.width, bitmap.height, applied)
    const canvas = new OffscreenCanvas(output.width, output.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('当前 WebView 不支持后台图片处理。')
    if (applied.output.mime === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, output.width, output.height) }
    ctx.translate(output.width / 2, output.height / 2)
    ctx.scale(output.width / rotated.width, output.height / rotated.height)
    ctx.scale(applied.flipHorizontal ? -1 : 1, applied.flipVertical ? -1 : 1)
    ctx.rotate(applied.rotateDegrees * Math.PI / 180)
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, -crop.width / 2, -crop.height / 2, crop.width, crop.height)
    const blob = await canvas.convertToBlob({ type: applied.output.mime, quality: 0.92 })
    if (blob.size > MAX_IMAGE_BYTES) throw new Error('生成的图片超过 20 MB，请减小输出尺寸。')
    inspectImage(new Uint8Array(await blob.arrayBuffer()))
    self.postMessage({ blob, width: output.width, height: output.height, mime: applied.output.mime })
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : '图片处理失败。' }) }
  finally { bitmap?.close() }
}
