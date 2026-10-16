import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''))
const verify = process.argv[2] === '--verify'
const output = resolve(verify ? process.argv[3] : process.argv[2] ?? 'test-results/release')
if (!verify) {
  const { version } = await json('package.json')
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  // CI regenerates target-specific notices before packaging. No other tracked
  // source may differ from the tested commit; local candidates retain all dirt.
  const sourceChanges = [
    execFileSync('git', ['diff', 'HEAD', '--name-only'], { encoding: 'utf8' }),
    execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' }),
  ].join('\n').trim().split(/\r?\n/).filter(Boolean)
  const sourceDirty = sourceChanges.some(path => !process.env.CI || !path.startsWith('Docs/dependencies/'))
  if (process.env.CI) assert.equal(sourceDirty, false, 'CI release candidate must use committed sources')
  const executable = await readFile('src-tauri/target/release/easym.exe')
  const reports = {}
  for (const name of ['native-startup', 'native-extensions', 'portable']) {
    const report = await json(`test-results/${name}-verification.json`)
    assert.equal(report.version, version, name)
    assert.equal(report.passed, true, name)
    assert.equal(report.executableSha256, hash(executable), name)
    reports[name] = report
  }
  if (process.env.CI) {
    const report = await json('test-results/installer-verification.json')
    assert.equal(report.passed, true)
    assert.equal(report.version, version)
    reports.installer = report
  }
  await mkdir(output, { recursive: true })
  const artifacts = []
  for (const [name, source] of [
    [`EasyM_${version}_x64-setup.exe`, `src-tauri/target/release/bundle/nsis/EasyM_${version}_x64-setup.exe`],
    [`EasyM-${version}-windows-x64.zip`, `src-tauri/target/release/bundle/portable/EasyM-${version}-windows-x64.zip`],
  ]) {
    const bytes = await readFile(source)
    if (name.endsWith('.zip')) assert.equal(hash(bytes), reports.portable.sha256)
    if (reports.installer && name.endsWith('.exe')) assert.equal(hash(bytes), reports.installer.installerSha256)
    artifacts.push({ name, bytes: bytes.length, sha256: hash(bytes) })
    await copyFile(source, resolve(output, name))
  }
  await copyFile('Docs/Easy-Markdown-v1.0-发行说明.md', resolve(output, 'RELEASE-NOTES.md'))
  const notes = await readFile(resolve(output, 'RELEASE-NOTES.md'))
  artifacts.push({ name: 'RELEASE-NOTES.md', bytes: notes.length, sha256: hash(notes) })
  await writeFile(resolve(output, 'release-manifest.json'), JSON.stringify({
    version, sourceCommit, sourceDirty, target: 'x86_64-pc-windows-msvc', signed: false,
    automaticUpdates: false, createdAt: new Date().toISOString(), executableSha256: hash(executable),
    artifacts, checks: Object.fromEntries(Object.entries(reports).map(([name, report]) => [name, { passed: report.passed, verifiedAt: report.verifiedAt }])),
  }, null, 2) + '\n')
  const manifest = await readFile(resolve(output, 'release-manifest.json'))
  await writeFile(resolve(output, 'SHA256SUMS.txt'), [...artifacts, { name: 'release-manifest.json', sha256: hash(manifest) }].map(item => `${item.sha256}  ${item.name}\n`).join(''))
}
const manifest = await json(resolve(output, 'release-manifest.json'))
assert.match(manifest.version, /^1\.0\.\d+$/)
assert.match(manifest.sourceCommit, /^[a-f0-9]{40}$/)
assert.equal(manifest.target, 'x86_64-pc-windows-msvc')
assert.equal(manifest.signed, false)
assert.equal(manifest.automaticUpdates, false)
if (verify) {
  assert.equal(manifest.sourceCommit, process.argv[4], 'Candidate must match the requested CI commit')
  assert.equal(manifest.sourceDirty, false)
  assert.equal(manifest.checks.installer?.passed, true, 'CI install/remove evidence required')
}
const expected = [`EasyM_${manifest.version}_x64-setup.exe`, `EasyM-${manifest.version}-windows-x64.zip`, 'RELEASE-NOTES.md']
assert.deepEqual(manifest.artifacts.map(item => item.name), expected)
for (const name of ['native-startup', 'native-extensions', 'portable']) assert.equal(manifest.checks[name]?.passed, true)
const sums = []
for (const item of manifest.artifacts) {
  const bytes = await readFile(resolve(output, item.name))
  assert.equal(bytes.length, item.bytes, item.name)
  assert.equal(hash(bytes), item.sha256, item.name)
  sums.push(`${item.sha256}  ${item.name}\n`)
}
sums.push(`${hash(await readFile(resolve(output, 'release-manifest.json')))}  release-manifest.json\n`)
assert.equal(await readFile(resolve(output, 'SHA256SUMS.txt'), 'utf8'), sums.join(''))
console.log(`Verified EasyM ${manifest.version} Windows release files for ${manifest.sourceCommit}${manifest.sourceDirty ? ' (local modified sources; not publishable)' : ''}.`)
