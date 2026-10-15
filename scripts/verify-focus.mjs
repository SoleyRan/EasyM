import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { serveProduction, acknowledgeGuide } from './serve-production.mjs'
import { fillSource } from './source-test-utils.mjs'

const cpuThrottlingRate = process.argv.includes('--slow') ? 6 : 1
const output = cpuThrottlingRate > 1 ? 'test-results/focus-slow' : 'test-results/focus'
const report = { passed: false, cpuThrottlingRate, checks: [] }
const server = await serveProduction()
const require = createRequire(import.meta.url), JSZip = createRequire(require.resolve('docx'))('jszip')
await mkdir(output, { recursive: true })
let browser, page
try {
  browser = await chromium.launch({ channel: process.env.EASYM_TEST_BROWSER || undefined })
  report.browser = browser.version()
  page = await browser.newPage()
  if (cpuThrottlingRate > 1) {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottlingRate })
  }
  await acknowledgeGuide(page)
  // Hold frames only across modal dismissal and the start of source input.
  // Release them between select-all and insertText to exercise the interleaving
  // that used to let a late menu-focus callback interrupt multiline input.
  await page.addInitScript(() => {
    const raf = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window)
    const held = new Map()
    let identity = -1
    window.holdCloseFrames = false
    window.requestAnimationFrame = callback => {
      if (!window.holdCloseFrames) return raf(callback)
      const id = identity--; held.set(id, callback); return id
    }
    window.cancelAnimationFrame = id => { if (!held.delete(id)) cancel(id) }
    window.releaseCloseFrames = () => {
      window.holdCloseFrames = false
      const frames = [...held.values()]; held.clear()
      for (const frame of frames) frame(performance.now())
    }
  })
  await page.goto(server.url)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const editor = page.getByRole('textbox', { name: 'Markdown 源码编辑器' })
  const text = () => editor.evaluate(node => [...node.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'))
  const action = async name => {
    await page.getByRole('button', { name: 'EM 菜单', exact: true }).click()
    await page.getByRole('menuitem', { name, exact: true }).click()
  }
  const docx = async () => {
    await action('导出'); await page.getByRole('menuitem', { name: 'DOCX', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.docx-dialog [role=status]')?.textContent.includes('预检完成'))
    return page.getByRole('dialog', { name: '导出 DOCX', exact: true })
  }
  let current = '# Original\n\n完整的原文。'
  await fillSource(page, current)
  for (const kind of ['DOCX cancel', 'DOCX download', 'PDF preview', 'settings', 'guide']) {
    let dialog
    if (kind.startsWith('DOCX')) dialog = await docx()
    else if (kind === 'PDF preview') {
      await action('导出'); await page.getByRole('menuitem', { name: 'PDF', exact: true }).click()
      dialog = page.getByRole('dialog', { name: '打印预览', exact: true })
      await dialog.waitFor()
    }
    else {
      await action('设置')
      dialog = page.getByRole('dialog', { name: '设置', exact: true })
      if (kind === 'guide') {
        await dialog.getByRole('button', { name: '查看使用导引', exact: true }).click()
        dialog = page.getByRole('dialog', { name: 'EasyM 使用导引', exact: true })
      }
    }
    await page.evaluate(() => { window.holdCloseFrames = true })
    if (kind === 'DOCX download') {
      const next = page.waitForEvent('download')
      await dialog.getByRole('button', { name: '生成 DOCX', exact: true }).click()
      await (await next).saveAs(`${output}/focus.docx`)
    } else await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    await editor.press('ControlOrMeta+a')
    await page.evaluate(() => window.releaseCloseFrames())
    assert.equal(await editor.evaluate(node => document.activeElement === node), true, `${kind}: late close callbacks must preserve editor focus`)
    current = `# After ${kind}\n\n第一段 **中文**。\n\n第二段 English 🙂。`
    await page.keyboard.insertText(current)
    assert.equal(await text(), current, `${kind}: complete multiline replacement`)
    // Export immediately, before any debounced preview update, and inspect the
    // actual output to ensure the application also sees the new source.
    dialog = await docx()
    const next = page.waitForEvent('download')
    await dialog.getByRole('button', { name: '生成 DOCX', exact: true }).click()
    const file = await next
    const path = `${output}/${kind.replaceAll(' ', '-')}.docx`
    await file.saveAs(path)
    const zip = await JSZip.loadAsync(await readFile(path), { checkCRC32: true })
    const xml = await zip.file('word/document.xml').async('string')
    for (const expected of [`After ${kind}`, '第一段 ', '中文', '第二段 English 🙂。']) assert.ok(xml.includes(expected), `${kind}: exported content ${expected}`)
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await text(), current)
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'EM 菜单')
    report.checks.push(`${kind}: resumed typing keeps focus and full multiline source; immediate DOCX export completes`)
  }
  assert.deepEqual(errors, [])
  report.passed = true
} catch (error) {
  report.error = error.stack; process.exitCode = 1
  await page?.screenshot({ path: `${output}/failure.png` }).catch(() => {})
} finally {
  await browser?.close(); await server.close()
  await writeFile(`${output}-verification.json`, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}
