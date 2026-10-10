import assert from 'node:assert/strict'
import { fillSource } from './source-test-utils.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { productionWorkers } from './production-workers.mjs'
import { serveProduction } from './serve-production.mjs'

const server = await serveProduction()
const { url } = server
let browser
let page
try {
  browser = await chromium.launch({ channel: process.env.EASYM_TEST_BROWSER || undefined })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('dialog', (dialog) => { void (dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss()) })
  await page.goto(url)
  await page.getByRole('button', { name: '分屏', exact: true }).click()
  await page.getByRole('heading', { name: '欢迎使用 EasyM', exact: true }).waitFor()

  const worker = (await productionWorkers()).find((source) => source.includes('createImageBitmap'))
  assert.ok(worker, 'Image worker exists in production bundle')
  const pixels = await page.evaluate(async (source) => {
    const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255]]
    function fixture(block, mime) {
      const canvas = new OffscreenCanvas(3 * block, 2 * block), ctx = canvas.getContext('2d')
      colors.forEach((color, index) => { ctx.fillStyle = `rgb(${color.join(',')})`; ctx.fillRect((index % 3) * block, Math.floor(index / 3) * block, block, block) })
      return canvas.convertToBlob({ type: mime, quality: 1 })
    }
    async function transform(blob, recipe) {
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
      const worker = new Worker(url)
      try {
        return await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Image verification timed out')), 15000)
          worker.onmessage = (event) => { clearTimeout(timeout); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data) }
          worker.onerror = (event) => { clearTimeout(timeout); reject(new Error(event.message)) }
          worker.postMessage({ source: blob, recipe })
        })
      } finally { worker.terminate(); URL.revokeObjectURL(url) }
    }
    async function sample(result, columns = result.width, rows = result.height) {
      const bitmap = await createImageBitmap(result.blob), canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d')
      ctx.drawImage(bitmap, 0, 0); bitmap.close()
      const values = []
      for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
        values.push([...ctx.getImageData(Math.floor((x + 0.5) * result.width / columns), Math.floor((y + 0.5) * result.height / rows), 1, 1).data])
      }
      return { width: result.width, height: result.height, mime: result.blob.type, values }
    }
    const recipe = { version: 1, orientationNormalized: true, rotateDegrees: 0, flipHorizontal: false, flipVertical: false, output: { mime: 'image/png' } }
    const png = await fixture(1, 'image/png'), jpeg = new Uint8Array(await (await fixture(16, 'image/jpeg')).arrayBuffer())
    const result = { png: {}, jpeg: [], failures: [] }
    for (const [name, options] of Object.entries({ identity: {}, rotate90: { rotateDegrees: 90 }, rotate180: { rotateDegrees: 180 }, rotate270: { rotateDegrees: 270 }, horizontal: { flipHorizontal: true }, vertical: { flipVertical: true }, transpose: { rotateDegrees: 90, flipHorizontal: true }, crop: { crop: { unit: 'sourcePixel', x: 1, y: 0, width: 2, height: 2 } } })) {
      result.png[name] = await sample(await transform(png, { ...recipe, ...options }))
    }
    result.resize = await sample(await transform(png, { ...recipe, resize: { width: 6, height: 4 } }), 3, 2)
    for (let orientation = 1; orientation <= 8; orientation++) {
      // Minimal EXIF/TIFF APP1 orientation tag, inserted after JPEG SOI.
      const exif = new Uint8Array([255,225,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,orientation,0,0,0,0,0,0,0])
      const blob = new Blob([jpeg.slice(0, 2), exif, jpeg.slice(2)], { type: 'image/jpeg' })
      const normalized = await transform(blob)
      result.jpeg.push(await sample(normalized, orientation <= 4 ? 3 : 2, orientation <= 4 ? 2 : 3))
      // Normalising the application source a second time must not apply EXIF twice.
      const twice = await transform(normalized.blob)
      if (twice.width !== normalized.width || twice.height !== normalized.height) throw new Error('EXIF applied twice')
    }
    const transparent = new OffscreenCanvas(1, 1)
    transparent.getContext('2d').clearRect(0, 0, 1, 1)
    const alpha = await transparent.convertToBlob({ type: 'image/png' })
    result.alpha = await sample(await transform(alpha, recipe))
    result.white = await sample(await transform(alpha, { ...recipe, output: { mime: 'image/jpeg' } }))
    for (const input of [new Blob(['invalid']), png]) {
      try { await transform(input, { ...recipe, crop: { unit: 'sourcePixel', x: 2, y: 0, width: 2, height: 1 } }); result.failures.push(false) }
      catch { result.failures.push(true) }
    }
    result.fixture = [...new Uint8Array(await png.arrayBuffer())]
    return result
  }, worker)
  const colors = [[255,0,0,255], [0,255,0,255], [0,0,255,255], [255,255,0,255], [0,255,255,255], [255,0,255,255]]
  const orientations = [[0,1,2,3,4,5], [2,1,0,5,4,3], [5,4,3,2,1,0], [3,4,5,0,1,2], [0,3,1,4,2,5], [3,0,4,1,5,2], [5,2,4,1,3,0], [2,5,1,4,0,3]]
  function checkPixels(actual, indexes, tolerance = 0) {
    assert.equal(actual.values.length, indexes.length)
    indexes.forEach((color, index) => colors[color].forEach((value, component) => assert.ok(Math.abs(actual.values[index][component] - value) <= tolerance, `Pixel ${index}/${component}: ${actual.values[index]} vs ${colors[color]}`)))
  }
  for (const [name, expected] of Object.entries({ identity: 0, rotate90: 5, rotate180: 2, rotate270: 7, horizontal: 1, vertical: 3, transpose: 4 })) checkPixels(pixels.png[name], orientations[expected])
  checkPixels(pixels.png.crop, [1,2,4,5])
  assert.deepEqual([pixels.resize.width, pixels.resize.height], [6,4])
  for (let i = 0; i < 8; i++) { checkPixels(pixels.jpeg[i], orientations[i], 24); assert.deepEqual([pixels.jpeg[i].width, pixels.jpeg[i].height], i < 4 ? [48,32] : [32,48]) }
  assert.deepEqual(pixels.alpha.values, [[0,0,0,0]])
  assert.deepEqual(pixels.white.values, [[255,255,255,255]])
  assert.deepEqual(pixels.failures, [true,true])

  const editor = page.getByRole('textbox', { name: 'Markdown 源码编辑器' })
  const bodyText = () => editor.evaluate((element) => [...element.querySelectorAll('.cm-line')].map((line) => line.textContent).join('\n'))
  await fillSource(page, '# 中文测试 😀\n\n未保存正文')
  await page.getByRole('heading', { name: '中文测试 😀' }).waitFor()
  const before = await bodyText()
  const upload = async () => {
    await page.locator('input[type=file]').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from(pixels.fixture) })
    await page.getByRole('dialog', { name: '编辑图片副本' }).waitFor()
  }
  await upload()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(await bodyText(), before)
  await upload()
  await page.getByLabel('Alt 文本', { exact: true }).fill('第一张')
  await page.getByRole('button', { name: '应用修改', exact: true }).click()
  await page.getByRole('dialog', { name: '编辑图片副本' }).waitFor({ state: 'hidden' })
  const once = await bodyText()
  assert.ok(once.includes('![第一张](assets/img-'))
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  assert.equal(await bodyText(), before)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  assert.equal(await bodyText(), once)
  await upload()
  await page.getByLabel('Alt 文本', { exact: true }).fill('第二张')
  await page.getByRole('button', { name: '应用修改', exact: true }).click()
  await page.getByRole('dialog', { name: '编辑图片副本' }).waitFor({ state: 'hidden' })
  const references = [...(await bodyText()).matchAll(/!\[[^\]]+\]\((assets\/[^)]+)\)/g)].map((item) => item[1])
  assert.equal(references.length, 2)
  assert.notEqual(references[0], references[1])
  const preview = page.getByRole('article', { name: 'Markdown 预览' })
  await preview.getByAltText('第二张', { exact: true }).waitFor()
  await preview.getByAltText('第一张', { exact: true }).dblclick()
  await page.getByRole('dialog', { name: '编辑图片副本' }).waitFor()
  await page.getByRole('button', { name: '旋转 90°', exact: true }).click()
  await page.getByRole('button', { name: '应用修改', exact: true }).click()
  await page.getByRole('dialog', { name: '编辑图片副本' }).waitFor({ state: 'hidden' })
  const updated = [...(await bodyText()).matchAll(/!\[[^\]]+\]\((assets\/[^)]+)\)/g)].map((item) => item[1])
  assert.notEqual(updated[0], references[0]); assert.equal(updated[1], references[1])
  const latestBody = await bodyText()
  const readDraft = () => page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('easym-drafts', 1)
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction('drafts'), get = tx.objectStore('drafts').get('current')
      tx.oncomplete = () => {
        const draft = get.result
        db.close(); resolve(draft ? { text: draft.text, alt: draft.imageSession?.alt } : null)
      }
      tx.onerror = () => { db.close(); reject(tx.error) }
    }
    open.onerror = () => reject(open.error)
  }))
  async function waitDraft(predicate) {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      if (predicate(await readDraft())) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('Expected draft was not committed to IndexedDB')
  }
  await waitDraft((draft) => draft?.text === latestBody)
  await page.reload()
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click()
  assert.ok((await bodyText()).includes(updated[0]))
  await page.getByRole('button', { name: '分屏', exact: true }).click()
  await preview.getByAltText('第二张', { exact: true }).waitFor()
  await preview.getByAltText('第二张', { exact: true }).dblclick()
  await page.getByLabel('Alt 文本', { exact: true }).fill('未应用草稿')
  await waitDraft((draft) => draft?.alt === '未应用草稿')
  await page.reload()
  await page.getByRole('button', { name: '恢复草稿', exact: true }).click()
  assert.equal(await page.getByLabel('Alt 文本', { exact: true }).inputValue(), '未应用草稿')
  assert.deepEqual(errors, [])
  await mkdir('test-results', { recursive: true })
  await writeFile('test-results/browser-verification.json', JSON.stringify({ browser: await browser.version(), platform: process.platform, verifiedAt: new Date().toISOString(), imageChecks: ['PNG pixels, crop, rotation, flips, resize', 'JPEG EXIF orientations 1–8 and normalisation', 'PNG transparency and JPEG white background', 'invalid input rejection'], editorChecks: ['Chinese/emoji text and preview', 'image cancel/apply/undo/redo', 'two instances and isolated edit', 'real IndexedDB body, assets and pending recipe recovery'] }, null, 2))
  console.log('Production browser verification passed: image pixels/EXIF and editor/image/draft flows.')
} catch (error) {
  if (page) {
    console.error(await page.locator('body').innerText())
    await mkdir('test-results', { recursive: true })
    await page.screenshot({ path: 'test-results/browser-failure.png', fullPage: true })
  }
  throw error
} finally {
  await browser?.close()
  await server.close()
}
