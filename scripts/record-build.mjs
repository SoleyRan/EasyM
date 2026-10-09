import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, readdir, mkdir, copyFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// Run after build and verification. No absolute machine paths are emitted.
const output = resolve('Docs/verification')
await mkdir(output, { recursive: true })
const paths = ['src-tauri/target/release/easym.exe', 'pnpm-lock.yaml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json']
try {
  for (const name of await readdir('src-tauri/target/release/bundle/portable')) {
    if (name.endsWith('.zip')) paths.push(`src-tauri/target/release/bundle/portable/${name}`)
  }
} catch { /* Portable archive is optional. */ }
for (const name of await readdir('dist/assets')) paths.push(`dist/assets/${name}`)
try {
  for (const name of await readdir('src-tauri/target/release/bundle/nsis')) {
    if (name.endsWith('.exe')) paths.push(`src-tauri/target/release/bundle/nsis/${name}`)
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
for (const directory of ['src', 'src-tauri', 'scripts', '.github']) await collectSource(directory)
sourcePaths.push('package.json', 'vite.config.ts', 'tsconfig.json', 'index.html')
const sourceHash = createHash('sha256')
for (const path of sourcePaths.sort()) {
  sourceHash.update(path + '\0')
  sourceHash.update(createHash('sha256').update(await readFile(path)).digest())
}
for (const file of ['browser-verification.json', 'performance-verification.json']) {
  await copyFile(resolve('test-results', file), resolve(output, file))
}
await writeFile(resolve(output, 'windows-build.json'), JSON.stringify({
  recordedAt: new Date().toISOString(), version: '0.1.0', target: 'x86_64-pc-windows-msvc',
  sourceTree: { algorithm: 'sorted relative path + NUL + file SHA-256, then SHA-256', files: sourcePaths.length, sha256: sourceHash.digest('hex') },
  toolchain: { node: process.version, rustc: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim(), cargo: execFileSync('cargo', ['--version'], { encoding: 'utf8' }).trim() },
  artifacts,
}, null, 2) + '\n')
console.log(`Recorded ${artifacts.length} artifact/lockfile hashes and browser reports.`)
