import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, copyFile, readdir, stat } from 'node:fs/promises'

// Preserve local development acceptance after record-build.mjs; this does not
// install the application or assert remote CI/manual/formal release acceptance.
const output = 'Docs/verification/v1.0/local', logs = 'test-results/v10'
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const pkg = await json('package.json'), build = await json(`${output}/windows-build.json`)
assert.equal(pkg.version, '1.0.0'); assert.equal(build.version, pkg.version)
assert.equal(build.sourceCommit, git('rev-parse', 'HEAD'))
const regression = await json('test-results/regression-verification.json')
assert.equal(regression.passed, true); assert.equal(regression.version, pkg.version)
assert.equal(regression.checks.length, 31); assert.ok(regression.checks.every(check => check.passed))
assert.equal(regression.distIndexSha256, hash(await readFile('dist/index.html')))
const reports = {}
for (const check of regression.checks) {
  const file = check.script === 'workers' ? 'history-diff-performance.json' : `${check.script}-verification.json`
  const path = `test-results/${file}`, report = await json(path), info = await stat(path)
  assert.notEqual(report.passed, false, file)
  assert.ok(info.mtimeMs >= Date.parse(regression.startedAt), `stale report: ${file}`)
  assert.ok(info.mtimeMs <= Date.parse(regression.finishedAt) + 1000, `report changed after regression: ${file}`)
  await copyFile(path, `${output}/${file}`)
}
for (const name of ['performance', 'focus-slow', 'search-slow', 'templates-slow', 'math-slow', 'native-startup', 'native-extensions', 'portable']) {
  const path = `test-results/${name}-verification.json`, report = await json(path)
  assert.equal(report.passed, true, name)
  assert.ok((await stat(path)).mtimeMs >= Date.parse(regression.finishedAt), `stale post-regression report: ${name}`)
  if (name.startsWith('native-') || name === 'portable') {
    assert.equal(report.version, pkg.version)
    assert.equal(report.executableSha256, build.artifacts.find(item => item.path.endsWith('/easym.exe')).sha256)
  }
  if (name.endsWith('-slow')) assert.equal(report.cpuThrottlingRate, 6)
  if (name === 'performance') assert.ok(report.cases.filter(item => 'targetMet' in item).every(item => item.targetMet))
  await copyFile(path, `${output}/${name}-verification.json`); reports[name] = report
}
assert.equal(reports['native-extensions'].gracefulClose, true)
assert.equal(reports.portable.sampleVersion, 'v1.0')
assert.equal(reports.portable.allStagedFileHashesVerified, true)
for (const [name, directory, count] of [['word', 'docx-ui', 5], ['word-extensions', 'extension-delivery', 1]]) {
  const path = `test-results/${directory}/word-verification.json`, report = await json(path)
  assert.equal(report.passed, true, name); assert.equal(report.checks.length, count)
  assert.ok(Date.parse(report.verifiedAt) >= Date.parse(regression.finishedAt), `stale Word report: ${name}`)
  await copyFile(path, `${output}/${name}-verification.json`); reports[name] = report
}
await mkdir(`${output}/logs`, { recursive: true })
for (const name of ['typecheck', 'unit', 'desktop-build', 'rust', 'regression', 'performance', 'focus-slow', 'search-slow', 'templates-slow', 'math-slow', 'release', 'notices', 'word', 'word-extensions', 'native-startup', 'native-extensions', 'portable']) {
  const bytes = await readFile(`${logs}/${name}.txt`)
  assert.ok(bytes.length > 0, `empty log: ${name}`)
  await copyFile(`${logs}/${name}.txt`, `${output}/logs/${name}.txt`)
}
const frontend = (await readFile(`${logs}/unit.txt`, 'utf8')).replace(/\x1b\[[0-9;]*m/g, ''), rust = await readFile(`${logs}/rust.txt`, 'utf8')
const files = Number(frontend.match(/Test Files\s+(\d+) passed/)?.[1]), tests = Number(frontend.match(/Tests\s+(\d+) passed/)?.[1])
const rustTests = Math.max(...[...rust.matchAll(/test result: ok\. (\d+) passed; 0 failed/g)].map(match => Number(match[1])))
assert.ok(files > 0 && tests > 0 && rustTests > 0)
assert.ok(!/Test Files.*failed/.test(frontend) && !rust.includes('test result: FAILED'))
assert.match(await readFile(`${logs}/release.txt`, 'utf8'), /EasyM 1\.0\.0: .*versions agree/)
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
await copyFile(`${logs}/package-metadata.json`, `${output}/package-metadata.json`)
const exports = []
for (const directory of ['extension-delivery', 'math', 'mermaid', 'docx-ui']) {
  for (const name of await readdir(`test-results/${directory}`)) {
    if (!/\.(?:html|pdf|docx)$/.test(name)) continue
    const path = `test-results/${directory}/${name}`, info = await stat(path)
    if (info.mtimeMs < Date.parse(regression.startedAt)) continue
    const bytes = await readFile(path)
    exports.push({ path, bytes: bytes.length, sha256: hash(bytes) })
  }
}
await writeFile(`${output}/export-artifacts.json`, JSON.stringify(exports, null, 2) + '\n')
for (const directory of ['protection-delivery', 'backup', 'merge', 'native-extensions']) {
  await mkdir(`${output}/screenshots/${directory}`, { recursive: true })
  for (const name of await readdir(`test-results/${directory}`)) {
    if (!name.endsWith('.png') || name === 'failure.png') continue
    const path = `test-results/${directory}/${name}`
    if ((await stat(path)).mtimeMs < Date.parse(regression.startedAt)) continue
    await copyFile(path, `${output}/screenshots/${directory}/${name}`)
  }
}
await writeFile(`${output}/acceptance-summary.json`, JSON.stringify({
  recordedAt: new Date().toISOString(), stage: 'v1.0-local', version: pkg.version,
  source: { branch: git('branch', '--show-current'), baseCommit: build.sourceCommit, sourceDirty: build.sourceDirty, sourceTree: build.sourceTree },
  localDevelopmentAcceptancePassed: true, formalReleaseReady: false,
  checks: { frontend: { files, tests, passed: true }, windowsRust: { tests: rustTests, passed: true, locked: true, offline: true }, regression, reports, dependencyInventory: inventory, packageMetadata: metadata },
  evidenceNotes: ['Each regression report is checked against its run interval and the production index hash; workers also emit to regression.txt. Reports without a passed field are covered by the successful runner exit.', 'Native checks use isolated profiles and test startup/extensions, not the new backup picker workflow. Rust tests cover backup filesystem/archive behavior; browser suites use deterministic native IPC.', 'Source tree and artifact hashes bind the local working tree and packages. Existing repository-wide rustfmt differences are not reformatted or claimed as passing.'],
  pending: ['Current changes have not been pushed; three-platform CI and disposable Windows install/remove pending.', 'Real IME, backup/file/directory/print dialogs, screen reader and macOS/Linux GUI remain manual acceptance.', 'Three target license inventories have full text coverage; Apple SDK and actual cross-platform distribution review remain separate.', 'Unsigned candidate; platform scope, manual acceptance and formal publication remain pending.'],
}, null, 2) + '\n')
const artifacts = []
async function inventoryEvidence(directory, prefix = '') {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix + entry.name
    if (entry.isDirectory()) await inventoryEvidence(`${directory}/${entry.name}`, `${path}/`)
    else if (path !== 'manifest.json') {
      const bytes = await readFile(`${directory}/${entry.name}`)
      artifacts.push({ path, bytes: bytes.length, sha256: hash(bytes) })
    }
  }
}
await inventoryEvidence(output)
await writeFile(`${output}/manifest.json`, JSON.stringify({ recordedAt: new Date().toISOString(), version: pkg.version, baseCommit: build.sourceCommit, sourceDirty: build.sourceDirty, artifacts }, null, 2) + '\n')
console.log(`Archived v1.0: ${tests} frontend tests, ${rustTests} Windows Rust tests, ${regression.checks.length} production groups, ${artifacts.length} evidence artifacts; development acceptance only.`)
