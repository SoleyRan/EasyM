import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// Candidate libraries are isolated development probes, never app dependencies.
const tools = resolve('test-results/pdf-engines/tools')
await mkdir(tools, { recursive: true })
await copyFile('scripts/fixtures/pdf-evaluation/package.json', resolve(tools, 'package.json'))
await copyFile('scripts/fixtures/pdf-evaluation/package-lock.json', resolve(tools, 'package-lock.json'))
await new Promise((done, reject) => {
  const child = process.platform === 'win32'
    ? spawn('cmd.exe', ['/d', '/c', 'npm.cmd ci --ignore-scripts --no-audit --no-fund'], { cwd: tools, stdio: 'inherit', windowsHide: true })
    : spawn('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: tools, stdio: 'inherit' })
  child.on('error', reject)
  child.on('exit', code => code === 0 ? done() : reject(new Error(`npm ci exited ${code}`)))
})
const files = [
  ['NotoSansSC-Regular.otf', '165c01b46ea533872e002e0785ff17e44f6d97d8/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf', 'faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9'],
  ['Noto-LICENSE.txt', 'a99a4354c68964f6bfac488d01010b1fb6d9178a/Sans/LICENSE', '6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2'],
]
for (const [name, path, expected] of files) {
  const target = resolve(tools, name)
  let bytes
  try { bytes = await readFile(target) } catch {
    const response = await fetch(`https://raw.githubusercontent.com/notofonts/noto-cjk/${path}`, { signal: AbortSignal.timeout(60_000) })
    assert.ok(response.ok, `Font download: ${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer())
  }
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, `Unexpected ${name}; preserve file and investigate`)
  await writeFile(target, bytes)
}
console.log('Pinned PDF evaluation tools ready in test-results/pdf-engines/tools.')
