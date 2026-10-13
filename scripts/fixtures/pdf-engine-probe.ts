import { parseDocument } from '../../src/core/markdown'
import { createExport } from '../../src/core/export'
import { createDocxModel } from '../../src/core/docx-model'

// Evaluation only: reuse production sanitization and the independent AST model.
Object.assign(globalThis, {
  async pdfProbe(text: string, images: Record<string, string>) {
    const result = await createExport(parseDocument(text), 'PDF evaluation.md', async path => {
      if (!images[path]) throw new Error('Missing fixture image')
      const [header, encoded] = images[path].split(',')
      return new Blob([Uint8Array.from(atob(encoded), char => char.charCodeAt(0))], { type: header.slice(5).split(';')[0] })
    })
    return { ...result, model: createDocxModel(text, 'PDF evaluation.md') }
  },
})
