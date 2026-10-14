import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { serveProduction, acknowledgeGuide } from './serve-production.mjs'
import { fillSource } from './source-test-utils.mjs'

const server = await serveProduction()
const report = { passed: false, scope: 'Production Chromium with real CodeMirror input, IndexedDB and page reload. No native file permissions or OS crash claim.', checks: [] }
let browser, page
await mkdir('test-results/session', { recursive: true })
try {
  browser = await chromium.launch({ channel: process.env.EASYM_TEST_BROWSER || undefined })
  report.browser = browser.version()
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await acknowledgeGuide(page); await page.goto(server.url)
  const activeBody = () => page.locator('.document-panel:not([hidden]) .cm-content').evaluate(node => [...node.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'))
  const flushDrafts = async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await page.locator('.document-panel:not([hidden]) .statusbar').filter({ hasText: '草稿已保存' }).waitFor()
  }
  const chooseTab = async index => page.getByRole('tab').nth(index).click()
  const recover = async () => page.getByRole('button', { name: '恢复草稿', exact: true }).click()
  await fillSource(page, '# 第一个草稿\n\n中文与 emoji 😀'); await flushDrafts()
  await page.getByRole('button', { name: '新建标签', exact: true }).click()
  await fillSource(page, '# 第二个草稿\n\n保留当前标签'); await flushDrafts()
  const originalIndex = await page.evaluate(() => JSON.parse(localStorage.getItem('easym-session')))
  assert.equal(originalIndex.tabs.length, 2)
  assert.equal(originalIndex.activeDraftKey, originalIndex.tabs[1].draftKey)
  await page.reload(); await page.getByRole('dialog', { name: '恢复草稿', exact: true }).waitFor()
  assert.equal(await page.getByRole('tab').count(), 2)
  assert.equal(await page.getByRole('tab').nth(1).getAttribute('aria-selected'), 'true')
  await recover(); assert.equal(await activeBody(), '# 第二个草稿\n\n保留当前标签')
  await chooseTab(0); await recover(); assert.equal(await activeBody(), '# 第一个草稿\n\n中文与 emoji 😀')
  report.checks.push('real multi-draft input, independent persistence, reload retains active tab and order, explicit recovery keeps Chinese/emoji bodies')

  // Drop the active target, reverse the surviving layout, and leave a persisted draft orphaned.
  await page.evaluate(() => {
    const index = JSON.parse(localStorage.getItem('easym-session'))
    localStorage.setItem('easym-session', JSON.stringify({ version: 1, tabs: [{ draftKey: 'document:deleted', name: 'deleted.md' }, index.tabs[1]], activeDraftKey: 'document:deleted' }))
  })
  await page.reload(); await page.getByRole('dialog', { name: '恢复草稿', exact: true }).waitFor()
  assert.equal(await page.getByRole('tab').count(), 2)
  assert.equal(await page.getByRole('tab').nth(0).getAttribute('aria-selected'), 'true')
  await recover(); assert.equal(await activeBody(), '# 第二个草稿\n\n保留当前标签')
  await chooseTab(1); await recover(); assert.equal(await activeBody(), '# 第一个草稿\n\n中文与 emoji 😀')
  report.checks.push('missing active index target is dropped, surviving order retained, orphan draft is appended and recoverable')

  const future = '{"version":9,"keep":"future-index"}'
  await page.evaluate(raw => localStorage.setItem('easym-session', raw), future)
  await page.reload(); await page.getByRole('alert').filter({ hasText: '无法读取会话索引' }).waitFor()
  await recover(); await fillSource(page, '# 索引不兼容仍可保留正文'); await flushDrafts()
  assert.equal(await page.evaluate(() => localStorage.getItem('easym-session')), future)
  await page.getByRole('button', { name: '新建标签', exact: true }).click()
  await fillSource(page, '# 不覆盖未知索引'); await flushDrafts()
  assert.equal(await page.evaluate(() => localStorage.getItem('easym-session')), future)
  report.checks.push('future schema remains byte-for-byte intact through draft recovery, edits and tab creation')

  await page.evaluate(index => localStorage.setItem('easym-session', JSON.stringify(index)), originalIndex)
  await page.reload(); await page.getByRole('dialog', { name: '恢复草稿', exact: true }).waitFor(); await recover()
  await page.evaluate(() => {
    window.sessionStorageWrite = Storage.prototype.setItem
    Storage.prototype.setItem = function(key, value) { if (key === 'easym-session') throw new DOMException('quota', 'QuotaExceededError'); return window.sessionStorageWrite.call(this, key, value) }
  })
  await page.getByRole('button', { name: '新建标签', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '无法保存会话索引' }).waitFor()
  await fillSource(page, '# 索引写入失败，正文继续保存'); await flushDrafts()
  await page.screenshot({ path: 'test-results/session/write-failure.png' })
  await page.evaluate(() => { Storage.prototype.setItem = window.sessionStorageWrite })
  await page.reload(); await page.getByRole('dialog', { name: '恢复草稿', exact: true }).waitFor(); await recover()
  const count = await page.getByRole('tab').count(); assert.equal(count, 4)
  await chooseTab(count - 1); await recover(); assert.equal(await activeBody(), '# 索引写入失败，正文继续保存')
  report.checks.push('denied index writes visibly report failure, independent drafts persist and recover as orphans after reload')
  assert.deepEqual(errors, []); report.passed = true
} catch (error) { report.error = error.stack; process.exitCode = 1; console.error(error); await page?.screenshot({ path: 'test-results/session/failure.png' }).catch(() => {}) }
finally { await writeFile('test-results/session-verification.json', JSON.stringify(report, null, 2) + '\n'); await browser?.close(); await server.close() }
