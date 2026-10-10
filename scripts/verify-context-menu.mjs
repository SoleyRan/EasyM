import assert from 'node:assert/strict'
import { fillSource } from './source-test-utils.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { serveProduction } from './serve-production.mjs'

const server = await serveProduction()
let browser, page
try {
  browser = await chromium.launch({ channel: process.env.EASYM_TEST_BROWSER || undefined })
  page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    // Keep the user's OS clipboard untouched and simulate delayed/denied reads.
    window.clipboardText = ''
    Object.defineProperty(navigator, 'clipboard', { value: {
      writeText: async text => { window.clipboardText = text },
      readText: () => {
        if (window.denyClipboard) return Promise.reject(new Error('Clipboard denied'))
        if (window.delayClipboard) return new Promise(resolve => { window.finishPaste = resolve })
        return Promise.resolve(window.clipboardText)
      },
    } })
    window.isTauri = true
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
    let callback = 0
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'main' } }, transformCallback: () => ++callback,
      invoke: async (command) => {
        if (command.startsWith('plugin:window|is_')) return false
        if (command.startsWith('plugin:')) return 1
        if (command === 'open_workspace') return { id: 'ws', name: '中文工作区', entries: [{ name: '目录', path: '目录', kind: 'directory' }] }
        if (command === 'list_workspace') return [{ name: '文档.md', path: '目录/文档.md', kind: 'document' }]
        if (command === 'open_workspace_document') return { id: 'doc', name: '文档.md', revision: 'r1', bytes: [...new TextEncoder().encode('# 文件标题\n\n正文')] }
        if (command === 'close_document') return
        throw new Error(`Unexpected IPC ${command}`)
      },
    }
    document.addEventListener('contextmenu', event => { setTimeout(() => { window.defaultMenuBlocked = event.defaultPrevented }, 0) })
  })
  await page.goto(server.url)
  const editor = page.getByRole('textbox', { name: 'Markdown 源码编辑器' })
  const menu = page.getByRole('menu', { name: '右键菜单', exact: true })
  const action = name => menu.getByRole('menuitem', { name, exact: true }).click()
  const body = () => editor.evaluate(element => [...element.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'))
  const contextEditor = async () => {
    const box = await page.locator('.document-panel:not([hidden]) .cm-content').boundingBox()
    await page.mouse.click(box.x + 50, box.y + 8, { button: 'right' })
    await menu.waitFor()
  }
  // Native menus are suppressed on controls and empty/status areas.
  await page.locator('.statusbar:visible').click({ button: 'right' })
  await page.waitForFunction(() => window.defaultMenuBlocked)
  assert.equal(await menu.count(), 0)
  await page.getByRole('button', { name: '隐藏格式工具栏', exact: true }).click({ button: 'right' })
  assert.equal(await menu.count(), 0)

  await fillSource(page, 'plain 中文')
  await editor.press('Control+a')
  await contextEditor()
  await action('复制')
  assert.equal(await page.evaluate(() => window.clipboardText), 'plain 中文')
  await contextEditor(); await action('剪切')
  assert.equal(await body(), '')
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  assert.equal(await body(), 'plain 中文')
  await editor.press('Control+a'); await contextEditor()
  await menu.getByRole('menuitemcheckbox', { name: '加粗', exact: true }).click()
  assert.equal(await body(), '**plain 中文**')
  await contextEditor()
  assert.equal(await menu.getByRole('menuitemcheckbox', { name: '加粗', exact: true }).getAttribute('aria-checked'), 'true')
  await menu.getByRole('menuitemcheckbox', { name: '加粗', exact: true }).click()
  assert.equal(await body(), 'plain 中文')
  await page.evaluate(() => { window.clipboardText = '粘贴文本' })
  await editor.press('Control+a'); await contextEditor(); await action('粘贴文本')
  assert.equal(await body(), '粘贴文本')
  await contextEditor(); await action('撤销')
  assert.equal(await body(), 'plain 中文')

  await page.evaluate(() => { window.delayClipboard = true })
  await editor.press('Control+a'); await contextEditor(); await action('粘贴文本')
  await fillSource(page, 'changed while reading clipboard')
  await page.evaluate(() => { window.delayClipboard = false; window.finishPaste('stale clipboard') })
  await page.getByRole('alert').filter({ hasText: '正文或选区已变化' }).waitFor()
  assert.equal(await body(), 'changed while reading clipboard')
  await page.getByRole('button', { name: '关闭右键操作提示' }).click()
  await page.evaluate(() => { window.denyClipboard = true })
  await contextEditor(); await action('粘贴文本')
  await page.getByRole('alert').filter({ hasText: 'Clipboard denied' }).waitFor()
  assert.equal(await body(), 'changed while reading clipboard')
  await page.evaluate(() => { window.denyClipboard = false })
  await page.getByRole('button', { name: '关闭右键操作提示' }).click()

  // Search input has edit actions, composition remains untouched.
  await page.getByRole('button', { name: '查找 / 替换', exact: true }).click()
  const query = page.getByRole('textbox', { name: '查找文本' })
  await query.fill('clipboard'); await query.press('Control+a'); await query.click({ button: 'right' })
  await action('复制')
  assert.equal(await page.evaluate(() => window.clipboardText), 'clipboard')
  await query.click({ button: 'right' }); await action('剪切')
  assert.equal(await query.inputValue(), '')
  await query.click({ button: 'right' }); await action('粘贴文本')
  assert.equal(await query.inputValue(), 'clipboard')
  await query.dispatchEvent('compositionstart', { data: '中' }); await query.click({ button: 'right' })
  assert.equal(await menu.count(), 0)
  await query.dispatchEvent('compositionend', { data: '中' })
  await page.getByRole('button', { name: '关闭查找' }).click()

  // Menu stays inside the viewport and follows the theme in each editor view.
  for (const [theme, label] of [['light', '清爽浅色'], ['dark', '午夜深色'], ['paper', '暖纸'], ['forest', '护眼绿']]) {
    await page.getByRole('button', { name: 'EM 菜单' }).click()
    await page.getByRole('menuitem', { name: 'Style · 配色主题' }).click()
    await page.getByRole('menuitemradio', { name: label, exact: true }).click()
    for (const view of ['源码', '分屏', '即时渲染']) {
      await page.getByRole('button', { name: view, exact: true }).click()
      const box = await page.locator('.document-panel:not([hidden]) .cm-scroller').boundingBox()
      await page.mouse.click(box.x + box.width - 12, box.y + box.height - 12, { button: 'right' })
      await menu.waitFor()
      const bounds = await menu.boundingBox()
      assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 1280 && bounds.y + bounds.height <= 860)
      assert.equal(await menu.evaluate(node => node.closest('.application').dataset.theme), theme)
      await page.keyboard.press('End')
      assert.equal(await page.evaluate(() => document.activeElement.textContent), '查找 / 替换')
      await page.keyboard.press('Escape')
      assert.equal(await menu.count(), 0)
    }
  }
  await page.getByRole('button', { name: '源码', exact: true }).click()
  await fillSource(page, '# 预览标题\n\n[地址](https://example.com)')
  await page.getByRole('button', { name: '分屏', exact: true }).click()
  await page.locator('.preview h1').waitFor()
  await page.locator('.preview a').click({ button: 'right' }); await action('复制链接地址')
  assert.equal(await page.evaluate(() => window.clipboardText), 'https://example.com')
  await page.locator('.preview h1').click({ button: 'right' }); await action('全选预览')
  await page.locator('.preview h1').click({ button: 'right' }); await action('复制')
  assert.match(await page.evaluate(() => window.clipboardText), /预览标题/)
  await page.getByRole('button', { name: '展开大纲', exact: true }).click()
  await page.locator('.outline-item:visible').first().click({ button: 'right' }); await action('复制标题')
  assert.equal(await page.evaluate(() => window.clipboardText), '预览标题')
  await page.getByRole('button', { name: 'EM 菜单' }).click()
  await page.getByRole('menuitem', { name: '打开工作区', exact: true }).click()
  const tree = page.getByRole('navigation', { name: '工作区文件' })
  await tree.getByRole('button', { name: /目录/ }).click({ button: 'right' }); await action('展开目录')
  await tree.getByRole('button', { name: /文档.md/ }).click({ button: 'right' }); await action('复制相对路径')
  assert.equal(await page.evaluate(() => window.clipboardText), '目录/文档.md')
  await tree.getByRole('button', { name: /文档.md/ }).click({ button: 'right' }); await action('打开文档')
  await page.getByRole('tab', { name: '文档.md', exact: true }).waitFor()
  await page.getByRole('button', { name: '新建标签' }).click()
  await page.getByRole('tab', { name: '文档.md', exact: true }).click({ button: 'right' }); await action('关闭所有其他')
  await page.getByRole('dialog', { name: '关闭前保留修改' }).waitFor()
  await page.getByRole('button', { name: '返回编辑', exact: true }).click()
  assert.equal(await page.getByRole('tab').count(), 3)
  await page.getByRole('tab', { name: '文档.md', exact: true }).click({ button: 'right' }); await action('关闭所有其他')
  await page.getByRole('button', { name: '不保存关闭', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 1)
  assert.equal(await page.getByRole('tab').innerText(), '文档.md')
  await page.getByRole('tab').click({ button: 'right' }); await action('关闭所有')
  await page.getByRole('tab', { name: '未命名.md', exact: true }).waitFor()
  assert.equal(await page.getByRole('tab').count(), 1)
  await page.getByRole('tab').click({ button: 'right' })
  assert.equal(await menu.getByRole('menuitem', { name: '关闭所有其他', exact: true }).isDisabled(), true)
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 1280, height: 260 })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.locator('.document-panel:not([hidden]) .cm-scroller').dispatchEvent('contextmenu', { clientX: 1200, clientY: 240 })
  await menu.waitFor()
  const shortMenu = await menu.boundingBox()
  assert.ok(shortMenu.y >= 0 && shortMenu.y + shortMenu.height <= 260)
  await menu.evaluate(node => { node.scrollTop = node.scrollHeight })
  await menu.getByRole('menuitem', { name: '查找 / 替换', exact: true }).click()
  await page.getByRole('textbox', { name: '查找文本' }).waitFor()
  await page.setViewportSize({ width: 1280, height: 860 })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.deepEqual(errors, [])
  await mkdir('test-results', { recursive: true })
  await page.getByRole('tab').click({ button: 'right' })
  await page.screenshot({ path: 'test-results/context-menu-verification.png' })
  await writeFile('test-results/context-menu-verification.json', JSON.stringify({ verifiedAt: new Date().toISOString(), passed: true, browser: await browser.version(), checks: ['default menus suppressed on controls/status', 'editor copy/cut/paste undo and format toggle', 'delayed/denied clipboard retains source', 'search input edit/composition guard', '3 views and 4 themes, viewport fit and keyboard navigation', 'preview links/selection, outline and workspace paths', 'background tab batch close, cancel and discard, last-tab blank replacement'], clipboard: 'isolated fixture; OS clipboard untouched', workspace: 'deterministic IPC fixture' }, null, 2) + '\n')
  console.log('Context menu verification passed.')
} finally {
  await browser?.close()
  await server.close()
}
