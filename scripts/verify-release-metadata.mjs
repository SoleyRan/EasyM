import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// One release must identify the same version in UI, native metadata and SBOM.
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'))
const cargo = await readFile('src-tauri/Cargo.toml', 'utf8')
const lock = await readFile('src-tauri/Cargo.lock', 'utf8')
const sbom = JSON.parse(await readFile('Docs/dependencies/sbom.cdx.json', 'utf8'))
assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
assert.equal(config.version, pkg.version)
assert.equal(cargo.match(/^version = "([^"]+)"$/m)?.[1], pkg.version)
assert.equal(lock.match(/\[\[package\]\]\s+name = "easym"\s+version = "([^"]+)"/)?.[1], pkg.version)
assert.equal(sbom.metadata.component.version, pkg.version)
assert.ok((await readFile('src/editor/DocumentEditor.tsx', 'utf8')).includes(`v${pkg.version}-dev`))
assert.equal(config.productName, 'EasyM')
assert.equal(config.bundle.createUpdaterArtifacts, false)
console.log(`EasyM ${pkg.version}: package, Cargo, lock, Tauri, UI and SBOM versions agree.`)
