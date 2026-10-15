import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { generateDocx } from './docx'
import { createDocxModel, prepareDocxResources, type DocxBlock, type DocxInline } from './docx-model'

async function xml(bytes: ArrayBuffer) {
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url), zip = await createRequire(require.resolve('docx'))('jszip').loadAsync(bytes, { checkCRC32: true })
  const get = (path: string): Promise<string> => zip.file(path).async('string')
  return { zip, body: await get('word/document.xml'), styles: await get('word/styles.xml'), numbering: await get('word/numbering.xml'), rels: await get('word/_rels/document.xml.rels') }
}
function texts(blocks: DocxBlock[]): string[] {
  const runs = (nodes: DocxInline[]): string[] => nodes.flatMap(n => n.type === 'text' ? [n.text] : n.type === 'link' ? runs(n.children) : [])
  return blocks.flatMap(b => b.type === 'paragraph' || b.type === 'heading' ? runs(b.children) : b.type === 'quote' ? texts(b.children) : b.type === 'list' ? b.items.flatMap(i => texts(i.children)) : b.type === 'table' ? b.rows.flatMap(row => row.flatMap(c => runs(c.children))) : b.type === 'raw' || b.type === 'code' ? b.text.split(/\r?\n/) : [])
}
const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')

it('writes original inline/display formula source as editable text without claiming Word equations', async () => {
  const prepared = await prepareDocxResources(createDocxModel('正文 $E=mc^2$\n\n$$\n\\frac{1}{2}\n$$', '公式.md'), async () => { throw Error('no image') })
  const result = await xml(await generateDocx(prepared))
  expect(result.body).toContain('$E=mc^2$')
  expect(result.body).toContain('\\frac{1}{2}')
  expect(result.body).toContain('$$')
  expect(result.body).not.toContain('oMath')
})

it('writes editable superscript references and endnote content without native Word footnote claims', async () => {
  const prepared = await prepareDocxResources(createDocxModel('正文[^n] again[^n]\n\n[^n]: **脚注正文**', 'notes.md'), async () => { throw new Error('unused') })
  const result = await xml(await generateDocx(prepared))
  expect(result.body.match(/<w:vertAlign w:val="superscript"\/>/g)).toHaveLength(3)
  expect(result.body).toContain('脚注正文')
  expect(result.body).toContain('脚注')
  expect(result.body).not.toContain('<w:footnoteReference')
  // docx emits a structural footnotes part even when only the built-in
  // separators exist; document content must remain in the editable body.
  expect(await result.zip.file('word/footnotes.xml')!.async('string')).not.toContain('脚注正文')
})

it('generates every frozen sample text, editable structure and exact embedded display bytes', async () => {
  const text = readFileSync('Docs/samples/v0.3/办公导出.md', 'utf8'), png = readFileSync('Docs/samples/v0.3/assets/em.png')
  const prepared = await prepareDocxResources(createDocxModel(text, '办公.md'), async () => new Blob([png]))
  const before = structuredClone(prepared), result = await xml(await generateDocx(prepared))
  expect(prepared).toEqual(before)
  for (const t of texts(prepared.model.blocks)) expect(result.body).toContain(escape(t))
  for (const h of ['Heading1', 'Heading2', 'Heading3', 'Heading4', 'Heading5', 'Heading6', '<w:b', '<w:i', '<w:strike', '<w:numPr>', '<w:tblHeader', '<w:tblBorders', '☑', '☐', 'w:jc w:val="right"', 'w:jc w:val="center"']) expect(result.body).toContain(h)
  expect(result.numbering).toContain('w:start w:val="3"')
  expect(result.body).toContain('w:ilvl w:val="1"')
  expect(result.rels).toContain('https://github.com/SoleyRan/EasyM')
  const images = Object.keys(result.zip.files).filter(n => n.startsWith('word/media/') && !result.zip.files[n].dir)
  expect(images).toHaveLength(1)
  expect(new Uint8Array(await result.zip.file(images[0]).async('arraybuffer'))).toEqual(new Uint8Array(png))
  expect(result.body.match(/<wp:extent cx="1219200" cy="1219200"/g)).toHaveLength(2)
  expect(result.body).toContain('w:top="1134"')
  expect(result.styles).toContain('w:eastAsia="Microsoft YaHei"')
})

it('requires explicit placeholders and preserves all unsupported content as inert text', async () => {
  const prepared = await prepareDocxResources(createDocxModel(readFileSync('Docs/samples/v0.3/降级与安全.md', 'utf8'), '安全.md'), async () => { throw new Error('missing') })
  await expect(generateDocx(prepared)).rejects.toThrow('图片预检')
  const result = await xml(await generateDocx(prepared, { page: 'letter', style: 'compact', allowImagePlaceholders: true }))
  for (const t of texts(prepared.model.blocks)) expect(result.body).toContain(escape(t))
  expect(result.body).toContain('[图片：缺失图片（未嵌入）]')
  expect(result.body).toContain('w:w="12240" w:h="15840"')
  expect(result.rels).not.toMatch(/javascript:|file:\/\/|example.invalid/)
  expect(Object.keys(result.zip.files)).not.toEqual(expect.arrayContaining([expect.stringMatching(/vba|oleObject|embeddings/)]))
})

it('keeps independent list restarts, deep static markers, long cells and code editable across pages', async () => {
  const nested = Array.from({ length: 11 }, (_, i) => '  '.repeat(i) + '- level' + i).join('\n')
  const prepared = await prepareDocxResources(createDocxModel(`3. first\n\nparagraph\n\n7. next\n\n${nested}\n\n| long |\n| --- |\n| ${'长'.repeat(600)} |\n\n\`\`\`\n  ${'abcdef'.repeat(200)}\n\`\`\``, '长.md'), async () => { throw new Error('unused') })
  const result = await xml(await generateDocx(prepared))
  expect(result.numbering).toContain('w:start w:val="3"')
  expect(result.numbering).toContain('w:start w:val="7"')
  expect(result.body).toContain('• ')
  expect(result.body).toContain('level10')
  expect(result.body).toContain('w:keepLines w:val="false"')
  expect(result.body).toContain('w:cantSplit w:val="off"')
  expect(result.body).toContain('  abcdef')
})

it('preserves headings in lists and cannot bypass image limits with placeholder permission', async () => {
  const prepared = await prepareDocxResources(createDocxModel('- # nested heading\n\n![image](assets/em.png)', 'nested.md'), async () => new Blob([readFileSync('Docs/samples/v0.3/assets/em.png')]))
  expect((await xml(await generateDocx(prepared))).body).toContain('w:pStyle w:val="Heading1"')
  prepared.assets[0].width = 9000
  await expect(generateDocx(prepared, { page: 'a4', style: 'default', allowImagePlaceholders: true })).rejects.toMatchObject({ code: 'quota_exceeded' })
})
