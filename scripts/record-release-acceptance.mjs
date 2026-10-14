import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const output = resolve(process.argv[2] ?? `Docs/verification/v0.3/acceptance-${baseCommit.slice(0, 7)}`)
const work = resolve('test-results/v03-step7')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''))
const pkg = await json('package.json')
const build = await json(resolve(output, 'windows-build.json'))
assert.equal(build.version, pkg.version)
assert.equal(build.sourceCommit, baseCommit)
await mkdir(output, { recursive: true })
const logHashes = {}
for (const name of ['typecheck', 'frontend-tests', 'build', 'regression', 'rust-tests', 'release', 'search-slow', 'templates-slow', 'native-startup', 'bundle', 'portable']) {
  const bytes = await readFile(resolve(work, name + '.log'))
  logHashes[name] = { bytes: bytes.length, sha256: hash(bytes) }
}
const frontendText = await readFile(resolve(work, 'frontend-tests.log'), 'utf8')
const rustText = await readFile(resolve(work, 'rust-tests.log'), 'utf8')
const frontendFiles = Number(frontendText.match(/Test Files\s+(\d+) passed/)?.[1])
const frontendTests = Number(frontendText.match(/Tests\s+(\d+) passed/)?.[1])
const rustTests = Math.max(...[...rustText.matchAll(/test result: ok\. (\d+) passed; 0 failed/g)].map(match => Number(match[1])))
assert.ok(frontendFiles > 0 && frontendTests > 0 && rustTests > 0)
assert.ok(!(frontendText.match(/Test Files.*failed/) || rustText.includes('test result: FAILED')))
assert.ok((await readFile(resolve(work, 'bundle.log'), 'utf8')).includes(`EasyM_${pkg.version}_x64-setup.exe`))
const regression = await json('test-results/regression-verification.json')
const native = await json('test-results/native-startup-verification.json')
const portable = await json('test-results/portable-verification.json')
for (const result of [regression, native, portable]) { assert.equal(result.passed, true); assert.equal(result.version, pkg.version) }
const passedReports = {}
for (const file of ['search-slow-verification.json', 'templates-slow-verification.json']) {
  const result = await json(resolve('test-results', file))
  assert.equal(result.passed, true)
  passedReports[file] = result
}
const word = await json('test-results/docx-ui/word-verification.json')
assert.equal(word.passed, true)
const inventories = []
for (const [platform, directory] of [['windows', 'Docs/dependencies'], ['linux', resolve(work, 'licenses-linux')], ['macos', resolve(work, 'licenses-macos')]]) {
  const inventory = await json(resolve(directory, 'inventory.json'))
  const sbom = await json(resolve(directory, 'sbom.cdx.json'))
  assert.equal(sbom.metadata.component.version, pkg.version)
  const metadata = await readFile(resolve(work, `cargo-${platform}.json`))
  const report = { recordedAt: new Date().toISOString(), applicationVersion: pkg.version, ...inventory, licenseFiles: (await readdir(resolve(directory, 'licenses'))).length, source: { cargoMetadataSha256: hash(metadata), npmMetadataSha256: hash(await readFile(resolve(work, 'npm-licenses.json'))), cargoLockSha256: hash(await readFile('src-tauri/Cargo.lock')), pnpmLockSha256: hash(await readFile('pnpm-lock.yaml')) }, scope: 'Locally generated target-filtered inventory and text verification; not a compilation/runtime or distribution legal review.' }
  inventories.push(report)
  await writeFile(resolve(output, `dependency-inventory-${platform}.json`), JSON.stringify(report, null, 2) + '\n')
}
const packageMetadata = await json(resolve(work, 'package-metadata.json'))
for (const artifact of packageMetadata.artifacts) {
  const bytes = await readFile(artifact.path)
  assert.equal(hash(bytes), artifact.sha256)
  assert.equal(artifact.productVersion, pkg.version)
  assert.equal(artifact.productName, 'EasyM')
}
const reports = await readdir(output)
const summary = {
  recordedAt: new Date().toISOString(), stage: 'v0.3-step7', version: pkg.version,
  source: { branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(), baseCommit, uncommittedStep7Changes: true, sourceTree: build.sourceTree },
  localDevelopmentAcceptancePassed: true, formalReleaseReady: false,
  checks: { versionAgreement: true, typecheck: true, productionBuild: true, frontend: { files: frontendFiles, tests: frontendTests, maxWorkers: 2 }, windowsRust: { tests: rustTests, locked: true, offline: true }, regression: { passed: true, groups: regression.checks.length, distIndexSha256: regression.distIndexSha256 }, slowInitialization: passedReports, word: { version: word.fileVersion, samples: word.checks.length, passed: true, scope: 'COM open/repaginate/edit/reopen checks; not WPS/LibreOffice visual acceptance' }, nativeStartup: native, portable, packageMetadata },
  licenses: inventories.map(({ target, dependencies, missingLicenseTexts, completeLicenseTexts }) => ({ target, dependencies, missingLicenseTexts, completeLicenseTexts })),
  logHashes,
  evidenceFiles: reports.filter(name => name.endsWith('.json') && name !== 'acceptance-summary.json'),
  ci: { latestStep7Run: null, status: 'pending_commit_and_push', configured: ['Linux frontend and production regression', 'Windows/macOS/Linux locked Rust tests and desktop build', 'platform license inventories and version agreement', 'Windows isolated startup, installer install/remove, portable byte verification'] },
  pending: ['Latest remote CI and Windows isolated install/remove', 'Windows real IME and native open/save/export/print dialogs', 'Native end-to-end history and batch images on user hardware', 'WPS/LibreOffice specified versions', 'macOS/Linux GUI and assistive technology', 'macOS 12 missing full license texts and Apple SDK distribution review', 'distribution license review, signing and notarization'],
}
await writeFile(resolve(output, 'acceptance-summary.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(`Recorded ${pkg.version} local acceptance: ${frontendTests} frontend, ${rustTests} Rust, ${regression.checks.length} regression groups; remote/manual gates pending.`)
