import { parentPort, workerData } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'

const require = createRequire(workerData.packageJson)
const started = performance.now()
try {
  const pdfmake = require('pdfmake')
  pdfmake.setUrlAccessPolicy(() => false)
  pdfmake.setLocalAccessPolicy(path => path === workerData.font)
  pdfmake.addFonts({ Noto: Object.fromEntries(['normal', 'bold', 'italics', 'bolditalics'].map(key => [key, workerData.font])) })
  const inline = items => items.flatMap(item => {
    if (item.type === 'break') return [{ text: '\n' }]
    if (item.type === 'image') return [{ text: `[${item.alt}]` }]
    if (item.type === 'link') return inline(item.children).map(run => ({ ...run, link: item.url }))
    return [{ text: item.text, bold: item.style.bold, italics: item.style.italic, decoration: item.style.strike ? 'lineThrough' : undefined }]
  })
  const blocks = items => items.flatMap(block => {
    if (block.type === 'paragraph') {
      if (block.children.length === 1 && block.children[0].type === 'image') {
        const resource = workerData.model.images.find(image => image.id === block.children[0].resourceId)
        const image = workerData.images[resource?.path]
        return image ? [{ image, fit: [450, 650], margin: [0, 8, 0, 8] }] : [{ text: `[图片未加载：${block.children[0].alt}]` }]
      }
      return [{ text: inline(block.children), margin: [0, 5, 0, 5] }]
    }
    if (block.type === 'heading') return [{ text: inline(block.children), fontSize: 24 - block.level * 2, margin: [0, 12, 0, 6] }]
    if (block.type === 'code' || block.type === 'raw') return [{ text: block.text, fontSize: 9, background: '#f4f4f4', margin: [0, 6, 0, 6] }]
    if (block.type === 'table') return [{ table: { headerRows: 1, widths: block.rows[0].map(() => '*'), dontBreakRows: true, body: block.rows.map(row => row.map(cell => ({ text: inline(cell.children), margin: [3, 3, 3, 3] }))) } }]
    if (block.type === 'quote') return [{ stack: blocks(block.children), margin: [14, 4, 0, 4] }]
    if (block.type === 'list') return [{ [block.ordered ? 'ol' : 'ul']: block.items.map(item => ({ stack: blocks(item.children) })), start: block.start }]
    if (block.type === 'separator') return [{ text: '____________________' }]
    throw new Error(`Unmapped model block: ${block.type}`)
  })
  const content = blocks(workerData.model.blocks)
  const definition = { pageSize: workerData.format, pageMargins: [51, 51, 51, 51], defaultStyle: { font: 'Noto', fontSize: 11, lineHeight: 1.3 }, content }
  parentPort.postMessage({ ready: true, startupMs: performance.now() - started, definition })
  const generation = performance.now()
  const output = await pdfmake.createPdf(definition).getBuffer()
  parentPort.postMessage({ bytes: output, generationMs: performance.now() - generation, peakRssBytes: process.resourceUsage().maxRSS * 1024 })
} catch (error) { parentPort.postMessage({ error: error.message }) }
