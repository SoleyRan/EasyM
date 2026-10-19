import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

test('release verification rejects changed bytes, a different commit, dirty sources and missing installation evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'easym-release-'))
  const sha = bytes => createHash('sha256').update(bytes).digest('hex')
  const commit = 'a'.repeat(40)
  try {
    const manifest = { version: '1.0.0', sourceCommit: commit, sourceDirty: false, target: 'x86_64-pc-windows-msvc', signed: false, automaticUpdates: false,
      checks: Object.fromEntries(['native-startup', 'native-extensions', 'portable', 'installer'].map(name => [name, { passed: true }])), artifacts: [] }
    for (const name of ['EasyM_1.0.0_x64-setup.exe', 'EasyM-1.0.0-windows-x64.zip', 'RELEASE-NOTES.md']) {
      const bytes = Buffer.from(`release fixture: ${name}`)
      await writeFile(join(directory, name), bytes)
      manifest.artifacts.push({ name, bytes: bytes.length, sha256: sha(bytes) })
    }
    async function save() {
      const bytes = Buffer.from(JSON.stringify(manifest) + '\n')
      await writeFile(join(directory, 'release-manifest.json'), bytes)
      await writeFile(join(directory, 'SHA256SUMS.txt'), [...manifest.artifacts, { name: 'release-manifest.json', sha256: sha(bytes) }].map(item => `${item.sha256}  ${item.name}\n`).join(''))
    }
    const verify = (ref = commit) => spawnSync(process.execPath, ['scripts/prepare-release.mjs', '--verify', directory, ref], { encoding: 'utf8' })
    await save(); assert.equal(verify().status, 0)
    assert.notEqual(verify('b'.repeat(40)).status, 0)
    manifest.sourceDirty = true; await save(); assert.notEqual(verify().status, 0)
    manifest.sourceDirty = false; manifest.checks.installer.passed = false
    await save(); assert.notEqual(verify().status, 0)
    manifest.checks.installer.passed = true; await save()
    await writeFile(join(directory, manifest.artifacts[0].name), 'changed installer')
    assert.notEqual(verify().status, 0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('macOS and Linux release verification binds package bytes, target, notices and source commit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'easym-platform-release-'))
  const sha = bytes => createHash('sha256').update(bytes).digest('hex')
  const commit = 'c'.repeat(40)
  try {
    for (const [platform, label, target, extension] of [['darwin', 'macos-arm64', 'aarch64-apple-darwin', 'dmg'], ['linux', 'linux-amd64', 'x86_64-unknown-linux-gnu', 'deb']]) {
      const name = `EasyM-1.0.0-${label}.${extension}`, bytes = Buffer.from(`package fixture ${platform}`)
      await writeFile(join(directory, name), bytes)
      const manifestName = `release-manifest-${label}.json`
      const manifest = { version: '1.0.0', sourceCommit: commit, sourceDirty: false, target, signed: false, automaticUpdates: false, bundledNoticesVerified: true,
        artifacts: [{ name, bytes: bytes.length, sha256: sha(bytes) }] }
      async function save() {
        const data = Buffer.from(JSON.stringify(manifest) + '\n')
        await writeFile(join(directory, manifestName), data)
        await writeFile(join(directory, `SHA256SUMS-${label}.txt`), `${sha(bytes)}  ${name}\n${sha(data)}  ${manifestName}\n`)
      }
      const verify = (ref = commit) => spawnSync(process.execPath, ['scripts/prepare-platform-release.mjs', '--verify', directory, ref, platform], { encoding: 'utf8' })
      await save(); assert.equal(verify().status, 0)
      assert.notEqual(verify('d'.repeat(40)).status, 0)
      manifest.target = 'wrong-target'; await save(); assert.notEqual(verify().status, 0)
      manifest.target = target; manifest.bundledNoticesVerified = false
      await save(); assert.notEqual(verify().status, 0)
      manifest.bundledNoticesVerified = true; await save()
      await writeFile(join(directory, name), 'changed package')
      assert.notEqual(verify().status, 0)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
