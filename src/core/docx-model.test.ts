import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import type { Root } from 'mdast'
import { parseMarkdownAst } from './markdown-ast'
import { parseDocument } from './markdown'
import { canGenerateDocx, createDocxModel, DOCX_LIMITS, DocxQuotaError, mapDocxAst, prepareDocxResources, type DocxBlock, type DocxInline } from './docx-model'

const sample = (name: string) => readFileSync(`Docs/samples/v0.3/${name}.md`, 'utf8')
const png = readFileSync('Docs/samples/v0.3/assets/em.png')
const imageBlob = () => new Blob([png], { type: 'image/png' })
const allBlocks = (blocks: DocxBlock[]): DocxBlock[] => blocks.flatMap(block => [block, ...('children' in block && block.type === 'quote' ? allBlocks(block.children) : block.type === 'list' ? block.items.flatMap(item => allBlocks(item.children)) : [])])
const inlines = (blocks: DocxBlock[]): DocxInline[] => allBlocks(blocks).flatMap(block => block.type === 'paragraph' || block.type === 'heading' ? block.children : block.type === 'table' ? block.rows.flatMap(row => row.flatMap(cell => cell.children)) : [])

it('gives preview and DOCX independent original ASTs and retains source offsets', () => {
  const text = '中文🙂\n\n![显示][photo]\n\n[photo]: assets/em.png'
  const tree = parseMarkdownAst(text), before = structuredClone(tree)
  const model = mapDocxAst(tree, text, '中文.md')
  parseDocument(text)
  expect(tree).toEqual(before)
  expect(parseMarkdownAst(text)).toEqual(before)
  expect(model.images[0].path).toBe('assets/em.png')
  expect(text.slice(model.images[0].range.from, model.images[0].range.to)).toBe('![显示][photo]')
  expect(model.blocks.some(block => block.type === 'raw')).toBe(false)
  expect(structuredClone(model)).toEqual(model)
})

it('maps the frozen office fixture to editable structure with nested formatting and numbering', () => {
  const text = sample('办公导出'), model = createDocxModel(text, '办公.md')
  const blocks = allBlocks(model.blocks), runs = inlines(model.blocks)
  expect(blocks.filter(b => b.type === 'heading').map(b => b.level)).toEqual([1, 2, 3, 4, 5, 6])
  expect(blocks.find(b => b.type === 'list' && b.ordered)).toMatchObject({ start: 3, depth: 0 })
  expect(blocks.find(b => b.type === 'list' && b.depth === 1)).toBeDefined()
  expect(blocks.filter(b => b.type === 'list').flatMap(b => b.items.map(item => item.checked))).toEqual(expect.arrayContaining([true, false, null]))
  expect(blocks.find(b => b.type === 'table')).toMatchObject({ align: ['left', 'center', 'right'] })
  expect(blocks.find(b => b.type === 'code' && b.language === 'typescript')).toMatchObject({ text: expect.stringContaining("const title = '中文🙂'") })
  expect(runs.some(run => run.type === 'text' && run.style.bold && run.style.italic)).toBe(true)
  expect(runs.some(run => run.type === 'break')).toBe(true)
  expect(runs.filter(run => run.type === 'image')).toHaveLength(2)
  expect(model.images).toHaveLength(1)
  expect(model.warnings.items.map(w => w.code)).toEqual(['font_fallback'])
  expect(model.name).toBe('办公.docx')
})

it('preserves unknown syntax and unsafe URLs as inert text and never reads restricted images', async () => {
  const text = sample('降级与安全'), model = createDocxModel(text, '../降级.md')
  expect(model.name).not.toContain('/')
  expect(model.blocks.filter(b => b.type === 'raw').map(b => b.text).join('\n')).toContain('<script>globalThis.easymDocxExecuted = true</script>')
  expect(model.blocks.filter(b => b.type === 'raw').map(b => b.text).join('\n')).toContain('title: "中文导出预检"')
  expect(model.blocks.at(-1)).toMatchObject({ type: 'raw', text: expect.stringContaining('[unused]:') })
  expect(inlines(model.blocks).filter(n => n.type === 'link')).toHaveLength(0)
  expect(model.warnings.items.map(w => w.code)).toEqual(expect.arrayContaining(['unsafe_link', 'restricted_image', 'wide_table', 'unsupported_node', 'unused_definition']))
  const load = vi.fn(async () => { throw new Error('missing') })
  const prepared = await prepareDocxResources(model, load)
  expect(load.mock.calls).toHaveLength(1)
  expect(load).toHaveBeenCalledWith('assets/missing.png', undefined)
  expect(prepared.model.warnings.imageFailures).toBe(4)
  expect(canGenerateDocx(prepared.model)).toBe(false)
  expect(canGenerateDocx(prepared.model, true)).toBe(true)
  expect(canGenerateDocx(model, true)).toBe(false)
})

it('loads decoded duplicate image paths once and leaves the input model untouched', async () => {
  const model = createDocxModel('![一](图片/em.png)\n\n![二](%E5%9B%BE%E7%89%87/em.png)', '图片.md')
  const before = structuredClone(model), load = vi.fn(async () => imageBlob())
  const prepared = await prepareDocxResources(model, load)
  expect(load).toHaveBeenCalledTimes(1)
  expect(prepared.assets).toHaveLength(1)
  expect(prepared.assets[0].bytes).toEqual(new Uint8Array(png))
  expect(prepared.assets[0]).toMatchObject({ mime: 'image/png', width: 128, height: 128 })
  expect(canGenerateDocx(prepared.model)).toBe(true)
  expect(model).toEqual(before)
  await expect(prepareDocxResources(prepared.model, load)).rejects.toThrow('重新建立')
})

it('retains soft/hard breaks, static dangerous links and first reference definition', () => {
  const model = createDocxModel('A\nB\\\nC **[链接][x]** [坏](javascript:alert%281%29)\n\n[x]: https://example.com\n[x]: https://evil.example', 'note.md')
  const runs = inlines(model.blocks)
  expect(runs).toContainEqual(expect.objectContaining({ type: 'text', text: 'A B' }))
  expect(runs).toContainEqual(expect.objectContaining({ type: 'break' }))
  const link = runs.find(run => run.type === 'link')
  expect(link).toMatchObject({ url: 'https://example.com/', children: [expect.objectContaining({ style: { bold: true } })] })
  expect(model.blocks.at(-1)).toMatchObject({ type: 'raw', text: '[x]: https://evil.example' })
  expect(runs).toContainEqual(expect.objectContaining({ type: 'text', text: ' (javascript:alert%281%29)' }))
})

it('rejects quota breaches and bounds detailed warnings without losing failure totals', async () => {
  expect(() => createDocxModel('中'.repeat(Math.floor(DOCX_LIMITS.textBytes / 3) + 1), 'big.md')).toThrow(DocxQuotaError)
  expect(() => createDocxModel(Array.from({ length: 501 }, (_, i) => `![${i}](assets/${i}.png)`).join('\n\n'), 'big.md')).toThrow(DocxQuotaError)
  const model = createDocxModel(Array.from({ length: 1100 }, (_, i) => `<div>${i}</div>`).join('\n\n') + '\n\n![bad](https://example.com/x.png)', 'warnings.md')
  expect(model.warnings.items).toHaveLength(1000)
  expect(model.warnings.total).toBeGreaterThan(1000)
  expect(model.warnings.imageFailures).toBe(1)
  expect(canGenerateDocx(model)).toBe(false)
  const local = createDocxModel('![local](a.png)', 'quota.md')
  await expect(prepareDocxResources(local, async () => new Blob([new Uint8Array(20 * 1024 * 1024 + 1)]))).rejects.toThrow(DocxQuotaError)
  const oversized = new Uint8Array(png); new DataView(oversized.buffer).setUint32(16, 9000)
  await expect(prepareDocxResources(local, async () => new Blob([oversized]))).rejects.toThrow(DocxQuotaError)
  const many = createDocxModel(Array.from({ length: 7 }, (_, i) => `![${i}](${i}.png)`).join('\n\n'), 'total.md')
  const load = vi.fn(async () => {
    const blob = imageBlob()
    Object.defineProperty(blob, 'size', { value: 20 * 1024 * 1024 })
    return blob
  })
  await expect(prepareDocxResources(many, load)).rejects.toThrow('128 MiB')
  expect(load).toHaveBeenCalledTimes(7)
})

it('rejects encoded traversal and credentials and preserves lists beyond native numbering depth', () => {
  const text = '![escape](%2e%2e/a.png)\n\n![absolute](C%3A/a.png)\n\n![vector](a.svg)\n\n[credentials](https://user:pass@example.com)\n\n' + Array.from({ length: 10 }, (_, i) => `${'  '.repeat(i)}- 层${i}`).join('\n')
  const model = createDocxModel(text, 'boundary.md')
  expect(model.images.every(image => image.path === null)).toBe(true)
  expect(model.warnings.imageFailures).toBe(3)
  expect(model.warnings.items.map(item => item.code)).toEqual(expect.arrayContaining(['unsafe_link', 'deep_list']))
  expect(allBlocks(model.blocks).find(block => block.type === 'list' && block.depth === 9)).toMatchObject({ staticMarkers: true })
})

it('preserves custom unknown AST nodes and rejects malicious node count/depth before recursive mapping', () => {
  const tree = { type: 'root', children: [{ type: 'extension', position: { start: { offset: 0 }, end: { offset: 10 } } }] } as unknown as Root
  expect(mapDocxAst(tree, '{{custom}}', 'unknown.md').blocks[0]).toMatchObject({ type: 'raw', text: '{{custom}}' })
  const wide = { type: 'root', children: Array.from({ length: DOCX_LIMITS.nodes }, () => ({ type: 'text', value: 'a' })) } as unknown as Root
  expect(() => mapDocxAst(wide, '', 'wide.md')).toThrow(DocxQuotaError)
  let deep: unknown = { type: 'paragraph', children: [] }
  for (let i = 0; i < 130; i++) deep = { type: 'blockquote', children: [deep] }
  expect(() => mapDocxAst({ type: 'root', children: [deep] } as Root, '', 'deep.md')).toThrow(DocxQuotaError)
})

it('honors cancellation before/after async resource reads without mutating the model', async () => {
  const model = createDocxModel('![a](a.png)\n\n![b](b.png)', 'cancel.md')
  const controller = new AbortController(), load = vi.fn(async () => { controller.abort(); return imageBlob() })
  await expect(prepareDocxResources(model, load, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(load).toHaveBeenCalledTimes(1)
  expect(model.images.every(image => image.status === 'pending')).toBe(true)
  await expect(prepareDocxResources(model, load, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(load).toHaveBeenCalledTimes(1)
})

it('propagates resource-loader cancellation and hard quotas instead of offering placeholders', async () => {
  const model = createDocxModel('![a](a.png)', 'failure.md')
  await expect(prepareDocxResources(model, async () => { throw new DOMException('cancelled', 'AbortError') })).rejects.toMatchObject({ name: 'AbortError' })
  await expect(prepareDocxResources(model, async () => { throw Object.assign(new Error('quota'), { code: 'quota_exceeded' }) })).rejects.toMatchObject({ code: 'quota_exceeded' })
  expect(model.images[0].status).toBe('pending')
})

it('keeps invalid image bytes out of the output assets and makes placeholder acceptance explicit', async () => {
  const model = createDocxModel('![bad](a.png)', 'bad.md')
  const prepared = await prepareDocxResources(model, async () => new Blob(['<svg onload="evil()"/>'], { type: 'image/png' }))
  expect(prepared.assets).toHaveLength(0)
  expect(prepared.model.warnings.items.map(w => w.code)).toContain('invalid_image')
  expect(canGenerateDocx(prepared.model)).toBe(false)
  expect(canGenerateDocx(prepared.model, true)).toBe(true)
})
