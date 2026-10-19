import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { serveProduction, acknowledgeGuide } from './serve-production.mjs'
import { productionWorkers, workerKind } from './production-workers.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cpus, release, totalmem } from 'node:os'

const server = await serveProduction(), report = { stage: 'v0.3-step5', verifiedAt: new Date().toISOString(), passed: false, checks: [], scope: 'Production UI and actual image/history workers; desktop IPC fixture. Native batch persistence and recovery covered separately by Rust filesystem tests.' }
let browser, page
report.machine = { platform:process.platform, release:release(), cpu:cpus()[0]?.model, memoryGiB:+(totalmem()/2**30).toFixed(1) }
const exec = promisify(execFile)
async function sampleMemory(browser) {
  const session = await browser.newBrowserCDPSession()
  try {
    const {processInfo} = await session.send('SystemInfo.getProcessInfo'), ids=processInfo.map(p=>Number(p.id)).filter(Number.isSafeInteger)
    if (!ids.length) return null
    if(process.platform==='win32') {
      const {stdout}=await exec('powershell.exe',['-NoProfile','-Command',`$sum = 0; @(${ids.join(',')}) | ForEach-Object { $p = Get-Process -Id $_ -ErrorAction SilentlyContinue; if ($p) { $sum += $p.WorkingSet64 } }; $sum`],{windowsHide:true})
      return Number(stdout.trim())
    }
    const {stdout}=await exec('ps',['-o','rss=','-p',ids.join(',')]);return stdout.trim().split(/\s+/).reduce((n,v)=>n+Number(v)*1024,0)
  } finally {await session.detach()}
}
await mkdir('test-results/batch-images', { recursive: true })
try {
  browser = await chromium.launch({ channel: process.env.EASYM_TEST_BROWSER || undefined }); report.browser = browser.version()
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = [], remote = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('request', req => { if (/^https?:/.test(req.url()) && !req.url().startsWith(server.url)) remote.push(req.url()) })
  await page.addInitScript(() => {
    window.isTauri = true; window.batchCalls = []; window.batchEnabled = true; window.batchMode = ''; window.batchAssets = {}; window.batchMetadata = { schemaVersion: 1, instances: [] }; window.batchRevision = 'base'
    window.batchBody = '# 批图 😀\n\n![透明图](assets/img-transparent.png "透明标题")\n\n![同图][p]\n\n![照片](assets/img-photo.jpg)\n\n![远程](https://invalid.example/a.png)\n\n![缺图](assets/img-missing.png)\n\n[p]: assets/img-transparent.png "引用标题"'
    const encoder = new TextEncoder(); let callback = 0
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
    const OriginalWorker = window.Worker
    window.batchWorkerHold = false; window.batchWorkerTerminated = 0
    window.Worker = class extends OriginalWorker {
      postMessage(message, ...args) { if (message.encoding && window.batchWorkerHold) { this.held = true; return } super.postMessage(message, ...args) }
      terminate() { if (this.held) window.batchWorkerTerminated++; super.terminate() }
    }
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } }, transformCallback: () => ++callback,
      invoke: async (command, args) => {
        if (command === 'recent_state') return { entries: [], session: { tabs: [], activeDraftKey: null, workspaceId: null } }
        if (command === 'remember_session') return

        window.batchCalls.push({ command, args })
        if (command.startsWith('plugin:window|is_')) return false
        if (command.startsWith('plugin:')) return 1
        if (command === 'open_document' || command === 'reload_document') return { id: 'batch-file', name: '批图.md', bytes: [...encoder.encode(window.batchBody)], revision: window.batchRevision, metadata: window.batchMetadata }
        if (command === 'read_image') {
          const bytes = window.batchAssets[args.relativePath]; if (!bytes) throw 'resource_missing'
          return { bytes, mime: args.relativePath.endsWith('.jpg') ? 'image/jpeg' : 'image/png' }
        }
        if (command === 'save_document') {
          if (window.batchMode === 'conflict') throw 'revision_conflict'
          window.batchBody = new TextDecoder().decode(new Uint8Array(args.bytes)); window.batchRevision = 'saved-' + Date.now(); window.batchMetadata = args.metadata
          args.assets.forEach(a => window.batchAssets[a.path] = a.bytes)
          return { id: 'batch-file', name: '批图.md', revision: window.batchRevision }
        }
        if (command === 'inspect_document') return { revision: window.batchRevision, bytes: window.batchRevision === args.expectedRevision ? null : [...encoder.encode(window.batchBody)] }
        if (command === 'close_document') return
        if (command === 'history_directory') return { path: '/fixture/.easym/history', documentDirectory: '/fixture', custom: false }
        if (command === 'history_operation') {
          const r = args.request
          if (r.action === 'status') return { enabled: window.batchEnabled, readOnly: false, usedBytes: 0, budgetBytes: 512 * 1024 * 1024, paused: false, snapshots: [], orphans: [] }
          if (r.action === 'batchRecord') return null
          if (r.action === 'batchCommit') {
            if (window.batchMode === 'conflict' || r.expectedRevision !== window.batchRevision) throw 'revision_conflict'
            if (window.batchMode === 'quota') throw 'history_quota'
            if (window.batchMode === 'delay') await new Promise(resolve => { window.resolveBatchCommit = resolve })
            window.batchBody = new TextDecoder().decode(new Uint8Array(r.next.bytes)); window.batchRevision = 'batch-' + Date.now(); window.batchMetadata = r.next.metadata
            r.next.assets.forEach(a => window.batchAssets[a.path] = a.bytes)
            return { revision: window.batchRevision, preSnapshotId: 'pre-batch' }
          }
        }
        throw new Error(`Unexpected command ${command}`)
      },
    }
  })
  await acknowledgeGuide(page)
  await page.goto(server.url)
  await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(400, 200), ctx = canvas.getContext('2d')
    ctx.fillStyle = '#e33'; ctx.fillRect(0, 0, 200, 200)
    window.batchAssets['assets/img-transparent.png'] = [...new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())]
    ctx.fillStyle = '#396'; ctx.fillRect(200, 0, 200, 200)
    const jpeg = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg' })).arrayBuffer())
    // EXIF marker, including orientation 1; canvas output must remove it.
    const exif = new Uint8Array([255,225,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,1,0,0,0,0,0,0,0])
    window.batchAssets['assets/img-photo.jpg'] = [...jpeg.slice(0,2), ...exif, ...jpeg.slice(2)]
  })
  const menu = async name => { await page.getByRole('button', { name: 'EM 菜单', exact: true }).click(); await page.getByRole('menuitem', { name, exact: true }).click() }
  const dialog = page.getByRole('dialog', { name: '批量处理图片', exact: true })
  const idle = () => page.waitForFunction(() => document.querySelector('.batch-dialog')?.getAttribute('aria-busy') === 'false')
  const editor = () => page.locator('.document-panel:not([hidden]) [aria-label="Markdown 源码编辑器"]')
  const body = () => editor().evaluate(e => [...e.querySelectorAll('.cm-line')].map(l => l.textContent).join('\n'))
  const open = async () => { await menu('批量处理图片'); await dialog.waitFor(); await idle() }
  await open(); assert.match(await dialog.innerText(), /先.*保存/); await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' })
  await menu('打开文件'); await page.getByRole('tab', { name: '批图.md', exact: true }).waitFor()
  const original = await body(), sourceAssets = await page.evaluate(() => structuredClone(window.batchAssets))
  await page.evaluate(() => window.batchEnabled = false); await open(); assert.match(await dialog.innerText(), /启用版本历史/)
  await page.keyboard.press('Escape'); await page.evaluate(() => window.batchEnabled = true); await open()
  assert.equal(await dialog.getByRole('checkbox', { name: '选择图片 4', exact: true }).isDisabled(), true)
  assert.equal(await dialog.getByRole('checkbox', { name: '选择图片 5', exact: true }).isDisabled(), true)
  await dialog.getByRole('spinbutton', { name: '最大长边', exact: true }).fill('100')
  await dialog.getByRole('combobox', { name: '批量输出格式', exact: true }).selectOption('image/jpeg')
  await dialog.getByRole('button', { name: '生成处理对照', exact: true }).click(); await idle()
  assert.match(await dialog.getByRole('alert').innerText(), /背景色/); assert.equal(await body(), original)
  await dialog.getByRole('checkbox', { name: '明确选择 JPEG 背景色', exact: true }).check()
  await dialog.getByRole('button', { name: '生成处理对照', exact: true }).click(); await idle()
  await dialog.getByRole('img', { name: '批量处理后', exact: true }).waitFor()
  assert.match(await dialog.innerText(), /100 × 50/)
  await dialog.getByRole('checkbox', { name: '去除元数据', exact: true }).uncheck()
  assert.equal(await dialog.getByRole('button', { name: '确认整批应用并保存' }).count(), 0)
  await dialog.getByRole('combobox', { name: '批量输出格式', exact: true }).selectOption('keep')
  await dialog.getByRole('button', { name: '生成处理对照', exact: true }).click(); await idle()
  assert.match(await dialog.getByRole('alert').innerText(), /EXIF/); assert.equal(await body(), original)
  await dialog.getByRole('checkbox', { name: '去除元数据', exact: true }).check()
  await dialog.getByRole('button', { name: '生成处理对照', exact: true }).click(); await idle()
  report.checks.push('saved/history capability guards; missing/remote disabled; transparency requires explicit JPEG background; unsafe metadata retention fails; original body preserved')
  for (const theme of ['light', 'dark', 'paper', 'forest']) {
    await page.evaluate(theme => document.querySelector('.application').setAttribute('data-theme', theme), theme)
    await page.screenshot({ path: `test-results/batch-images/${theme}.png` })
  }
  await dialog.getByRole('button', { name: '关闭批量图片', exact: true }).focus(); await page.keyboard.press('Shift+Tab')
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('.batch-dialog')), true)
  await page.evaluate(() => window.batchMode = 'conflict')
  await dialog.getByRole('button', { name: '确认整批应用并保存', exact: true }).click(); await idle()
  assert.match(await dialog.getByRole('alert').innerText(), /外部修改/); assert.equal(await body(), original)
  await page.evaluate(() => window.batchMode = 'quota')
  await dialog.getByRole('button', { name: '确认整批应用并保存', exact: true }).click(); await idle()
  assert.match(await dialog.getByRole('alert').innerText(), /配额/); assert.equal(await body(), original)
  await page.evaluate(() => window.batchMode = 'delay')
  await dialog.getByRole('button', { name: '确认整批应用并保存', exact: true }).click()
  await page.waitForFunction(() => !!window.resolveBatchCommit)
  await page.keyboard.press('Escape'); assert.equal(await dialog.isVisible(), true)
  assert.equal(await dialog.getByRole('button', { name: '关闭批量图片' }).isDisabled(), true)
  await page.evaluate(() => window.resolveBatchCommit()); await dialog.waitFor({ state: 'hidden' })
  const committed = await body(), request = await page.evaluate(() => window.batchCalls.filter(c => c.command === 'history_operation' && c.args.request.action === 'batchCommit').at(-1).args.request)
  assert.equal(request.items.length, 3); assert.equal(request.current.bytes.length, new TextEncoder().encode(original).length)
  assert.notEqual(request.items[0].sourcePath, request.items[1].sourcePath); assert.ok(committed.includes('"透明标题"')); assert.ok(committed.includes('"引用标题"'))
  assert.equal(await page.evaluate(() => window.batchBody), committed)
  for (const [path, bytes] of Object.entries(sourceAssets)) assert.deepEqual(await page.evaluate(path => window.batchAssets[path], path), bytes)
  await editor().press('ControlOrMeta+z'); assert.equal(await body(), original)
  await editor().press('ControlOrMeta+y'); assert.equal(await body(), committed)
  const outputBytes = request.next.assets.find(a => a.path === request.items[2].displayPath).bytes
  assert.equal(outputBytes.some((v, i) => v === 255 && outputBytes[i+1] === 225), false, 'Processed JPEG contains no EXIF APP1')
  report.checks.push('conflict/quota preserve original; commit blocks Escape; distinct shared-reference instances and titles; original asset bytes unchanged; one undo/redo; EXIF removed')
  // New documents start in source mode; image editing requires a visible preview.
  await page.getByRole('button', { name: '分屏', exact: true }).click()
  const previewImage = page.locator('.document-panel:not([hidden]) .preview img[data-resource]').first()
  await previewImage.waitFor({ state: 'visible' })
  await previewImage.evaluate(image => image.decode())
  await page.waitForFunction(() => document.querySelector('.document-panel:not([hidden]) .statusbar')?.textContent.includes('已自动保存'))
  await previewImage.dblclick()
  const imageDialog = page.getByRole('dialog', { name: '编辑图片副本', exact: true }); await imageDialog.waitFor()
  assert.match(await imageDialog.innerText(), /源副本 400 × 200/)
  assert.equal(await imageDialog.getByRole('spinbutton', { name: '输出宽', exact: true }).inputValue(), '100')
  await imageDialog.getByRole('spinbutton', { name: '裁剪宽', exact: true }).fill('200')
  await imageDialog.getByRole('button', { name: '应用修改', exact: true }).waitFor()
  await page.waitForFunction(() => ![...document.querySelectorAll('.image-dialog button')].find(b => b.textContent === '应用修改')?.disabled)
  await imageDialog.getByRole('button', { name: '应用修改', exact: true }).click(); await imageDialog.waitFor({ state: 'hidden' })
  assert.equal(await page.evaluate(() => window.batchMetadata.instances.at(-1).recipe.crop.width), 200)
  report.checks.push('batch resize followed by single-image crop uses correct immutable 400x200 source geometry, not prior recipe twice')
  // Real worker: start and terminate generation while preserving text.
  await open(); const beforeCancel = await body()
  await page.evaluate(() => window.batchWorkerHold = true)
  await dialog.getByRole('button', { name: '生成处理对照' }).click(); await dialog.getByRole('button', { name: '取消生成' }).click(); await idle()
  assert.equal(await body(), beforeCancel)
  assert.equal(await page.evaluate(() => window.batchWorkerTerminated), 1)
  await page.evaluate(() => window.batchWorkerHold = false)
  assert.equal(await dialog.getByRole('button', { name: '确认整批应用并保存' }).count(), 0)
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' }); await page.waitForFunction(() => document.activeElement?.matches('.app-menu-trigger'))
  report.checks.push('generation cancellation terminates worker and releases previews; Escape returns EM focus; dialog keyboard cycle; four theme captures')
  const worker = (await productionWorkers()).find(source => workerKind(source) === 'image')
  report.workerQuality = await page.evaluate(async workerSource => {
    const canvas = new OffscreenCanvas(500, 300), ctx = canvas.getContext('2d'), data = ctx.createImageData(500,300)
    for(let i=0;i<data.data.length;i+=4){data.data[i]=(i*17)%256; data.data[i+1]=(i*31)%256;data.data[i+2]=(i*47)%256;data.data[i+3]=255}
    ctx.putImageData(data,0,0); const source = await canvas.convertToBlob({type:'image/png'})
    async function encode(quality) {
      const url=URL.createObjectURL(new Blob([workerSource],{type:'text/javascript'})), worker=new Worker(url)
      try { return await new Promise((resolve,reject)=>{worker.onmessage=e=>e.data.error?reject(new Error(e.data.error)):resolve(e.data.blob.size); worker.onerror=e=>reject(new Error(e.message));worker.postMessage({source,recipe:{version:1,orientationNormalized:true,rotateDegrees:0,flipHorizontal:false,flipVertical:false,output:{mime:'image/jpeg'}},encoding:{maxSide:8192,format:'image/jpeg',quality,stripMetadata:true,background:null}})}) }
      finally {worker.terminate();URL.revokeObjectURL(url)}
    }
    return { lowBytes:await encode(.2),highBytes:await encode(.95) }
  }, worker)
  assert.notEqual(report.workerQuality.lowBytes, report.workerQuality.highBytes)
  // Restart retains persisted body/recipes without re-encoding.
  const saved = await page.evaluate(() => ({ body: window.batchBody, assets: window.batchAssets, metadata: window.batchMetadata, revision: window.batchRevision }))
  await page.reload(); await page.evaluate(saved => { window.batchBody = saved.body; window.batchAssets = saved.assets; window.batchMetadata = saved.metadata; window.batchRevision = saved.revision }, saved)
  await menu('打开文件'); await page.getByRole('tab', { name: '批图.md', exact: true }).waitFor()
  assert.equal(await body(), saved.body)
  // 101 shared instances: exactly 100 selectable/generated, input dedup retained.
  await page.evaluate(() => { window.batchBody = Array.from({length:101}, (_, i) => `![图 ${i}](assets/img-transparent.png)`).join('\n\n'); window.batchRevision = 'benchmark'; window.batchMetadata = {schemaVersion:1,instances:[]} })
  await menu('重新加载外部版本'); await page.waitForFunction(() => document.querySelector('.document-panel:not([hidden]) .cm-line')?.textContent.includes('图 0') && document.querySelector('.document-panel:not([hidden]) .statusbar')?.textContent.includes('201 行'))
  await open()
  assert.equal(await dialog.getByRole('checkbox', { checked: true }).count(), 101) // 100 instances plus strip-metadata option
  assert.equal(await dialog.getByRole('checkbox', { name: '选择图片 101', exact: true }).isDisabled(), true)
  await dialog.getByRole('spinbutton', { name: '最大长边' }).fill('100')
  const memorySamples = [], baselineBytes = await sampleMemory(browser);let sampling=true
  const sampler=(async()=>{while(sampling){const value=await sampleMemory(browser);if(value!==null)memorySamples.push(value);if(sampling)await new Promise(resolve=>setTimeout(resolve,250))}})()
  await page.evaluate(()=>{window.batchFrameTimes=[];window.batchSampleFrames=true;const next=()=>{if(!window.batchSampleFrames)return;window.batchFrameTimes.push(performance.now());requestAnimationFrame(next)};requestAnimationFrame(next)})
  const start = Date.now(); await dialog.getByRole('button', { name: '生成处理对照' }).click(); await idle(); const generateMs = Date.now() - start
  sampling=false;await sampler
  const frameTimes=await page.evaluate(()=>{window.batchSampleFrames=false;return window.batchFrameTimes}), intervals=frameTimes.slice(1).map((t,i)=>t-frameTimes[i]).sort((a,b)=>a-b)
  assert.equal(await dialog.getByRole('combobox', { name: '对照图片' }).locator('option').count(), 100)
  report.batchPerformance = { instances:100, sourceWidth:400, sourceHeight:200, outputWidth:100, outputHeight:50, generateMs, frameSamples:intervals.length,frameIntervalP95Ms:intervals[Math.ceil(intervals.length*.95)-1],memory:{metric:'sum of Chromium process RSS/Windows working set; sampled peak is a lower bound and shared pages may be counted multiple times',baselineBytes,peakBytes:Math.max(baselineBytes??0,...memorySamples),samples:memorySamples.length}, scope:'Wall time for actual serial worker generation, hashes and UI. Fixture input is shared and small; this is not a large-photo/WebView peak guarantee.' }
  await page.keyboard.press('Escape'); await dialog.waitFor({state:'hidden'})
  report.checks.push('persisted body and image recipes reload without encoding; 101 shared instances enforce 100 selected; actual 100-worker generation timing recorded')
  // Keyboard-only menu, sidebar width, reading focus and reduced motion.
  const em = page.getByRole('button', {name:'EM 菜单',exact:true})
  await em.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('End')
  assert.equal(await page.evaluate(() => document.activeElement.textContent === '设置'),true)
  const menuItems = await page.getByRole('menu', { name: '文件菜单', exact: true }).getByRole('menuitem').count()
  for (let i = 0; i < menuItems && !await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === '导出'); i++) await page.keyboard.press('ArrowUp')
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label') === '导出'),true)
  await page.keyboard.press('ArrowRight'); await page.getByRole('menu',{name:'导出格式',exact:true}).waitFor()
  await page.keyboard.press('ArrowLeft'); assert.equal(await page.getByRole('menu',{name:'导出格式',exact:true}).count(),0)
  await page.keyboard.press('Escape'); await page.waitForFunction(()=>document.activeElement?.matches('.app-menu-trigger'))
  await page.getByRole('button',{name:'展开文件栏',exact:true}).click()
  const resize = page.getByRole('separator',{name:'调整文件栏宽度',exact:true}); await resize.focus(); const oldWidth=Number(await resize.getAttribute('aria-valuenow'))
  await page.keyboard.press('ArrowRight'); assert.ok(Number(await resize.getAttribute('aria-valuenow'))>oldWidth)
  const reading = page.getByRole('button',{name:'阅读模式',exact:true}); await reading.focus(); await page.keyboard.press('Enter')
  await page.getByRole('button',{name:'退出阅读模式',exact:true}).waitFor(); await page.waitForFunction(()=>document.activeElement?.textContent==='退出阅读模式')
  assert.equal(await editor().isVisible(),false); await page.keyboard.press('Escape'); await page.waitForFunction(()=>document.activeElement?.textContent==='阅读模式')
  await page.emulateMedia({reducedMotion:'reduce'}); assert.equal(await em.evaluate(e=>getComputedStyle(e).transitionDuration),'0s')
  report.checks.push('keyboard EM/export navigation, separator arrows and ARIA width, read-only reading enter/exit focus, prefers-reduced-motion')
  assert.deepEqual(errors, []); assert.deepEqual(remote, []); report.passed = true
  console.log('Batch images production UI, workers, transparency/metadata, atomic apply and undo/redo pass.')
} catch(error) {report.error=error.message;await page?.screenshot({path:'test-results/batch-images/failure.png'}).catch(()=>{});console.error(await page?.locator('body').innerText().catch(()=>''));throw error}
finally {report.finishedAt=new Date().toISOString();await writeFile('test-results/batch-images-verification.json',JSON.stringify(report,null,2)+'\n');await browser?.close();await server.close()}
