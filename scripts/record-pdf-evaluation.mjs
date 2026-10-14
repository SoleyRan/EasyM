import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve('test-results/pdf-engines'), tools = resolve(root, 'tools')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const generation = JSON.parse(await readFile(resolve(root, 'generation.json'), 'utf8'))
const inspection = JSON.parse(await readFile(resolve(root, 'inspection.json'), 'utf8'))
assert.equal(generation.passed, true)
assert.equal(inspection.results.length, 18)
for (const item of inspection.results) {
  assert.equal(hash(await readFile(resolve(root, item.filename))), item.sha256)
  assert.equal(item.renderedPages, item.pages)
  assert.deepEqual(item.unsafeAnnotationActions, [])
  if (item.fixture === 'stress') {
    assert.equal(item.rowIdsFound, 85)
    assert.equal(item.codeIdsFound, 60)
    if (item.engine !== 'pagedjs') assert.deepEqual(item.missingSentinels, [])
    else assert.deepEqual(item.missingSentinels, ['FINAL-SENTINEL', '中文结束'])
  }
}
const require = createRequire(resolve(tools, 'package.json')), fontkit = require('fontkit')
const font = fontkit.openSync(resolve(tools, 'NotoSansSC-Regular.otf'))
const lock = JSON.parse(await readFile('scripts/fixtures/pdf-evaluation/package-lock.json', 'utf8'))
const packages = []
for (const [path, item] of Object.entries(lock.packages)) {
  if (!path) continue
  const entry = { path, version: item.version, resolved: item.resolved, integrity: item.integrity, declaredLicense: item.license ?? null, licenseTexts: [] }
  for (const filename of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-MIT', 'LICENSE-ZLIB', 'LICENSE.zlib', 'COPYING', 'COPYING.LESSER', 'License.txt']) {
    try {
      const bytes = await readFile(resolve(tools, path, filename))
      entry.licenseTexts.push({ filename, bytes: bytes.length, sha256: hash(bytes) })
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  // png-js omits package.json license, but ships the full MIT text.
  if (path === 'node_modules/png-js') entry.textLicense = 'MIT'
  packages.push(entry)
}
await mkdir('Docs/verification/pdf-engine-licenses', { recursive: true })
for (const [target, source] of [
  ['pagedjs-0.4.3-MIT.txt', 'node_modules/pagedjs/LICENSE.md'],
  ['pdfmake-0.3.11-MIT.txt', 'node_modules/pdfmake/LICENSE'],
  ['NotoSansSC-OFL-1.1.txt', 'Noto-LICENSE.txt'],
]) await writeFile(resolve('Docs/verification/pdf-engine-licenses', target), await readFile(resolve(tools, source)))
const report = {
  ...generation,
  sourceState: { branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(), baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), description: 'Step 6 evaluation scripts/docs uncommitted on step 5 commit; no application runtime changes.' },
  passed: undefined,
  evaluationCompleted: true,
  productionEngineAdopted: false,
  decision: 'retain_system_printing_defer_dedicated_engine',
  pdfProductionReadiness: { pagedjs: false, pdfmakeAdapter: false, nativeSystemPrintDialogsTestedHere: false },
  fontEvidence: { version: font.version, embeddingFlags: font['OS/2'].fsType, emojiCoverage: Object.fromEntries(['🙂', '🚀', '✅'].map(char => [char, font.hasGlyphForCodePoint(char.codePointAt(0))])), source: 'https://raw.githubusercontent.com/notofonts/noto-cjk/165c01b46ea533872e002e0785ff17e44f6d97d8/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf' },
  memoryScope: { browser: 'before/after summed Chromium working set and final renderer JS heap, neither is a sampled peak or a native WebView measurement', nodeWorker: 'process.resourceUsage().maxRSS is the lifetime high-water mark of the entire shared Node host, not isolated Worker memory; values across runs are not independent peaks' },
  visualReview: { renderedPages: inspection.results.reduce((sum, run) => sum + run.pages, 0), method: 'all PDFs rendered by Poppler at max 800 px; contact-sheet review and selected full-page inspection', findings: ['Paged.js A4 office truncates after code on page 1', 'Paged.js stress A4/Letter loses tall image and final paragraph; repeating table header absent', 'pdfmake Noto-only adapter missing emoji glyphs; inline image is explicitly a text placeholder, regular font reused for all style faces', 'pdfmake A4 stress has blank last page; heading can be orphaned; fit enlargement of small office icon is an adapter limitation', 'system CSS retains complete stress text, full image and emoji; Letter tall-image heading separated from image'] },
  inspections: inspection.results,
  evaluationDependencyPackages: packages,
  pending: ['Windows WebView2 actual save-to-PDF and cancel dialog', 'macOS WKWebView and Linux WebKitGTK print behavior', 'dedicated-engine cross-platform GUI and sampled memory peak', 'full transitive/browser-bundle license and font-distribution review before any adoption', 'font style/emoji fallback, inline-image mapping, keep-with-next and blank-page fixes before structured integration'],
}
await writeFile('Docs/verification/v0.3-step6-verification.json', JSON.stringify(report, null, 2) + '\n')
console.log(`Recorded evaluation: 18 PDFs, ${report.visualReview.renderedPages} rendered pages, ${packages.length} isolated dependency entries; dedicated engine deferred.`)
