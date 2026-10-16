import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const verify = process.argv[2] === '--verify'
const output = resolve(verify ? process.argv[3] : process.argv[2] ?? 'test-results/release')
const platform = verify ? process.argv[5] : process.platform
assert.ok(['darwin', 'linux'].includes(platform))
const target = platform === 'darwin' ? 'aarch64-apple-darwin' : 'x86_64-unknown-linux-gnu'
const label = platform === 'darwin' ? 'macos-arm64' : 'linux-amd64'
const extension = platform === 'darwin' ? 'dmg' : 'deb'
const manifestName = `release-manifest-${label}.json`
if (!verify) {
  assert.equal(process.env.CI, 'true', 'Non-Windows packages require their target CI runner')
  assert.equal(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1], target)
  const changes = execFileSync('git', ['diff', 'HEAD', '--name-only'], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean)
  assert.ok(changes.every(path => path.startsWith('Docs/dependencies/')), 'Unexpected source changes')
  const { version } = await json('package.json')
  const inventory = await json('Docs/dependencies/inventory.json')
  assert.equal(inventory.target, target)
  assert.equal(inventory.completeLicenseTexts, true)
  const bundle = `src-tauri/target/release/bundle/${platform === 'darwin' ? 'dmg' : 'deb'}`
  const files = (await readdir(bundle)).filter(name => name.endsWith(`.${extension}`) && name.toLowerCase().startsWith(`easym_${version}_`))
  assert.equal(files.length, 1, 'Exactly one installer for the current version is required')
  // Validate notices inside the actual app/deb, rather than only the build tree.
  let resources = 'src-tauri/target/release/bundle/macos/EasyM.app/Contents/Resources'
  if (platform === 'linux') {
    resources = 'test-results/deb-resources'
    await mkdir(resources, { recursive: true })
    execFileSync('dpkg-deb', ['--extract', `${bundle}/${files[0]}`, resources])
  }
  const inventories = []
  async function find(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory()) await find(path)
      else if (entry.name === 'inventory.json' && directory.endsWith('/third-party')) inventories.push(path)
    }
  }
  await find(resources)
  assert.equal(inventories.length, 1, 'Bundled dependency inventory missing or ambiguous')
  assert.deepEqual(await json(inventories[0]), inventory)
  async function compareNotices(source, destination) {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.isDirectory()) await compareNotices(`${source}/${entry.name}`, `${destination}/${entry.name}`)
      else assert.equal(hash(await readFile(`${destination}/${entry.name}`)), hash(await readFile(`${source}/${entry.name}`)), `Bundled notice differs: ${entry.name}`)
    }
  }
  await compareNotices('Docs/dependencies', dirname(inventories[0]))
  assert.equal(hash(await readFile(resolve(dirname(inventories[0]), '../LICENSE'))), hash(await readFile('LICENSE')), 'Bundled project license differs')
  const bundledSbom = await json(inventories[0].replace('inventory.json', 'sbom.cdx.json'))
  assert.equal(bundledSbom.metadata.component.version, version)
  const name = `EasyM-${version}-${label}.${extension}`, bytes = await readFile(`${bundle}/${files[0]}`)
  await mkdir(output, { recursive: true })
  await copyFile(`${bundle}/${files[0]}`, resolve(output, name))
  await writeFile(resolve(output, manifestName), JSON.stringify({
    version, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceDirty: false,
    target, signed: false, automaticUpdates: false, createdAt: new Date().toISOString(),
    bundledNoticesVerified: true, nativeGuiAcceptance: 'pending',
    artifacts: [{ name, bytes: bytes.length, sha256: hash(bytes) }],
  }, null, 2) + '\n')
  const manifest = await readFile(resolve(output, manifestName))
  await writeFile(resolve(output, `SHA256SUMS-${label}.txt`), `${hash(bytes)}  ${name}\n${hash(manifest)}  ${manifestName}\n`)
}
const manifest = await json(resolve(output, manifestName))
assert.match(manifest.version, /^1\.0\.\d+$/)
assert.match(manifest.sourceCommit, /^[a-f0-9]{40}$/)
if (verify) assert.equal(manifest.sourceCommit, process.argv[4])
assert.equal(manifest.sourceDirty, false)
assert.equal(manifest.target, target)
assert.equal(manifest.signed, false)
assert.equal(manifest.automaticUpdates, false)
assert.equal(manifest.bundledNoticesVerified, true)
assert.equal(manifest.artifacts.length, 1)
const item = manifest.artifacts[0]
assert.equal(item.name, `EasyM-${manifest.version}-${label}.${extension}`)
const bytes = await readFile(resolve(output, item.name))
assert.equal(bytes.length, item.bytes)
assert.equal(hash(bytes), item.sha256)
assert.equal(await readFile(resolve(output, `SHA256SUMS-${label}.txt`), 'utf8'), `${item.sha256}  ${item.name}\n${hash(await readFile(resolve(output, manifestName)))}  ${manifestName}\n`)
console.log(`Verified EasyM ${manifest.version} ${target} package and bundled notices for ${manifest.sourceCommit}; GUI acceptance remains manual.`)
