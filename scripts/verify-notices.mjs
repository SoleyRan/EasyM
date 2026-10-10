import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const directory = process.argv[2] ?? 'Docs/dependencies'
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const inventory = JSON.parse(await readFile(resolve(directory, 'inventory.json'), 'utf8'))
const sbom = JSON.parse(await readFile(resolve(directory, 'sbom.cdx.json'), 'utf8'))
const provenance = JSON.parse(await readFile(resolve(directory, 'license-sources.json'), 'utf8'))
const notices = await readFile(resolve(directory, 'THIRD-PARTY-NOTICES.md'), 'utf8')
assert.equal(sbom.metadata.component.version, pkg.version)
assert.equal(sbom.components.length, inventory.dependencies)
assert.equal(inventory.completeLicenseTexts, inventory.missingLicenseTexts.length === 0)
if (process.env.EASYM_STRICT_LICENSES === 'true') assert.equal(inventory.completeLicenseTexts, true)
const hashes = new Map()
for (const file of await readdir(resolve(directory, 'licenses'))) {
  const bytes = await readFile(resolve(directory, 'licenses', file))
  const hash = createHash('sha256').update(bytes).digest('hex')
  assert.equal(file.slice(0, 64), hash, `License bytes changed: ${file}`)
  hashes.set(`licenses/${file}`, hash)
}
for (const [, file] of notices.matchAll(/\]\((licenses\/[^)]+)\)/g)) assert.ok(hashes.has(file), `Missing notice: ${file}`)
for (const source of provenance) {
  assert.equal(hashes.get(source.file), source.sha256, source.package)
  assert.match(source.source, /^https:\/\//)
}
console.log(`${inventory.target}: ${inventory.dependencies} dependencies, ${hashes.size} license files verified; ${inventory.missingLicenseTexts.length} missing texts.`)
