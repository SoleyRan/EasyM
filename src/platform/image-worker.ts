import { imageGeometry, inspectImage, MAX_IMAGE_BYTES, validateDimensions, type ImageRecipe } from '../core/images'
import { validateBatchOptions, type BatchOptions } from '../core/batch-options'
import { attachDescriptions, describeMetadata, removePrivateMetadata } from '../core/image-metadata'

interface Request { source: Blob; recipe?: ImageRecipe; encoding?: BatchOptions }

self.onmessage = async (event: MessageEvent<Request>) => {
  let bitmap: ImageBitmap | undefined
  try {
    const { source, recipe, encoding } = event.data
    const sourceBytes = new Uint8Array(await source.arrayBuffer())
    const info = inspectImage(sourceBytes)
    if (encoding) validateBatchOptions(encoding)
    bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' })
    validateDimensions(bitmap.width, bitmap.height)
    const applied = recipe ?? { version: 1, orientationNormalized: true, rotateDegrees: 0, flipHorizontal: false, flipVertical: false, output: { mime: info.mime } }
    const { crop, rotated, output } = imageGeometry(bitmap.width, bitmap.height, applied)
    const canvas = new OffscreenCanvas(output.width, output.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('当前 WebView 不支持后台图片处理。')
    if (encoding && applied.output.mime === 'image/jpeg' && !encoding.background) {
      const check = new OffscreenCanvas(bitmap.width, bitmap.height), context = check.getContext('2d')!
      context.drawImage(bitmap, 0, 0)
      const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data
      for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) throw new Error('透明图片转 JPEG 必须明确选择背景色。')
    }
    if (applied.output.mime === 'image/jpeg') { ctx.fillStyle = encoding?.background ?? '#fff'; ctx.fillRect(0, 0, output.width, output.height) }
    ctx.translate(output.width / 2, output.height / 2)
    ctx.scale(output.width / rotated.width, output.height / rotated.height)
    ctx.scale(applied.flipHorizontal ? -1 : 1, applied.flipVertical ? -1 : 1)
    ctx.rotate(applied.rotateDegrees * Math.PI / 180)
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, -crop.width / 2, -crop.height / 2, crop.width, crop.height)
    let blob = await canvas.convertToBlob({ type: applied.output.mime, quality: encoding?.quality ?? 0.92 })
    if (encoding) {
      let bytes = removePrivateMetadata(new Uint8Array(await blob.arrayBuffer()), applied.output.mime)
      if (!encoding.stripMetadata) {
        if (applied.output.mime !== info.mime) throw new Error('跨格式转换无法保留元数据，请勾选去除元数据。')
        bytes = attachDescriptions(bytes, applied.output.mime, describeMetadata(sourceBytes, info.mime))
      }
      blob = new Blob([bytes as BlobPart], { type: applied.output.mime })
    }
    if (blob.size > MAX_IMAGE_BYTES) throw new Error('生成的图片超过 20 MB，请减小输出尺寸。')
    inspectImage(new Uint8Array(await blob.arrayBuffer()))
    self.postMessage({ blob, width: output.width, height: output.height, mime: applied.output.mime })
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : '图片处理失败。' }) }
  finally { bitmap?.close() }
}
