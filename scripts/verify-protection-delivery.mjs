import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'
import { productionWorkers, workerKind } from './production-workers.mjs'
import { serveProduction } from './serve-production.mjs'

const output = 'test-results/protection-delivery'
const { version } = JSON.parse(await readFile('package.json', 'utf8'))
const report = { version, startedAt: new Date().toISOString(), passed: false, checks: [], samples: [], scope: 'Production Chromium guide and actual shipped merge/resource Worker on distributed v0.7 samples. Existing merge/backup UI suites and native Rust tests cover application/archive behavior; no native dialog or real IME claim.' }
await mkdir(output, { recursive: true })
const server = await serveProduction()
let browser, page
try {
  browser = await chromium.launch({ channel: process.env.EASYM_TEST_BROWSER || undefined }); report.browser = browser.version()
  page = await browser.newPage({ viewport: { width: 960, height: 680 } })
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  // A previous release must show the new guide until acknowledged.
  await page.addInitScript(() => { if (!sessionStorage.getItem('guide-initialized')) { localStorage.setItem('easym-guide-version', '0.6.0'); sessionStorage.setItem('guide-initialized', 'yes') } })
  await page.goto(server.url)
  const guide = page.getByRole('dialog', { name: 'EasyM 使用导引', exact: true })
  await guide.waitFor(); assert.match(await guide.innerText(), new RegExp(`已更新到 EasyM ${version.replaceAll('.', '\\.')}`))
  for (let index = 1; index <= 4; index++) {
    assert.equal(await guide.locator('section').count(), 1)
    assert.equal(await guide.getByRole('status').innerText(), `${index} / 4`)
    assert.equal(await guide.evaluate(node => {
      const r = node.getBoundingClientRect(), nav = node.querySelector('.guide-navigation').getBoundingClientRect()
      return node.scrollWidth <= node.clientWidth && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && nav.bottom <= innerHeight
    }), true, `guide page ${index} must fit minimum window`)
    if (index === 3) for (const term of ['三方合并', '强制归档', '合并恢复记录', '文档备份与恢复', '远程图片只保留链接', '新目录']) assert.ok((await guide.innerText()).includes(term), term)
    await page.screenshot({ path: `${output}/guide-${index}.png` })
    if (index < 4) await page.keyboard.press('ArrowRight')
  }
  await guide.getByRole('button', { name: '开始使用', exact: true }).click()
  await page.reload(); assert.equal(await guide.count(), 0)
  assert.equal(await page.evaluate(() => localStorage.getItem('easym-guide-version')), version)
  report.checks.push('upgrade from v0.6 shows four pages, explains merge/recovery/backup on page three, fits 960x680 and persists acknowledgement')
  await page.getByRole('button', { name: 'EM 菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '查看使用导引', exact: true }).click()
  assert.equal(await guide.getByRole('status').innerText(), '1 / 4')
  await page.keyboard.press('Escape'); await guide.waitFor({ state: 'hidden' })
  report.checks.push('settings reopens guide at page one; Escape closes it')

  const worker = (await productionWorkers()).find(source => workerKind(source) === 'history')
  const run = data => page.evaluate(async ({ source, data }) => {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' })), worker = new Worker(url)
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Production worker timed out')), 12000)
        worker.onmessage = event => { clearTimeout(timer); resolve(event.data) }
        worker.onerror = error => { clearTimeout(timer); reject(new Error(error.message)) }
        worker.postMessage(data)
      })
    } finally { worker.terminate(); URL.revokeObjectURL(url) }
  }, { source: worker, data })
  async function sample(relative) {
    const path = `Docs/samples/v0.7/${relative}`, bytes = await readFile(path)
    report.samples.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    return bytes.toString('utf8').replaceAll('\r\n', '\n')
  }
  for (const kind of ['clean', 'conflict']) {
    const base = await sample(`merge/${kind}/base.md`), local = await sample(`merge/${kind}/local.md`), disk = await sample(`merge/${kind}/disk.md`)
    const result = await run({ type: 'merge', base, local, disk })
    if (kind === 'clean') { assert.equal(result.status, 'clean'); assert.equal(result.text, await sample('merge/clean/expected.md')) }
    else { assert.equal(result.status, 'conflicts'); assert.equal(result.conflicts, 1); assert.equal(result.text, undefined); assert.ok(result.chunks.some(c => c.kind === 'conflict' && c.local.includes('发布日期：周六。') && c.disk.includes('发布日期：周日。'))) }
  }
  const text = await sample('备份示例.md'), resource = await run({ type: 'references', texts: [text] })
  assert.deepEqual(resource.references[0].references, ['assets/em.png']); assert.deepEqual(resource.references[0].unarchivedReferences, [])
  const png = await readFile('Docs/samples/v0.7/assets/em.png'); assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  report.samples.push({ path: 'Docs/samples/v0.7/assets/em.png', bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') })
  report.checks.push('distributed clean/conflict samples match actual production merge Worker; backup sample references the included PNG with no unsafe resources')
  assert.deepEqual(errors, []); report.passed = true
} catch (error) { report.error = error.stack; process.exitCode = 1; await page?.screenshot({ path: `${output}/failure.png` }).catch(() => {}) }
finally {
  report.finishedAt = new Date().toISOString()
  await browser?.close(); await server.close()
  await writeFile(`${output}-verification.json`, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}
