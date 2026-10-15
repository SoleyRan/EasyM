import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, copyFile, readdir } from 'node:fs/promises'

// Run after record-build.mjs. This preserves the frozen v0.6 local evidence;
// it never claims a remote CI result or a formal release.
const output = 'Docs/verification/v0.6/step-4', logs = 'test-results/v06-step4'
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const pkg = await json('package.json'), build = await json(`${output}/windows-build.json`)
assert.equal(pkg.version, '0.6.0'); assert.equal(build.version, pkg.version)
assert.equal(build.sourceCommit, execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim())
await mkdir(`${output}/logs`, { recursive: true })
const logHashes = {}
for (const name of ['typecheck', 'unit', 'desktop-build', 'rust', 'regression', 'performance', 'search-slow', 'templates-slow', 'release', 'notices', 'word', 'word-extensions', 'native-startup', 'native-extensions', 'bundle', 'portable']) {
  const bytes = await readFile(`${logs}/${name}.log`)
  logHashes[name] = { path: `logs/${name}.log`, bytes: bytes.length, sha256: hash(bytes) }
  await copyFile(`${logs}/${name}.log`, `${output}/logs/${name}.log`)
}
const frontend = await readFile(`${logs}/unit.log`, 'utf8'), rust = await readFile(`${logs}/rust.log`, 'utf8')
const files = Number(frontend.match(/Test Files\s+(\d+) passed/)?.[1])
const tests = Number(frontend.match(/Tests\s+(\d+) passed/)?.[1])
const rustTests = Math.max(...[...rust.matchAll(/test result: ok\. (\d+) passed; 0 failed/g)].map(match => Number(match[1])))
assert.ok(files > 0 && tests > 0 && rustTests > 0)
assert.ok(!/Test Files.*failed/.test(frontend) && !rust.includes('test result: FAILED'))
assert.match(await readFile(`${logs}/release.log`, 'utf8'), /EasyM 0\.6\.0: .*versions agree/)
const regression = await json(`${output}/regression-verification.json`)
assert.equal(regression.passed, true); assert.equal(regression.version, pkg.version)
assert.ok(regression.checks.some(check => check.script === 'extension-delivery'))
assert.ok(regression.checks.every(check => check.passed))
assert.equal(regression.distIndexSha256, hash(await readFile('dist/index.html')))
const reports = {}
for (const name of ['performance', 'search-slow', 'templates-slow', 'native-startup', 'native-extensions', 'portable', 'extension-delivery']) {
  const file = `${name}-verification.json`, report = await json(`test-results/${file}`)
  assert.equal(report.passed, true, name)
  if (!name.startsWith('native-')) assert.ok(Date.parse(report.verifiedAt) >= Date.parse(regression.startedAt), `${name} must be from this acceptance run`)
  if (['native-startup', 'native-extensions', 'portable', 'extension-delivery'].includes(name)) assert.equal(report.version, pkg.version)
  if (name === 'performance') {
    assert.ok(Date.parse(report.verifiedAt) >= Date.parse(regression.startedAt))
    assert.ok(report.cases.filter(item => 'targetMet' in item).every(item => item.targetMet))
  }
  await copyFile(`test-results/${file}`, `${output}/${file}`); reports[name] = report
}
for (const [name, directory] of [['word', 'docx-ui'], ['word-extensions', 'extension-delivery']]) {
  const report = await json(`test-results/${directory}/word-verification.json`)
  assert.equal(report.passed, true, name)
  assert.ok(Date.parse(report.verifiedAt) >= Date.parse(regression.startedAt), `${name} must verify the current exports`)
  assert.equal(report.checks.length, name === 'word' ? 5 : 1)
  await copyFile(`test-results/${directory}/word-verification.json`, `${output}/${name}-verification.json`)
  reports[name] = report
}
const inventory = await json('Docs/dependencies/inventory.json')
assert.equal(inventory.target, 'x86_64-pc-windows-msvc'); assert.equal(inventory.completeLicenseTexts, true)
const metadata = await json(`${logs}/package-metadata.json`)
assert.equal(metadata.artifacts.length, 2)
for (const item of metadata.artifacts) {
  assert.equal(item.productName, 'EasyM'); assert.equal(item.productVersion, pkg.version)
  assert.equal(item.sha256, hash(await readFile(item.path)))
}
for (const path of [`src-tauri/target/release/bundle/nsis/EasyM_${pkg.version}_x64-setup.exe`, reports.portable.archive]) {
  assert.equal(build.artifacts.find(item => item.path === path)?.sha256, hash(await readFile(path)))
}
assert.equal(reports.portable.executableSha256, reports['native-extensions'].executableSha256)
await copyFile(`${logs}/package-metadata.json`, `${output}/package-metadata.json`)
const exports = []
for (const directory of ['extension-delivery', 'math', 'mermaid', 'docx-ui']) {
  for (const name of await readdir(`test-results/${directory}`)) {
    if (!/\.(?:html|pdf|docx)$/.test(name)) continue
    const path = `test-results/${directory}/${name}`, bytes = await readFile(path)
    exports.push({ path, bytes: bytes.length, sha256: hash(bytes) })
  }
}
await writeFile(`${output}/export-artifacts.json`, JSON.stringify(exports, null, 2) + '\n')
for (const directory of ['extension-delivery', 'native-extensions']) {
  await mkdir(`${output}/screenshots/${directory}`, { recursive: true })
  for (const name of await readdir(`test-results/${directory}`)) {
    if (/\.png$/.test(name) && name !== 'failure.png') await copyFile(`test-results/${directory}/${name}`, `${output}/screenshots/${directory}/${name}`)
  }
}
// Small inspectable standalone deliverables are included; large Word suites
// remain locally available with their hashes rather than duplicating binaries.
await mkdir(`${output}/exports`, { recursive: true })
for (const name of ['combined.html', 'combined.pdf', 'combined.docx', 'combined-word.pdf', 'disabled.html']) {
  await copyFile(`test-results/extension-delivery/${name}`, `${output}/exports/${name}`)
}
await writeFile(`${output}/acceptance-summary.json`, JSON.stringify({
  recordedAt: new Date().toISOString(), stage: 'v0.6-step-4', version: pkg.version,
  source: { branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(), baseCommit: build.sourceCommit, uncommittedStep4Changes: true, sourceTree: build.sourceTree },
  localDevelopmentAcceptancePassed: true, formalReleaseReady: false,
  checks: { frontend: { files, tests, passed: true }, windowsRust: { tests: rustTests, passed: true, locked: true, offline: true }, regression, reports, dependencyInventory: inventory, packageMetadata: metadata },
  logs: logHashes,
  pending: ['Current source has not been pushed; three-platform CI and disposable Windows install/remove pending.', 'Real IME, native file/print dialogs and pagination, screen reader and macOS/Linux GUI remain manual acceptance.', 'macOS/Linux dependency notices must be generated on their own targets; inherited macOS missing license texts remain a release gate.', 'Unsigned development build; signing and formal release review pending.'],
}, null, 2) + '\n')
console.log(`Archived v0.6: ${tests} frontend tests, ${rustTests} Windows Rust tests, ${regression.checks.length} production groups; development acceptance only.`)
