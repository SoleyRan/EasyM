import { createDocxModel } from '../core/docx-model'
import { generateDocx, type DocxOptions } from '../core/docx'
import type { PreparedDocx } from '../core/docx-model'
import { inspectImage, validateDimensions } from '../core/images'

export type DocxWorkerRequest = { type: 'parse'; text: string; name: string } | { type: 'generate'; prepared: PreparedDocx; options: DocxOptions } | { type: 'decode'; blob: Blob }
self.onmessage = async (event: MessageEvent<DocxWorkerRequest>) => {
  let bitmap: ImageBitmap | undefined
  try {
    const request = event.data
    if (request.type === 'parse') self.postMessage({ value: createDocxModel(request.text, request.name) })
    else if (request.type === 'generate') {
      const bytes = await generateDocx(request.prepared, request.options)
      self.postMessage({ value: bytes }, { transfer: [bytes] })
    } else {
      inspectImage(new Uint8Array(await request.blob.arrayBuffer()))
      bitmap = await createImageBitmap(request.blob, { imageOrientation: 'from-image' })
      validateDimensions(bitmap.width, bitmap.height)
      self.postMessage({ value: { width: bitmap.width, height: bitmap.height } })
    }
  } catch (error) {
    self.postMessage({ error: { message: error instanceof Error ? error.message : 'DOCX 后台任务失败。', name: error instanceof Error ? error.name : 'Error', code: error instanceof Object && 'code' in error ? error.code : undefined } })
  } finally { bitmap?.close() }
}
