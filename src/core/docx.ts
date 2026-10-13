import { AlignmentType, BorderStyle, Document, ExternalHyperlink, HeadingLevel, ImageRun, LevelFormat, Packer, Paragraph, Table, TableCell, TableLayoutType, TableRow, TextRun, WidthType, type INumberingOptions, type IParagraphOptions, type ParagraphChild } from 'docx'
import { canGenerateDocx, DocxQuotaError, type DocxBlock, type DocxInline, type PreparedDocx } from './docx-model'
import { defaultDocxOptions, MAX_DOCX_BYTES, type DocxOptions } from './docx-options'
import { MAX_ASSET_BYTES, MAX_IMAGE_BYTES, validateDimensions } from './images'
export { defaultDocxOptions, MAX_DOCX_BYTES, type DocxOptions } from './docx-options'

const font = { ascii: 'Calibri', hAnsi: 'Calibri', eastAsia: 'Microsoft YaHei', cs: 'Arial' }
const codeFont = { ascii: 'Consolas', hAnsi: 'Consolas', eastAsia: 'Microsoft YaHei', cs: 'Consolas' }
const border = { style: BorderStyle.SINGLE, size: 4, color: 'B8B8B8' }
const headings = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6]

// Pure model conversion: no source writes, DOM, app theme or resource reads.
export function createDocxDocument(prepared: PreparedDocx, options: DocxOptions = defaultDocxOptions): Document {
  if (!['a4', 'letter'].includes(options.page) || !['default', 'compact'].includes(options.style)) throw new Error('DOCX 页面或样式无效。')
  if (!canGenerateDocx(prepared.model, options.allowImagePlaceholders)) throw new Error('图片预检未通过，请修复图片或明确选择占位导出。')
  let total = 0
  for (const asset of prepared.assets) {
    total += asset.bytes.byteLength
    if (asset.bytes.byteLength > MAX_IMAGE_BYTES || total > MAX_ASSET_BYTES) throw new DocxQuotaError('DOCX 图片超出单图或总资源限制。')
    try { validateDimensions(asset.width, asset.height) } catch (error) { throw new DocxQuotaError(error instanceof Error ? error.message : 'DOCX 图片尺寸超限。') }
  }
  const assets = new Map(prepared.assets.map(asset => [asset.id, asset]))
  for (const image of prepared.model.images) if (image.status === 'ready' && !assets.has(image.id)) throw new Error('DOCX 图片字节缺失，请重新预检。')
  const compact = options.style === 'compact', margin = 1134 // 20 mm in twips
  const size = options.page === 'letter' ? { width: 12240, height: 15840 } : { width: 11906, height: 16838 }
  const contentWidth = size.width - margin * 2, contentHeight = size.height - margin * 2
  const numbering: INumberingOptions['config'][number][] = []
  const spacing = { before: 0, after: compact ? 80 : 160, line: compact ? 264 : 300 }
  const inline = (nodes: DocxInline[], width: number): ParagraphChild[] => nodes.flatMap((node): ParagraphChild[] => {
    switch (node.type) {
      case 'text': return [new TextRun({ text: node.text, bold: node.style.bold, italics: node.style.italic, strike: node.style.strike, ...(node.style.code ? { font: codeFont, size: 18, color: '000000', shading: { fill: 'F2F2F2' } } : {}) })]
      case 'break': return [new TextRun({ break: 1 })]
      case 'link': return [new ExternalHyperlink({ link: node.url, children: inline(node.children, width) })]
      case 'image': {
        const asset = assets.get(node.resourceId)
        if (!asset) return [new TextRun({ text: `[图片：${node.alt || '无说明'}（未嵌入）]`, italics: true, color: '555555' })]
        // 96 dpi, fit both dimensions and never enlarge. Keep exact display bytes.
        const scale = Math.min(1, width / 15 / asset.width, contentHeight / 15 / asset.height)
        return [new ImageRun({ type: asset.mime === 'image/png' ? 'png' : 'jpg', data: asset.bytes, transformation: { width: asset.width * scale, height: asset.height * scale }, altText: { name: node.alt || '图片', title: node.alt || '图片', description: node.alt || '图片' } })]
      }
    }
  })
  const paragraph = (children: ParagraphChild[], indent: number, extra: IParagraphOptions = {}) => new Paragraph({ children, spacing, indent: { left: indent }, widowControl: true, ...extra })
  const literal = (text: string): TextRun[] => text.split(/\r?\n/).map((line, index) => new TextRun({ text: line, break: index ? 1 : undefined, font: codeFont, size: 18, color: '000000' }))
  const blocks = (nodes: DocxBlock[], indent = 0): Array<Paragraph | Table> => nodes.flatMap((node): Array<Paragraph | Table> => {
    const width = Math.max(720, contentWidth - indent)
    switch (node.type) {
      case 'paragraph': return [paragraph(inline(node.children, width), indent)]
      case 'heading': return [paragraph(inline(node.children, width), indent, { heading: headings[node.level - 1], keepNext: true, spacing: { before: compact ? 160 : 240, after: compact ? 80 : 120 } })]
      case 'quote': return blocks(node.children, Math.min(indent + 360, Math.floor(contentWidth / 2)))
      case 'list': {
        const reference = `list-${numbering.length + 1}`, level = Math.min(node.depth, 8), left = Math.min(indent + 360, Math.floor(contentWidth / 2))
        if (!node.staticMarkers) numbering.push({ reference, levels: Array.from({ length: 9 }, (_, depth) => ({ level: depth, format: node.ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET, text: node.ordered ? `%${depth + 1}.` : '•', start: Math.max(0, Math.min(2147483647, node.start)), style: { run: { font, size: 22 }, paragraph: { indent: { left, hanging: 240 } } } })) })
        return node.items.flatMap((item, index) => {
          const marker = item.checked !== null ? `${item.checked ? '☑' : '☐'} ` : node.staticMarkers ? `${node.ordered ? `${node.start + index}.` : '•'} ` : ''
          const first = item.children[0]
          const children = first?.type === 'paragraph' || first?.type === 'heading' ? inline(first.children, Math.max(720, contentWidth - left)) : []
          const lead = paragraph([...marker ? [new TextRun(marker)] : [], ...children], left, { ...first?.type === 'heading' ? { heading: headings[first.level - 1], keepNext: true } : {}, ...marker ? {} : { numbering: { reference, level } } })
          return [lead, ...blocks(children.length || first?.type === 'paragraph' || first?.type === 'heading' ? item.children.slice(1) : item.children, left)]
        })
      }
      case 'code':
      case 'raw': return [
        ...node.type === 'code' && node.language ? [paragraph([new TextRun({ text: node.language, size: 18, color: '555555' })], indent, { keepNext: true })] : [],
        paragraph(literal(node.text), indent, { shading: { fill: 'F2F2F2' }, wordWrap: true, keepLines: false, spacing: { ...spacing, line: 240 } }),
      ]
      case 'separator': return [paragraph([], indent, { border: { bottom: border } })]
      case 'table': {
        const count = Math.max(1, ...node.rows.map(row => row.length)), cellWidth = Math.max(1, Math.floor(width / count))
        const length = (nodes: DocxInline[]): number => nodes.reduce((sum, run) => sum + (run.type === 'text' ? run.text.length : run.type === 'link' ? length(run.children) : run.type === 'image' ? 501 : 1), 0)
        const rows = node.rows.map((row, index) => new TableRow({ tableHeader: index === 0, cantSplit: !row.some(cell => length(cell.children) > 500), children: row.map((cell, col) => new TableCell({ width: { size: cellWidth, type: WidthType.DXA }, margins: { top: compact ? 50 : 100, bottom: compact ? 50 : 100, left: compact ? 60 : 120, right: compact ? 60 : 120 }, shading: index === 0 ? { fill: 'F2F2F2' } : undefined, children: [paragraph(inline(cell.children, Math.max(15, cellWidth - (compact ? 120 : 240))), 0, { alignment: node.align[col] === 'right' ? AlignmentType.RIGHT : node.align[col] === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT, spacing: { ...spacing, after: 0 }, keepLines: false })] })) }))
        // A paragraph after a table is required inside many Word containers and
        // keeps following content independent of the table's last cell.
        return [new Table({ rows, width: { size: width, type: WidthType.DXA }, indent: { size: indent, type: WidthType.DXA }, columnWidths: Array(count).fill(cellWidth), layout: TableLayoutType.FIXED, borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border } }), paragraph([], indent, { spacing: { before: 0, after: 0, line: 80 } })]
      }
    }
  })
  const children = blocks(prepared.model.blocks)
  return new Document({ creator: 'EasyM', title: prepared.model.name.replace(/\.docx$/i, ''), numbering: { config: numbering }, styles: { default: { document: { run: { font, size: 22, color: '000000' }, paragraph: { spacing } } }, paragraphStyles: headings.map((id, index) => ({ id, name: `heading ${index + 1}`, basedOn: 'Normal', next: 'Normal', run: { font, size: [36, 32, 28, 26, 24, 22][index], bold: true, color: '000000' }, paragraph: { keepNext: true, spacing: { before: compact ? 160 : 240, after: compact ? 80 : 120 } } })) }, sections: [{ properties: { page: { size, margin: { top: margin, bottom: margin, left: margin, right: margin } } }, children: children.length ? children : [new Paragraph('')] }] })
}

export async function generateDocx(prepared: PreparedDocx, options: DocxOptions = defaultDocxOptions): Promise<ArrayBuffer> {
  const bytes = await Packer.toArrayBuffer(createDocxDocument(prepared, options))
  if (bytes.byteLength > MAX_DOCX_BYTES) throw new DocxQuotaError('DOCX 输出最多 192 MiB，请减少内容或图片。')
  return bytes
}
