import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { serveProduction } from './serve-production.mjs'

const server = await serveProduction()
let browser
let page
try {
  browser = await chromium.launch({ channel: process.env.EASYM_TEST_BROWSER || undefined })
  page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  // Exercise the production frontend with a deterministic IPC fixture; real filesystem search is covered by Rust tests.
  await page.addInitScript(() => {
    window.isTauri = true
    window.workspaceCalls = []
    window.workspaceStale = false
    let callback = 0
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } },
      transformCallback: () => ++callback,
      invoke: async (command, args) => {
        window.workspaceCalls.push({ command, args })
        if (command.startsWith('plugin:window|is_')) return false
        if (command.startsWith('plugin:')) return 1
        if (command === 'open_workspace') return { id: 'workspace', name: '中文工作区', entries: [{ name: 'notes', path: 'notes', kind: 'directory' }] }
        if (command === 'list_workspace') return [{ name: '中文文档.md', path: 'notes/中文文档.md', kind: 'document' }]
        if (command === 'search_workspace') {
          if (args.query === 'slow') await new Promise(resolve => setTimeout(resolve, 400))
          return { results: [{ path: 'notes/中文文档.md', line: 4, preview: 'needle 中文匹配', revision: 'hash' }], scanned: 1, skipped: 0, limited: false, cancelled: false }
        }
        if (command === 'open_workspace_document') return { id: 'document', name: '中文文档.md', bytes: [...new TextEncoder().encode('# 标题\r\n\r\n正文\r\nneedle 中文匹配\r\n\r\n## 第二标题')], revision: window.workspaceStale ? 'changed' : 'hash' }
        if (command === 'cancel_workspace_search' || command === 'close_document') return
        throw new Error(`Unexpected command: ${command}`)
      },
    }
  })
  await page.goto(server.url)
  await page.getByRole('button', { name: 'EM 菜单' }).click()
  await page.getByRole('menuitem', { name: '打开工作区', exact: true }).click()
  const query = page.getByRole('textbox', { name: '搜索工作区', exact: true })
  await query.fill('needle')
  await query.press('Enter')
  const result = page.locator('.workspace-search-result:visible')
  await result.waitFor()
  assert.match(await result.textContent(), /第 4 行/)
  await result.click()
  await page.locator('.document-panel:not([hidden]) .cm-activeLine').filter({ hasText: 'needle 中文匹配' }).waitFor()
  assert.equal(await page.getByRole('tab').count(), 2)
  assert.equal(await page.getByRole('tab', { name: '中文文档.md', exact: true }).count(), 1)
  await page.getByRole('button', { name: '展开大纲', exact: true }).click()
  const outline = page.getByRole('navigation', { name: '文档大纲' })
  await outline.getByRole('button').first().focus()
  await page.keyboard.press('End')
  assert.equal(await outline.getByRole('button').last().evaluate(node => node === document.activeElement), true)
  await page.keyboard.press('Enter')
  await page.locator('.document-panel:not([hidden]) .cm-activeLine').filter({ hasText: '## 第二标题' }).waitFor()
  await page.getByRole('tab', { name: '未命名.md', exact: true }).click()
  await result.click()
  assert.equal(await page.getByRole('tab').count(), 2)
  await page.locator('.document-panel:not([hidden]) .cm-activeLine').filter({ hasText: 'needle 中文匹配' }).waitFor()
  await page.getByRole('tab', { name: '未命名.md', exact: true }).click()
  const tree = page.getByRole('navigation', { name: '工作区文件' })
  await tree.getByRole('button').first().focus()
  await page.keyboard.press('ArrowRight')
  await tree.getByRole('button', { name: /中文文档/ }).waitFor()
  await page.waitForFunction(() => document.querySelector('.document-panel:not([hidden]) .workspace-tree button')?.getAttribute('aria-expanded') === 'true' && !document.querySelector('.document-panel:not([hidden]) .workspace-tree button')?.hasAttribute('aria-busy'))
  await page.keyboard.press('ArrowRight')
  assert.match(await page.evaluate(() => document.activeElement.textContent), /中文文档/)
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  assert.equal(await tree.getByRole('button').first().getAttribute('aria-expanded'), 'false')
  await query.fill('slow'); await query.press('Enter')
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await page.waitForTimeout(450)
  assert.equal(await result.count(), 0)
  assert.ok(await page.evaluate(() => window.workspaceCalls.some(call => call.command === 'cancel_workspace_search')))
  await query.fill('needle'); await query.press('Enter'); await result.waitFor()
  await page.evaluate(() => { window.workspaceStale = true })
  await result.click()
  await page.getByRole('alert').filter({ hasText: '文件已变化' }).waitFor()
  assert.equal(await page.getByRole('tab').count(), 2)
  await mkdir('test-results', { recursive: true })
  for (const [name, size] of [['desktop', { width: 1280, height: 860 }], ['compact', { width: 800, height: 650 }]]) {
    await page.setViewportSize(size)
    await page.screenshot({ path: `test-results/workspace-${name}.png` })
    const bounds = await query.boundingBox()
    assert.ok(bounds && bounds.width > 30 && bounds.x + bounds.width <= size.width)
  }
  assert.equal(await page.evaluate(() => window.workspaceCalls.some(call => call.command === 'save_document')), false)
  assert.deepEqual(errors, [])
  await mkdir('Docs/verification', { recursive: true })
  await writeFile('Docs/verification/v0.2-workspace-verification.json', JSON.stringify({
    verifiedAt: new Date().toISOString(), browser: browser.version(), passed: true,
    scope: 'Production frontend with deterministic IPC fixture; real filesystem and limits covered by Rust tests. Native WebView end-to-end remains pending.',
    checks: ['search result file/line navigation and existing tab reuse', 'file tree lazy expansion and directional navigation', 'outline keyboard navigation and source jump', 'cancel and late-result rejection', 'changed file rejection without overwrite', 'desktop/compact search layout screenshots', 'search and navigation issue no save commands'],
  }, null, 2) + '\n')
  console.log('Workspace frontend search, navigation, cancellation and revision checks pass.')
} catch (error) {
  console.error(await page?.locator('body').innerText().catch(() => 'No page'))
  throw error
} finally {
  await browser?.close()
  await server.close()
}
