import assert from 'node:assert/strict'
import { fillSource } from './source-test-utils.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { serveProduction } from './serve-production.mjs'

const server = await serveProduction()
let browser, page
try {
  browser = await chromium.launch({ channel: process.env.EASYM_TEST_BROWSER || undefined })
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = [], requests = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (request.url().startsWith('https://remote.example/')) requests.push(request.url()) })
  page.on('dialog', dialog => { void dialog.dismiss() })
  await page.goto(server.url)
  const editor = page.getByRole('textbox', { name: 'Markdown 源码编辑器' })
  const sourceText = () => editor.evaluate(element => [...element.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'))
  const source = async () => { await page.getByRole('button', { name: '源码', exact: true }).click(); return sourceText() }
  const live = () => page.getByRole('button', { name: '即时渲染', exact: true }).click()
  const checks = []
  async function point(lineText, offset) {
    return editor.evaluate((element, { lineText, offset }) => {
      const line = [...element.querySelectorAll('.cm-line')].find(line => line.textContent === lineText)
      if (!line) throw new Error(`Visible line not found: ${lineText}`)
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (offset > node.length) { offset -= node.length; continue }
        const range = document.createRange(); range.setStart(node, offset); range.collapse(true)
        const rect = range.getBoundingClientRect()
        return { x: rect.x, y: rect.y + rect.height / 2 }
      }
      throw new Error('Selection offset outside visible text')
    }, { lineText, offset })
  }
  async function drag(start, end) {
    await page.mouse.move(start.x, start.y); await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 20 }); await page.mouse.up()
  }
  const bold = page.getByRole('button', { name: '加粗', exact: true })
  const undo = () => page.getByRole('button', { name: '撤销', exact: true }).click()
  const redo = () => page.getByRole('button', { name: '重做', exact: true }).click()
  const text = '# 中文标题\n\n**加粗**、*斜体*、~~删除~~、`行内代码` 和 [链接](https://example.com)\n\n- 列表\n- [x] 已完成\n\n> 引用\n\n```javascript\nconst answer = 42;\n```\n\n| A | B |\n| - | - |\n| 中文 | 2 |\n\n![远程图片](https://remote.example/a.png)\n\n最后一行'
  await fillSource(page, text)
  await live()
  await page.locator('.live-block-code').waitFor()
  await page.locator('.live-block-table table').waitFor()
  const tableGap = await page.locator('.live-block-table').evaluate(element => element.querySelector('tbody').getBoundingClientRect().top - element.querySelector('thead').getBoundingClientRect().bottom)
  assert.ok(Math.abs(tableGap) < 2, 'Rendered table rows are contiguous without inherited source whitespace')
  await page.locator('.live-block-image img').waitFor()
  assert.equal(await page.locator('.live-heading').textContent(), '中文标题')
  assert.equal(await page.locator('.live-strong').textContent(), '加粗')
  assert.equal(await page.locator('.live-emphasis').textContent(), '斜体')
  assert.equal(await page.locator('.live-strike').textContent(), '删除')
  assert.equal(await page.locator('.live-block-code .hljs-keyword').textContent(), 'const')
  assert.equal(await page.locator('.live-block-image img').getAttribute('src'), null)
  await mkdir('test-results', { recursive: true })
  await page.screenshot({ path: 'test-results/live-preview-light.png' })
  checks.push('headings/inline formatting, language highlighting, tables, remote images blocked')
  assert.equal(await source(), text, 'View roundtrip preserves the original Markdown')
  await editor.press('Control+Home')
  await live()
  assert.equal(await page.locator('.live-heading').count(), 0, 'Active heading keeps its source markers')
  assert.equal(await editor.locator('.cm-line').first().textContent(), '# 中文标题')
  await page.getByRole('button', { name: '显示代码块源码' }).click()
  await page.waitForFunction(() => !document.querySelector('.live-block-code'))
  assert.equal(await page.getByRole('button', { name: '代码块', exact: true }).getAttribute('aria-pressed'), 'true')
  assert.equal(await source(), text)
  checks.push('active heading and code source reveal; exact source roundtrip')
  // Selection crosses concealed markers using real pointer events. Presentation
  // stays fixed while dragging, then source markers are exposed on release.
  await editor.evaluate(element => { element.dataset.testIdentity = 'same-editor' })
  const formatted = '前缀 **加粗文字** 后缀\n\n末尾'
  for (const reverse of [false, true]) {
    await fillSource(page, formatted); await live()
    await page.locator('.live-strong').waitFor()
    const start = await point('前缀 加粗文字 后缀', 3), end = await point('前缀 加粗文字 后缀', 7)
    await drag(reverse ? end : start, reverse ? start : end)
    assert.equal(await bold.getAttribute('aria-pressed'), 'true')
    await bold.click()
    assert.equal(await source(), '前缀 加粗文字 后缀\n\n末尾', 'Selected rendered bold toggles off without losing text')
    await live(); await undo()
    assert.equal(await source(), formatted, 'Undo survives live/source changes')
    await page.getByRole('button', { name: '分屏', exact: true }).click(); await redo()
    assert.equal(await source(), '前缀 加粗文字 后缀\n\n末尾')
    assert.equal(await editor.getAttribute('data-test-identity'), 'same-editor')
  }
  checks.push('forward/reverse native mouse selection across hidden markers; format state/toggle; shared editor and undo across three views')
  const multiline = '前缀 中文🙂选择 后缀\n第二行原文\n\n末尾'
  await fillSource(page, multiline); await live()
  await drag(await point('前缀 中文🙂选择 后缀', 3), await point('第二行原文', 3))
  await page.getByRole('button', { name: '引用', exact: true }).click()
  assert.equal(await source(), '> 前缀 中文🙂选择 后缀\n> 第二行原文\n\n末尾')
  const wrapped = '中文 soft wrap words🙂 '.repeat(25)
  await fillSource(page, wrapped + '\n\n末尾'); await live()
  const from = 5, to = wrapped.indexOf('中文', 120)
  await drag(await point(wrapped, from), await point(wrapped, to))
  await bold.click()
  assert.equal(await source(), wrapped.slice(0, from) + '**' + wrapped.slice(from, to).trimEnd() + '**' + wrapped.slice(from + wrapped.slice(from, to).trimEnd().length) + '\n\n末尾')
  checks.push('Chinese/emoji cross-line and soft-wrap pointer selections apply only selected text')
  await fillSource(page, text); await live()
  await page.locator('.live-block-table td').first().click()
  await page.waitForFunction(() => !document.querySelector('.live-block-table'))
  assert.ok((await editor.textContent()).includes('| 中文 | 2 |'))
  await editor.press('Control+End')
  await page.locator('.live-block-table').waitFor()
  // The accessible source button provides deterministic keyboard navigation
  // into a rendered block; clicking it was verified above for code.
  await editor.press('Control+Home')
  await page.getByRole('button', { name: '查找 / 替换', exact: true }).click()
  const search = page.getByRole('search', { name: '文档内查找与替换' })
  await search.getByRole('textbox', { name: '查找文本' }).fill('answer')
  await search.getByText('0 / 1 项', { exact: true }).waitFor()
  await search.getByRole('textbox', { name: '查找文本' }).press('Enter')
  await page.waitForFunction(() => !document.querySelector('.live-block-code'))
  await search.getByRole('textbox', { name: '替换为' }).fill('result')
  await search.getByRole('button', { name: '替换当前项' }).click()
  await search.getByRole('button', { name: '关闭查找' }).click()
  assert.equal(await source(), text.replace('answer', 'result'))
  await live(); await undo(); assert.equal(await source(), text)
  checks.push('table click and keyboard entry expose source; live search reveals hidden code and replaces with undo')
  await live(); await editor.focus()
  await editor.dispatchEvent('compositionstart', { data: '中' })
  assert.equal(await page.locator('.cm-live-preview').count(), 0)
  await page.getByRole('button', { name: '源码', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: '即时渲染', exact: true }).getAttribute('class'), 'selected')
  await editor.dispatchEvent('compositionend', { data: '中文' })
  await page.waitForFunction(() => !!document.querySelector('.cm-live-preview'))
  assert.equal(await source(), text)
  checks.push('synthetic composition pauses presentation and guards mode changes (native IME still requires desktop testing)')
  // Imported local resources resolve to managed object URLs, and double-click
  // edits the correct instance without forcing the live view back to split.
  await fillSource(page, '图片文档\n\n')
  await live()
  const fixture = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 40; canvas.height = 30
    const context = canvas.getContext('2d'); context.fillStyle = '#4383cc'; context.fillRect(0, 0, 40, 30)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  await page.locator('input[type=file]').setInputFiles({ name: 'live.png', mimeType: 'image/png', buffer: Buffer.from(fixture, 'base64') })
  await page.getByLabel('Alt 文本', { exact: true }).fill('即时图片')
  await page.getByRole('button', { name: '应用修改', exact: true }).click()
  await page.getByRole('dialog', { name: '编辑图片副本' }).waitFor({ state: 'hidden' })
  assert.equal(await page.getByRole('button', { name: '即时渲染', exact: true }).getAttribute('class'), 'selected')
  await editor.press('Control+End'); await editor.press('Enter'); await editor.press('Enter'); await editor.press('t')
  const localImage = page.locator('.live-block-image img')
  await page.waitForFunction(() => document.querySelector('.live-block-image img')?.src.startsWith('blob:'))
  await localImage.dblclick()
  assert.equal(await page.getByLabel('Alt 文本', { exact: true }).inputValue(), '即时图片')
  await page.getByRole('button', { name: '取消', exact: true }).click()
  const imageSource = await source()
  assert.ok(imageSource.includes('![即时图片](assets/img-'))
  await live(); await localImage.dblclick()
  await page.getByLabel('Alt 文本', { exact: true }).fill('已修改即时图片')
  await page.getByRole('button', { name: '应用修改', exact: true }).click()
  await page.getByRole('dialog', { name: '编辑图片副本' }).waitFor({ state: 'hidden' })
  assert.equal(await page.getByRole('button', { name: '即时渲染', exact: true }).getAttribute('class'), 'selected')
  assert.ok((await source()).includes('![已修改即时图片](assets/img-'))
  await live(); await page.getByRole('button', { name: '显示图片源码' }).click()
  await page.waitForFunction(() => !document.querySelector('.live-block-image'))
  checks.push('local image blob resource, correct double-click edit, cancel/apply and source reveal; live view retained')
  const unknown = '---\ntitle: **原始**\n---\n\n<custom data-x="原样">\n<script>window.UNSAFE=true</script>\n</custom>\n\n未知 {{token}}\n\n末尾'
  await source(); await fillSource(page, unknown); await live()
  assert.equal(await source(), unknown)
  assert.equal(await page.evaluate(() => window.UNSAFE), undefined)
  checks.push('front matter, unknown syntax and raw HTML preserve source without execution')
  await fillSource(page, 'x'.repeat(20_001)); await live()
  assert.equal(await page.locator('.cm-live-preview').count(), 0)
  assert.ok((await page.locator('.statusbar').textContent()).includes('即时渲染已降级为源码'))
  await fillSource(page, ('a'.repeat(1500) + '\n').repeat(700))
  assert.equal(await page.locator('.cm-live-preview').count(), 0)
  assert.ok((await page.locator('.statusbar').textContent()).includes('即时渲染已降级为源码'))
  await fillSource(page, text)
  await page.locator('.live-block-code').waitFor()
  checks.push('oversized documents and long lines degrade explicitly to source; shortening restores rendering')
  for (const theme of ['清爽浅色', '午夜深色', '暖纸', '护眼绿']) {
    await page.getByRole('button', { name: 'EM 菜单', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Style · 配色主题' }).click()
    await page.getByRole('menuitemradio', { name: theme }).click()
    const cell = page.locator('.live-block-table td').first()
    assert.equal(await cell.evaluate(element => getComputedStyle(element).borderTopWidth), '1px')
    const colors = await page.locator('.live-block-code pre').evaluate(element => ({ background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color }))
    assert.notEqual(colors.background, colors.color)
    if (theme === '午夜深色') await page.screenshot({ path: 'test-results/live-preview-dark.png' })
  }
  await page.getByRole('button', { name: '新建标签', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: '源码', exact: true }).getAttribute('class'), 'selected')
  await fillSource(page, '独立标签'); await page.getByRole('tab').first().click()
  assert.equal(await page.getByRole('button', { name: '即时渲染', exact: true }).getAttribute('class'), 'selected')
  assert.equal(await source(), text)
  checks.push('four theme table/code styles; tab view and text independence')
  assert.deepEqual(errors, [])
  assert.deepEqual(requests, [])
  await mkdir('test-results', { recursive: true })
  await writeFile('test-results/live-preview-verification.json', JSON.stringify({ verifiedAt: new Date().toISOString(), browser: await browser.version(), passed: true, checks }, null, 2) + '\n')
  console.log('Live preview verification passed: inline/blocks, source roundtrip and safe image handling.')
} catch (error) {
  await mkdir('test-results', { recursive: true })
  await page?.screenshot({ path: 'test-results/live-preview-failure.png' })
  console.error(await page?.locator('.error-banner').allTextContents())
  throw error
} finally {
  await browser?.close()
  await server.close()
}
