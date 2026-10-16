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
