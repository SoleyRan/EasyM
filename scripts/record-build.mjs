import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, readdir, mkdir, copyFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

// Run after build and verification. No absolute machine paths are emitted.
const output = resolve(process.argv[2] ?? 'Docs/verification')
const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'))
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
assert.equal(config.version, pkg.version)
assert.match(await readFile('src-tauri/Cargo.toml', 'utf8'), new RegExp(`^version = "${pkg.version.replaceAll('.', '\\.')}"$`, 'm'))
const regression = JSON.parse(await readFile('test-results/regression-verification.json', 'utf8'))
assert.equal(regression.version, config.version)
assert.equal(regression.passed, true)
assert.equal(regression.distIndexSha256, createHash('sha256').update(await readFile('dist/index.html')).digest('hex'))
await mkdir(output, { recursive: true })
const paths = ['src-tauri/target/release/easym.exe', 'dist/index.html', 'pnpm-lock.yaml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json', 'LICENSE',
  'Docs/dependencies/THIRD-PARTY-NOTICES.md', 'Docs/dependencies/sbom.cdx.json', 'Docs/dependencies/inventory.json', 'Docs/dependencies/license-sources.json']
try {
  for (const name of await readdir('src-tauri/target/release/bundle/portable')) {
    if (name === `EasyM-${config.version}-windows-x64-dev.zip`) paths.push(`src-tauri/target/release/bundle/portable/${name}`)
  }
} catch { /* Portable archive is optional. */ }
for (const name of await readdir('dist/assets')) paths.push(`dist/assets/${name}`)
try {
  for (const name of await readdir('src-tauri/target/release/bundle/nsis')) {
    if (name === `${config.productName}_${config.version}_x64-setup.exe`) paths.push(`src-tauri/target/release/bundle/nsis/${name}`)
  }
} catch { /* Installer may be unavailable; executable evidence is still useful. */ }
const artifacts = []
for (const path of paths) {
  const bytes = await readFile(path)
  artifacts.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
}
const sourcePaths = []
async function collectSource(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'target' || entry.name === 'gen') continue
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) await collectSource(path)
    else if (entry.isFile()) sourcePaths.push(path)
  }
}
for (const directory of ['src', 'src-tauri', 'scripts', '.github', 'Docs/samples', 'Docs/dependencies']) await collectSource(directory)
sourcePaths.push('package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'index.html', '.gitattributes', 'LICENSE')
const sourceHash = createHash('sha256')
for (const path of sourcePaths.sort()) {
  sourceHash.update(path + '\0')
  sourceHash.update(createHash('sha256').update(await readFile(path)).digest())
}
const native = JSON.parse((await readFile('test-results/native-startup-verification.json', 'utf8')).replace(/^\uFEFF/, ''))
assert.equal(native.version, config.version)
assert.equal(native.passed, true)
assert.equal(native.executableSha256, artifacts.find(item => item.path.endsWith('/easym.exe')).sha256)
for (const file of ['browser-verification.json', 'performance-verification.json', 'writing-verification.json', 'search-verification.json', 'live-preview-verification.json', 'workspace-verification.json', 'templates-verification.json', 'export-verification.json', 'regression-verification.json', 'native-startup-verification.json']) {
  await copyFile(resolve('test-results', file), resolve(output, file))
}
await writeFile(resolve(output, 'windows-build.json'), JSON.stringify({
  recordedAt: new Date().toISOString(), version: config.version, target: 'x86_64-pc-windows-msvc',
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceDirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
  sourceTree: { algorithm: 'sorted relative path + NUL + file SHA-256, then SHA-256', files: sourcePaths.length, sha256: sourceHash.digest('hex') },
  toolchain: { node: process.version, rustc: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim(), cargo: execFileSync('cargo', ['--version'], { encoding: 'utf8' }).trim() },
  artifacts,
}, null, 2) + '\n')
console.log(`Recorded ${artifacts.length} artifact/lockfile hashes and browser reports.`)
