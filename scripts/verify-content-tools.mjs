import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { serveProduction, acknowledgeGuide, selectAppearanceTheme } from './serve-production.mjs'
import { fillSource } from './source-test-utils.mjs'

const server = await serveProduction(), report = { passed: false, checks: [], scope: 'Production Chromium mouse/keyboard; synthetic composition events verify guards, real IME/native URL launch require manual testing.' }
let browser, page
await mkdir('test-results/content-tools', { recursive: true })
try {
  browser = await chromium.launch({ channel: process.env.EASYM_TEST_BROWSER || undefined }); report.browser = browser.version()
  page = await browser.newPage({ viewport: { width: 1120, height: 800 } })
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await acknowledgeGuide(page); await page.goto(server.url)
  const source = () => page.locator('.document-panel:not([hidden])').getByRole('textbox', { name: 'Markdown 源码编辑器' })
  const body = () => source().evaluate(node => [...node.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'))
  const fixed = page.getByRole('toolbar', { name: '格式工具栏', exact: true })
  const floating = page.getByRole('toolbar', { name: '选区格式工具栏', exact: true })
  const selectLine = async () => { await source().press('ControlOrMeta+Home'); await source().press('Shift+End'); await floating.waitFor() }
  const undo = async () => { await fixed.getByRole('button', { name: '撤销', exact: true }).click() }
  const drag = async () => {
    const points = await source().locator('.cm-line').first().evaluate(line => {
      const nodes = []; const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT); for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n)
      const a = document.createRange(), b = document.createRange(); a.setStart(nodes[0], 0); a.setEnd(nodes[0], 1); const last = nodes.at(-1); b.setStart(last, last.length - 1); b.setEnd(last, last.length)
      const x = a.getBoundingClientRect(), y = b.getBoundingClientRect(); return { start: { x: x.left + .2, y: x.top + x.height / 2 }, end: { x: y.right - .2, y: y.top + y.height / 2 } }
    })
    await page.mouse.move(points.start.x, points.start.y); await page.mouse.down(); await page.mouse.move(points.end.x, points.end.y, { steps: 12 })
    assert.equal(await floating.count(), 0); await page.mouse.up(); await floating.waitFor()
  }
  await fillSource(page, 'hello world'); await drag()
  assert.equal(await source().evaluate(node => node === document.activeElement), true)
  await floating.getByRole('button', { name: '加粗', exact: true }).click(); await floating.waitFor()
  assert.equal(await body(), '**hello world**'); assert.equal(await floating.getByRole('button', { name: '加粗' }).getAttribute('aria-pressed'), 'true')
  await floating.getByRole('button', { name: '加粗' }).click(); assert.equal(await body(), 'hello world')
  await undo(); assert.equal(await body(), '**hello world**'); await source().press('ControlOrMeta+Home'); await source().press('Shift+End'); await floating.waitFor()
  await source().press('Alt+F10'); assert.equal(await floating.getByRole('button', { name: '加粗' }).evaluate(node => node === document.activeElement), true)
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter'); assert.match(await body(), /\*/)
  await source().press('ControlOrMeta+Home'); await source().press('Shift+End'); await floating.waitFor(); await source().press('Alt+F10'); await page.keyboard.press('Escape'); await floating.waitFor({ state: 'detached' }); assert.equal(await source().evaluate(node => node === document.activeElement), true)
  report.checks.push('real drag is passive until release; selection retained, toggle, pressed state, undo and Alt+F10 navigation')

  await fillSource(page, '~~one~~ plain ~~two~~'); await selectLine()
  assert.equal(await floating.getByRole('button', { name: '删除线' }).getAttribute('aria-pressed'), 'mixed')
  await floating.getByRole('button', { name: '删除线' }).click(); assert.equal(await body(), '~~one plain two~~')
  await fillSource(page, 'hello'); await selectLine(); await floating.getByRole('button', { name: '行内代码' }).click(); assert.equal(await body(), '`hello`')
  await floating.waitFor(); await floating.getByRole('button', { name: '行内代码' }).click(); assert.equal(await body(), 'hello')
  await source().press('x'); await floating.waitFor({ state: 'detached' }); assert.equal(await body(), 'x')
  await fillSource(page, 'one\ntwo'); await source().press('ControlOrMeta+a'); await page.waitForTimeout(220); assert.equal(await floating.count(), 0)
  await fillSource(page, '```js\nhello\n```'); await source().press('ControlOrMeta+Home'); await source().press('ArrowDown'); await source().press('Shift+End'); await page.waitForTimeout(220); assert.equal(await floating.count(), 0)
  report.checks.push('mixed strike and inline code toggles; typing hides selection tools; multiline/code cannot be misformatted')

  await fillSource(page, '**中文**'); await selectLine(); await floating.getByRole('button', { name: '链接' }).click()
  const link = page.getByRole('dialog', { name: '插入 / 编辑链接', exact: true })
  assert.equal(await link.getByLabel('链接显示文字').inputValue(), '**中文**'); assert.equal(await link.getByLabel('链接地址').inputValue(), '')
  await link.getByLabel('链接地址').fill('https://example.com'); await link.getByRole('button', { name: '取消', exact: true }).click(); assert.equal(await body(), '**中文**')
  await source().press('ControlOrMeta+k'); await link.waitFor(); await link.getByLabel('链接地址').fill('javascript:alert(1)'); await link.getByRole('button', { name: '确认链接' }).click(); await link.getByRole('alert').waitFor(); assert.equal(await body(), '**中文**')
  await link.getByLabel('链接地址').fill('https://example.com'); await link.getByRole('button', { name: '确认链接' }).click(); assert.equal(await body(), '[**中文**](<https://example.com>)')
  await undo(); assert.equal(await body(), '**中文**')
  const reference = '[**label**][id]\n\n[other][id]\n\n[id]: https://example.com'
  await fillSource(page, reference); await source().press('ControlOrMeta+Home'); await source().press('ArrowRight'); await source().press('ControlOrMeta+k'); await link.waitFor()
  assert.match(await link.innerText(), /仅将此处引用链接/); await link.getByRole('button', { name: '解除链接' }).click(); assert.equal(await body(), reference.replace('[**label**][id]', '**label**'))
  report.checks.push('link prefill with empty address, cancel, unsafe rejection, nested label, reference unlink and atomic undo')

  await fillSource(page, '# 中文标题\n\n[go](#中文标题)'); await page.getByRole('button', { name: '分屏', exact: true }).click(); await page.getByRole('link', { name: 'go', exact: true }).click(); await link.waitFor(); await link.getByRole('button', { name: '打开现有地址' }).click(); await link.waitFor({ state: 'detached' })
  assert.equal(await source().evaluate(node => window.getSelection()?.anchorNode && node.contains(window.getSelection().anchorNode)), true)
  await fillSource(page, '~~~~odd/lang metadata\nconst answer = 42\n~~~~\n\nend'); const language = page.getByRole('dialog', { name: '选择代码语言', exact: true })
  await page.locator('.preview-language-button', { hasText: 'odd/lang' }).click(); await language.waitFor(); assert.match(await language.innerText(), /自定义，保留原标记/)
  await language.getByLabel('搜索代码语言').fill('数据'); await language.getByRole('button', { name: /JSON 数据\s*json/ }).click(); await language.getByRole('button', { name: '应用语言' }).click()
  assert.equal(await body(), '~~~~json metadata\nconst answer = 42\n~~~~\n\nend'); await undo(); assert.match(await body(), /^~~~~odd\/lang metadata/)
  await page.locator('.preview-language-button', { hasText: 'odd/lang' }).waitFor(); assert.equal(await page.locator('.preview pre .hljs-keyword').count(), 0)
  await page.locator('.preview-language-button').click(); await language.getByLabel('搜索代码语言').fill('javascript'); await language.getByRole('button', { name: /JavaScript\s*javascript/ }).click(); await language.getByRole('button', { name: '应用语言' }).click(); await page.locator('.preview pre .hljs-keyword').first().waitFor()
  await page.locator('.preview-language-button', { hasText: 'javascript' }).click(); await language.getByRole('button', { name: '无语言', exact: true }).click(); await language.getByRole('button', { name: '应用语言' }).click(); assert.equal(await body(), '~~~~\nconst answer = 42\n~~~~\n\nend'); await undo(); await undo(); assert.match(await body(), /^~~~~odd\/lang metadata/)
  await page.getByRole('button', { name: '即时渲染', exact: true }).click(); await source().press('ControlOrMeta+End'); await page.locator('.live-language-button').waitFor(); assert.equal(await page.locator('.live-language-button').innerText(), '语言：odd/lang')
  await page.locator('.live-language-button').click(); await language.waitFor(); await language.getByRole('button', { name: '取消', exact: true }).click()
  report.checks.push('split link click/edit and heading anchor open; preview/live language tags, Chinese search, unknown preservation, info-only patch and undo')

  await page.getByRole('button', { name: '源码', exact: true }).click()
  // Mode changes can redraw CodeMirror's DOM selection. Select through its
  // keyboard command so this fixture replaces the document in editor state.
  await source().press('ControlOrMeta+a'); await page.keyboard.insertText('## **heading**\n\nkeep')
  assert.equal(await body(), '## **heading**\n\nkeep'); await source().press('ControlOrMeta+Home')
  await fixed.getByRole('button', { name: '转换为', exact: true }).click(); const paragraph = page.getByRole('dialog', { name: '转换为', exact: true }); await paragraph.waitFor()
  assert.match(await paragraph.innerText(), /第 1–1 行/); await paragraph.getByLabel('转换段落类型').selectOption('task'); await paragraph.getByRole('button', { name: '应用转换' }).click(); assert.equal(await body(), '- [ ] **heading**\n\nkeep'); await undo(); assert.equal(await body(), '## **heading**\n\nkeep')
  report.checks.push('paragraph target explanation, structural conversion preserving inline syntax, and one undo')

  await fillSource(page, 'hello'); await selectLine(); await source().dispatchEvent('compositionstart', { data: '中' }); await floating.waitFor({ state: 'detached' }); await source().press('ControlOrMeta+k'); assert.equal(await link.count(), 0); await source().dispatchEvent('compositionend', { data: '中' })
  await source().press('ArrowLeft'); await source().press('ControlOrMeta+k'); await link.waitFor(); await link.getByLabel('链接显示文字').dispatchEvent('compositionstart', { data: '中' }); await link.getByRole('button', { name: '取消', exact: true }).click(); assert.equal(await link.count(), 1); await link.getByLabel('链接显示文字').dispatchEvent('compositionend', { data: '中' }); await page.keyboard.press('Escape'); await link.waitFor({ state: 'detached' })
  report.checks.push('composition guards prevent selection actions and modal cancel until completion')

  for (const theme of ['light', 'dark', 'paper', 'forest']) {
    await selectAppearanceTheme(page, theme); await fillSource(page, 'hello'); await selectLine(); await page.screenshot({ path: `test-results/content-tools/${theme}.png` })
    const bounds = await floating.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 1120)
  }
  await page.setViewportSize({ width: 760, height: 600 }); await fillSource(page, 'hello'); await selectLine(); const bounds = await floating.boundingBox(); assert.ok(bounds.x + bounds.width <= 760); await page.screenshot({ path: 'test-results/content-tools/compact.png' })
  await page.getByRole('button', { name: 'EM 菜单', exact: true }).click(); await page.getByRole('menuitem', { name: '设置', exact: true }).click(); const settings = page.getByRole('dialog', { name: '设置', exact: true }); await settings.getByLabel('显示选区浮动工具栏').uncheck(); await settings.getByRole('button', { name: '完成', exact: true }).click(); await fillSource(page, 'hello'); await source().press('ControlOrMeta+a'); await page.waitForTimeout(220); assert.equal(await floating.count(), 0); assert.equal(await fixed.count(), 1)
  await page.reload(); await page.getByRole('button', { name: '恢复草稿', exact: true }).click(); await fillSource(page, 'hello'); await source().press('ControlOrMeta+a'); await page.waitForTimeout(220); assert.equal(await floating.count(), 0); assert.equal(await fixed.count(), 1)
  report.checks.push('four theme screenshots, compact positioning and independent persisted selection setting')
  // This profile uses deterministic IPC, never a real OS launch or file dialog.
  const native = await browser.newPage({ viewport: { width: 1120, height: 800 } }); native.on('pageerror', error => errors.push(error.message)); await acknowledgeGuide(native)
  await native.addInitScript(() => {
    window.isTauri = true; window.calls = []; let callback = 0
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' } }, transformCallback: () => ++callback, invoke: async (command, args) => {
        if (command === 'recent_state') return { entries: [], session: { tabs: [], activeDraftKey: null, workspaceId: null } }
        if (command === 'remember_session') return

      window.calls.push({ command, args }); if (command.startsWith('plugin:window|is_')) return false; if (command.startsWith('plugin:')) return 1
      if (command === 'open_workspace') return { id: 'workspace', name: 'links', entries: [{ path: 'current.md', name: 'current.md', kind: 'document' }] }
      if (command === 'open_workspace_document') {
        if (window.delayOpen) await new Promise(resolve => setTimeout(resolve, 400))
        const text = args.relativePath === 'current.md' ? '[next](next.md#target)\n\n[outside](../private.md)\n\n[web](https://example.com)' : '# Target\n\nnext file'
        return { id: args.relativePath, name: args.relativePath, bytes: [...new TextEncoder().encode(text)], revision: 'r1' }
      }
      if (command === 'inspect_document') return { revision: args.expectedRevision, bytes: null }
      if (command === 'open_external_link' || command === 'close_document') return
      if (command === 'history_operation') throw 'history_disabled'
      throw new Error(`Unexpected IPC ${command}`)
    } }
  })
  await native.goto(server.url); await native.getByRole('button', { name: 'EM 菜单', exact: true }).click(); await native.getByRole('menuitem', { name: '打开工作区', exact: true }).click(); await native.getByRole('button', { name: 'current.md', exact: true }).click()
  await native.getByRole('button', { name: '分屏', exact: true }).click(); const nl = native.getByRole('dialog', { name: '插入 / 编辑链接', exact: true })
  await native.getByRole('link', { name: 'outside', exact: true }).click(); await nl.getByRole('button', { name: '打开现有地址' }).click(); await nl.getByRole('alert').waitFor(); assert.equal(await native.evaluate(() => window.calls.filter(c => c.command === 'open_workspace_document').length), 1); await nl.getByRole('button', { name: '取消', exact: true }).click()
  await native.getByRole('link', { name: 'web', exact: true }).click(); await nl.getByRole('button', { name: '打开现有地址' }).click(); await native.waitForFunction(() => window.calls.some(c => c.command === 'open_external_link' && c.args.url === 'https://example.com')); await nl.getByRole('button', { name: '取消', exact: true }).click()
  await native.getByRole('link', { name: 'next', exact: true }).click(); await nl.getByRole('button', { name: '打开现有地址' }).click(); await native.getByRole('tab', { name: 'next.md', exact: true }).waitFor(); await native.locator('.document-panel:not([hidden]) .cm-activeLine').filter({ hasText: '# Target' }).waitFor(); assert.equal(await native.getByRole('tab').count(), 3)
  await native.getByRole('tab', { name: 'current.md', exact: true }).click(); await native.evaluate(() => { window.delayOpen = true }); await native.getByRole('link', { name: 'next', exact: true }).click(); await nl.getByRole('button', { name: '打开现有地址' }).click(); await nl.getByRole('button', { name: '取消', exact: true }).click(); await native.waitForTimeout(500); assert.equal(await native.getByRole('tab', { name: 'current.md', exact: true }).getAttribute('aria-selected'), 'true'); assert.equal(await native.evaluate(() => window.calls.filter(c => c.command === 'close_document').length), 0)
  await native.close(); report.checks.push('desktop IPC fixture: bounded relative path, explicit external open, relative heading navigation, cancelled async result preserves existing tab handle')
  assert.deepEqual(errors, []); report.passed = true
} catch (error) { report.error = error.stack; process.exitCode = 1; await page?.screenshot({ path: 'test-results/content-tools/failure.png' }).catch(() => {}) }
finally { await writeFile('test-results/content-tools-verification.json', JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2)); await browser?.close(); await server.close() }
