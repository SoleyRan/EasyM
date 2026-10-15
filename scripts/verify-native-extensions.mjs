import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { setTimeout } from 'node:timers/promises'
import { fillSource } from './source-test-utils.mjs'
import { selectAppearanceTheme } from './serve-production.mjs'

// Called by the PowerShell wrapper; never launches or attaches to a user's profile.
const port = Number(process.argv[2])
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535)
const endpoint = `http://127.0.0.1:${port}`
const { version } = JSON.parse(await readFile('package.json', 'utf8'))
const report = { verifiedAt: new Date().toISOString(), version, passed: false, checks: [], isolatedProfile: true,
  executableSha256: createHash('sha256').update(await readFile('src-tauri/target/release/easym.exe')).digest('hex'),
  scope: 'Actual Windows release WebView2 over an isolated temporary CDP endpoint. No mocked IPC or source injection; excludes IME, OS save/print and other WebViews.' }
await mkdir('test-results/native-extensions', { recursive: true })
let browser, page
try {
  const deadline = Date.now() + 30000
  while (true) {
    try { const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) }); if (response.ok) break } catch { /* WebView starts asynchronously. */ }
    if (Date.now() >= deadline) throw new Error('Isolated WebView debug endpoint did not start')
    await setTimeout(250)
  }
  browser = await chromium.connectOverCDP(endpoint); report.browser = browser.version()
  const context = browser.contexts()[0]
  page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 30000 })
  const errors = [], external = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    const url = request.url()
    if (/^https?:/.test(url) && !/^https?:\/\/(?:tauri|ipc)\.localhost(?:[:/]|$)/.test(url)) external.push(url)
  })
  await page.getByRole('dialog', { name: 'EasyM 使用导引', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  report.origin = await page.evaluate(() => location.origin)
  assert.match(report.origin, /^https?:\/\/tauri\.localhost$/)
  const sample = (await readFile('Docs/samples/v0.6/扩展与导出.md', 'utf8')).replaceAll('\r\n', '\n').replace('![em](assets/em.png)', '').trimEnd()
  // Network emulation applies to the WebView target. Bundled custom-scheme assets
  // must continue to load without an actual remote connection.
  const session = await context.newCDPSession(page)
  await session.send('Network.enable')
  await session.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  await fillSource(page, sample)
  await page.getByRole('button', { name: '分屏', exact: true }).click()
  const preview = page.locator('.document-panel:not([hidden]) .preview')
  const imagesReady = () => page.waitForFunction(() => {
    const images = [...document.querySelectorAll('.document-panel:not([hidden]) .preview .markdown-mermaid > img')]
    return images.length === 2 && images.every(image => image.complete && image.naturalWidth > 0)
  }, undefined, { timeout: 30000 })
  await imagesReady()
  assert.equal(await preview.locator('math').count(), 3)
  assert.equal(await preview.locator('.footnotes ol > li').count(), 1)
  assert.equal(await preview.locator('.markdown-metadata').count(), 1)
  report.checks.push('real release custom-scheme origin, WebView offline emulation, opaque-origin Mermaid iframe and MathML/note/metadata rendering')
  for (const theme of ['light', 'dark', 'paper', 'forest']) {
    await selectAppearanceTheme(page, theme); await imagesReady()
    const paint = { light: '#e9f1fe', dark: '#202c3e', paper: '#f1e8d8', forest: '#dfebdb' }[theme]
    await page.waitForFunction(paint => {
      const image = document.querySelector('.document-panel:not([hidden]) .preview .markdown-mermaid > img')
      return image && decodeURIComponent(image.getAttribute('src')).includes(paint)
    }, paint)
    await preview.evaluate(node => { node.scrollTop = 0 })
    await page.screenshot({ path: `test-results/native-extensions/${theme}.png` })
    if (theme === 'dark') {
      await preview.locator('.markdown-mermaid').first().scrollIntoViewIfNeeded()
      await page.screenshot({ path: 'test-results/native-extensions/dark-diagram.png' })
    }
  }
  await page.getByRole('button', { name: '阅读模式', exact: true }).click()
  await page.getByRole('button', { name: '退出阅读模式', exact: true }).waitFor()
  await imagesReady()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '阅读模式', exact: true }).waitFor()
  await page.getByRole('button', { name: '即时渲染', exact: true }).click()
  await page.getByRole('textbox', { name: 'Markdown 源码编辑器' }).press('Control+End')
  await page.locator('.document-panel:not([hidden]) .live-block-mermaid img').first().waitFor()
  await page.getByRole('button', { name: '源码', exact: true }).click()
  const body = await page.getByRole('textbox', { name: 'Markdown 源码编辑器' }).evaluate(node => [...node.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'))
  assert.equal(body, sample)
  assert.deepEqual(errors, []); assert.deepEqual(external, [])
  report.checks.push('four themes, reading/Escape and live source retention; no external requests or page exceptions during exercised workflow')
  // Restore an unchanged blank document so the wrapper can close normally.
  await session.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  await fillSource(page, '')
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click()
  // Editing back to empty may retain a dirty revision; exercise the real guard.
  const discard = page.getByRole('button', { name: '不保存退出', exact: true })
  await discard.waitFor({ timeout: 2000 }).then(() => discard.click()).catch(error => {
    if (!page.isClosed() && !error.message.includes('Target closed') && !error.message.includes('has been closed')) throw error
  })
  report.passed = true
} catch (error) {
  report.error = error.stack ?? error.message; process.exitCode = 1
  await page?.screenshot({ path: 'test-results/native-extensions/failure.png' }).catch(() => {})
} finally {
  // CDP close only disconnects; wrapper owns the native process lifecycle.
  await browser?.close()
  await writeFile('test-results/native-extensions-verification.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}
