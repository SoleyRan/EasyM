import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, copyFile } from 'node:fs/promises'

// Capture this frozen development delivery only after record-build.mjs.
const output = 'Docs/verification/v0.5/step-4'
const logs = 'test-results/v05-step4'
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const pkg = await json('package.json')
assert.equal(pkg.version, '0.5.0')
const build = await json(`${output}/windows-build.json`)
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
assert.equal(build.version, pkg.version)
assert.equal(build.sourceCommit, head)
const logHashes = {}
for (const name of ['typecheck', 'frontend-tests', 'desktop-build', 'regression', 'rust-tests', 'release', 'performance', 'search-slow', 'templates-slow', 'word', 'native-startup', 'bundle', 'portable']) {
  const bytes = await readFile(`${logs}/${name}.log`)
  logHashes[name] = { path: `${logs}/${name}.log`, bytes: bytes.length, sha256: hash(bytes) }
}
const frontend = await readFile(`${logs}/frontend-tests.log`, 'utf8')
const rust = await readFile(`${logs}/rust-tests.log`, 'utf8')
const files = Number(frontend.match(/Test Files\s+(\d+) passed/)?.[1])
const tests = Number(frontend.match(/Tests\s+(\d+) passed/)?.[1])
const rustTests = Math.max(...[...rust.matchAll(/test result: ok\. (\d+) passed; 0 failed/g)].map(match => Number(match[1])))
assert.ok(files >= 45 && tests >= 252 && rustTests >= 65)
assert.ok(!/Test Files.*failed/.test(frontend) && !rust.includes('test result: FAILED'))
assert.match(await readFile(`${logs}/release.log`, 'utf8'), /EasyM 0\.5\.0: .*versions agree/)
const regression = await json(`${output}/regression-verification.json`)
assert.equal(regression.passed, true)
assert.equal(regression.version, pkg.version)
assert.equal(regression.checks.length, 23)
assert.ok(regression.checks.every(item => item.passed))
assert.equal(regression.distIndexSha256, hash(await readFile('dist/index.html')))
const reports = {}
for (const name of ['performance', 'search-slow', 'templates-slow']) {
  const file = `${name}-verification.json`
  const report = await json(`test-results/${file}`)
  assert.equal(report.passed, true)
  if (name === 'performance') {
    assert.ok(Date.parse(report.verifiedAt) >= Date.parse(regression.startedAt))
    assert.ok(report.cases.filter(item => 'targetMet' in item).every(item => item.targetMet && item.targetMs === 50))
  }
  await copyFile(`test-results/${file}`, `${output}/${file}`)
  reports[name] = report
}
const word = await json('test-results/docx-ui/word-verification.json')
assert.equal(word.passed, true)
assert.equal(word.checks.length, 5)
assert.ok(Date.parse(word.verifiedAt) >= Date.parse(regression.startedAt))
await copyFile('test-results/docx-ui/word-verification.json', `${output}/word-verification.json`)
const native = await json(`${output}/native-startup-verification.json`)
const portable = await json(`${output}/portable-verification.json`)
for (const report of [native, portable]) { assert.equal(report.passed, true); assert.equal(report.version, pkg.version) }
assert.equal(native.isolatedNativeRegistry, true)
const metadata = await json(`${logs}/package-metadata.json`)
assert.equal(metadata.artifacts.length, 2)
for (const artifact of metadata.artifacts) {
  assert.equal(artifact.productVersion, pkg.version)
  assert.equal(artifact.productName, 'EasyM')
  assert.equal(artifact.sha256, hash(await readFile(artifact.path)))
}
for (const path of [`src-tauri/target/release/bundle/nsis/EasyM_${pkg.version}_x64-setup.exe`, portable.archive]) {
  const item = build.artifacts.find(item => item.path === path)
  assert.ok(item, `Missing packaged artifact: ${path}`)
  assert.equal(item.sha256, hash(await readFile(path)))
}
const dependencies = await json(`${output}/dependency-comparison.json`)
assert.equal(dependencies.dependencies, 430)
assert.equal(dependencies.inventory.completeLicenseTexts, true)
assert.equal(dependencies.added.length + dependencies.removed.length + dependencies.licenseChanges.length, 0)
const guide = await json(`${logs}/guide-verification.json`)
assert.equal(guide.passed, true)
assert.equal(guide.pages.length, 4)
await copyFile(`${logs}/guide-verification.json`, `${output}/guide-verification.json`)
const summary = {
  recordedAt: new Date().toISOString(), stage: 'v0.5-step-4', version: pkg.version,
  source: { branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(), baseCommit: head, uncommittedStep4Changes: true, sourceTree: build.sourceTree },
  localDevelopmentAcceptancePassed: true, formalReleaseReady: false,
  checks: { typecheck: true, productionBuild: true, productionBuildLog: `${logs}/desktop-build.log`, versionAgreement: true, frontend: { files, tests, passed: true }, windowsRust: { tests: rustTests, passed: true, locked: true, offline: true }, regression, performance: reports.performance, slowInitialization: { search: reports['search-slow'].passed, templates: reports['templates-slow'].passed }, compactGuide: guide, word: { passed: true, samples: word.checks.length, fileVersion: word.fileVersion, scope: 'Dedicated hidden Word COM: open, repaginate, edit and reopen; other office software and visual layout remain manual.' }, nativeStartup: native, portable, packageMetadata: metadata },
  dependencies: { target: dependencies.target, versions: dependencies.dependencies, added: [], removed: [], licenseChanges: [], missingWindowsTexts: 0 },
  logHashes,
  ci: { status: 'pending_commit_and_push', currentRun: null, scope: 'Three-platform build/test, platform notices and Windows disposable installer install/remove are configured but not run for these changes.' },
  pending: ['Current-source remote CI and Windows isolated installation/removal', 'Real IME, OS open/save/export/print dialogs and permission changes', 'Real crash recovery and end-to-end native conflict/image/history workflows', 'macOS/Linux GUI and assistive technology', 'Specified WPS/LibreOffice versions and visual pagination acceptance', 'Existing macOS 12 missing complete license texts and platform distribution review', 'Release signing, notarization and update strategy'],
}
await writeFile(`${output}/acceptance-summary.json`, JSON.stringify(summary, null, 2) + '\n')
console.log(`EasyM ${pkg.version}: ${tests} frontend / ${rustTests} Rust / ${regression.checks.length} production groups; Windows packages verified; CI and manual release gates pending.`)
