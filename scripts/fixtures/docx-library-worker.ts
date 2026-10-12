// Library compatibility probe only. The application generator is a later step.
import { Document, ExternalHyperlink, HeadingLevel, ImageRun, LevelFormat, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from 'docx'
import { canGenerateDocx, createDocxModel, prepareDocxResources } from '../../src/core/docx-model'

self.onmessage = async (event: MessageEvent<{ png: ArrayBuffer; text: string }>) => {
  try {
    if (typeof document !== 'undefined' || typeof window !== 'undefined') throw new Error('Expected a real Worker')
    const prepared = await prepareDocxResources(createDocxModel(event.data.text, '办公导出.md'), async () => new Blob([event.data.png], { type: 'image/png' }))
    if (!canGenerateDocx(prepared.model)) throw new Error('Model preflight failed')
    const doc = new Document({
      numbering: { config: [{ reference: 'probe', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', start: 3 }] }] },
      sections: [{ children: [
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('中文办公🙂')] }),
        new Paragraph({ children: [new TextRun({ text: '粗斜体', bold: true, italics: true }), new TextRun({ text: '删除', strike: true }), new ExternalHyperlink({ link: 'https://example.com/', children: [new TextRun('安全链接')] })] }),
        new Paragraph({ text: '第三项', numbering: { reference: 'probe', level: 0 } }),
        new Table({ rows: [new TableRow({ tableHeader: true, children: [new TableCell({ children: [new Paragraph('表头')] }), new TableCell({ children: [new Paragraph('第二列')] })] }), new TableRow({ children: [new TableCell({ children: [new Paragraph('单元格')] }), new TableCell({ children: [new Paragraph('数值')] })] })] }),
        new Paragraph({ children: [new ImageRun({ type: 'png', data: prepared.assets[0].bytes, transformation: { width: 128, height: 128 }, altText: { name: 'EM', title: 'EM', description: '本地图片' } })] }),
      ] }],
    })
    const bytes = await Packer.toArrayBuffer(doc)
    self.postMessage({ bytes, worker: true, model: { headings: prepared.model.blocks.filter(block => block.type === 'heading').map(block => block.level), images: prepared.model.images.length, warnings: prepared.model.warnings.items.map(item => item.code) } }, { transfer: [bytes] })
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }) }
}
