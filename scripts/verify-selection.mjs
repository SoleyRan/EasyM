import assert from 'node:assert/strict'
import { fillSource } from './source-test-utils.mjs'

// Drive native mouse selection, rather than setting DOM/editor selections.
export async function verifySelection(page, selectTheme) {
  const editor = page.getByRole('textbox', { name: 'Markdown 源码编辑器' })
  const body = () => editor.evaluate(element => [...element.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'))
  async function point(offset) {
    return editor.evaluate((element, offset) => {
      for (const line of element.querySelectorAll('.cm-line')) {
        if (offset > line.textContent.length) { offset -= line.textContent.length + 1; continue }
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (offset > node.length) { offset -= node.length; continue }
          const range = document.createRange()
          range.setStart(node, offset); range.collapse(true)
          const rect = range.getBoundingClientRect()
          return { x: rect.x, y: rect.y + rect.height / 2, height: rect.height }
        }
      }
      throw new Error('Mouse selection offset is outside rendered text')
    }, offset)
  }
  async function select(text, from, to) {
    const start = await point(from), end = await point(to)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 20 })
    await page.mouse.up()
    await page.waitForFunction(selected => window.getSelection()?.toString() === selected, text.slice(Math.min(from, to), Math.max(from, to)))
    await page.locator('.cm-selectionBackground').first().waitFor()
  }
  async function pixel(point) {
    const png = await page.screenshot({ clip: { x: Math.floor(point.x + 2), y: Math.floor(point.y + point.height / 2 - 2), width: 1, height: 1 } })
    return page.evaluate(async bytes => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }))
      const canvas = new OffscreenCanvas(1, 1), context = canvas.getContext('2d')
      context.drawImage(bitmap, 0, 0); bitmap.close()
      return [...context.getImageData(0, 0, 1, 1).data]
    }, [...png])
  }

  const text = '前缀 中文选择 words🙂 后缀\n第二行保留原文'
  const from = 3, to = text.indexOf(' 后缀')
  for (const theme of ['light', 'dark', 'paper', 'forest']) {
    await selectTheme(theme)
    for (const mode of ['源码', '分屏']) {
      await page.getByRole('button', { name: mode, exact: true }).click()
      await fillSource(page, text)
      await editor.press('Control+Home')
      const sample = await point(from), before = await pixel(sample)
      await select(text, from, to)
      const after = await pixel(sample)
      assert.ok(after.slice(0, 3).some((value, index) => Math.abs(value - before[index]) > 12), `${theme}/${mode}: selected text must be visibly highlighted on the active line`)
      assert.equal(await page.locator('.cm-selectionBackground').first().evaluate(element => getComputedStyle(element).backgroundColor), await page.locator('.application').evaluate(element => {
        const probe = document.createElement('span'); probe.style.background = 'var(--selection)'; element.append(probe)
        const color = getComputedStyle(probe).backgroundColor; probe.remove(); return color
      }))
      await page.getByRole('button', { name: '加粗', exact: true }).click()
      const bold = text.slice(0, from) + '**' + text.slice(from, to) + '**' + text.slice(to)
      assert.equal(await body(), bold, 'Toolbar formats only the mouse-selected range')
      const boldButton = page.getByRole('button', { name: '加粗', exact: true })
      assert.equal(await boldButton.getAttribute('aria-pressed'), 'true')
      const pressed = await boldButton.evaluate(element => getComputedStyle(element).boxShadow)
      assert.notEqual(pressed, 'none', 'Active formatting is visually indicated')
      await boldButton.click()
      assert.equal(await body(), text, 'Second click removes bold rather than nesting markers')
      assert.equal(await boldButton.getAttribute('aria-pressed'), 'false')
      await page.getByRole('button', { name: '撤销', exact: true }).click()
      assert.equal(await body(), bold)
      assert.equal(await boldButton.getAttribute('aria-pressed'), 'true')
      await page.getByRole('button', { name: '重做', exact: true }).click()
      assert.equal(await body(), text)
      assert.equal(await boldButton.getAttribute('aria-pressed'), 'false')
      await fillSource(page, text)
      await select(text, to, from)
      await page.getByRole('button', { name: '斜体', exact: true }).click()
      assert.equal(await body(), text.slice(0, from) + '*' + text.slice(from, to) + '*' + text.slice(to), 'Reverse mouse selection is preserved')
      assert.equal(await page.getByRole('button', { name: '斜体', exact: true }).getAttribute('aria-pressed'), 'true')
      await page.getByRole('button', { name: '斜体', exact: true }).click()
      assert.equal(await body(), text)
      await fillSource(page, text)
      await select(text, from, to)
      // Keyboard activation must use the same range after focus leaves the editor.
      await page.getByRole('button', { name: '链接', exact: true }).focus()
      await page.keyboard.press('Enter')
      assert.equal(await body(), text.slice(0, from) + '[' + text.slice(from, to) + '](https://example.com)' + text.slice(to))
      assert.equal(await page.getByRole('button', { name: '链接', exact: true }).getAttribute('aria-pressed'), 'true')
      await page.getByRole('button', { name: '链接', exact: true }).click()
      assert.equal(await body(), text)
      await fillSource(page, text)
      await select(text, from, text.length - 2)
      await page.getByRole('button', { name: '引用', exact: true }).click()
      assert.equal(await body(), '> ' + text.replace('\n', '\n> '), 'Multiline commands affect selected lines without losing text')
      assert.equal(await page.getByRole('button', { name: '引用', exact: true }).getAttribute('aria-pressed'), 'true')
      await page.getByRole('button', { name: '引用', exact: true }).click()
      assert.equal(await body(), text)
      for (const format of ['标题', '无序列表', '有序列表', '任务列表']) {
        await fillSource(page, text)
        await select(text, from, to)
        const button = page.getByRole('button', { name: format, exact: true })
        await button.click()
        assert.equal(await button.getAttribute('aria-pressed'), 'true', `${format} applied`)
        await button.click()
        assert.equal(await body(), text, `${format} cancelled without stacking`)
        assert.equal(await button.getAttribute('aria-pressed'), 'false')
      }
      const codeText = 'code text\n'
      await fillSource(page, codeText)
      await select(codeText, 0, codeText.length - 1)
      const codeButton = page.getByRole('button', { name: '代码块', exact: true })
      await codeButton.click()
      assert.equal(await codeButton.getAttribute('aria-pressed'), 'true')
      await codeButton.click()
      assert.equal(await body(), codeText)
      assert.equal(await codeButton.getAttribute('aria-pressed'), 'false')
      const mixed = '**bold** plain'
      await fillSource(page, mixed)
      await select(mixed, 0, mixed.length)
      assert.equal(await boldButton.getAttribute('aria-pressed'), 'mixed')
      await boldButton.click()
      assert.equal(await body(), '**bold plain**')
      assert.equal(await boldButton.getAttribute('aria-pressed'), 'true')
      await editor.press('Control+End')
      assert.equal(await boldButton.getAttribute('aria-pressed'), 'false', 'Caret outside formatting clears pressed state')
    }
  }
  // Exercise a native drag across visual wraps in a single physical line.
  const wrapped = '中文 soft wrap words🙂 '.repeat(30)
  await fillSource(page, wrapped)
  await editor.press('Control+Home')
  await select(wrapped, 5, wrapped.indexOf('中文', 120))
  const selected = await page.evaluate(() => window.getSelection().toString())
  await page.getByRole('button', { name: '加粗', exact: true }).click()
  const content = selected.trimEnd()
  assert.equal(await body(), wrapped.slice(0, 5) + '**' + content + '**' + wrapped.slice(5 + content.length))
  assert.equal(await page.getByRole('button', { name: '加粗', exact: true }).getAttribute('aria-pressed'), 'true')
  await page.getByRole('button', { name: '加粗', exact: true }).click()
  assert.equal(await body(), wrapped)
  await selectTheme('light')
  return ['native mouse selection visible in four themes and source/split views', 'forward/reverse Chinese and emoji selection; multiline and soft-wrapped selection', 'selected-range toolbar toggles, keyboard activation and undo/redo', 'bold/italic/link/heading/lists/quote/code cancel without stacking; pressed/mixed state follows selection and undo']
}
