import { createHash } from 'node:crypto'
import { readFile, readdir, mkdir, writeFile, stat } from 'node:fs/promises'
import { dirname, basename, resolve, relative } from 'node:path'

// Inputs are local tool output. Never include package paths or machine identifiers in artifacts.
const [npmInput, cargoInput] = process.argv.slice(2)
if (!npmInput || !cargoInput) throw new Error('Usage: node scripts/generate-notices.mjs npm-licenses.json cargo-metadata.json')
const npm = JSON.parse((await readFile(npmInput, 'utf8')).replace(/^\uFEFF/, ''))
const cargo = JSON.parse((await readFile(cargoInput, 'utf8')).replace(/^\uFEFF/, ''))
const output = resolve('Docs/dependencies')
const externalLicenseRoot = resolve('scripts/external-licenses')
const externalLicenses = {
  'cargo:alloc-stdlib@0.3.0': [{ file: 'alloc-stdlib-LICENSE.txt', source: 'https://github.com/dropbox/rust-alloc-no-stdlib/blob/0a81fd6928ea3b33c8cd484aa4575d50ffb98012/LICENSE' }],
  'cargo:defmt-parser@1.0.0': [
    { file: 'defmt-LICENSE-MIT.txt', source: 'https://github.com/knurling-rs/defmt/blob/4a8cdb44891ed57b8ff5a023b6bec7137c48708f/LICENSE-MIT' },
    { file: 'defmt-LICENSE-APACHE.txt', source: 'https://github.com/knurling-rs/defmt/blob/4a8cdb44891ed57b8ff5a023b6bec7137c48708f/LICENSE-APACHE' },
  ],
  'cargo:selectors@0.38.0': [{ file: 'MPL-2.0.txt', source: 'https://www.mozilla.org/media/MPL/2.0/index.txt' }],
  'cargo:webview2-com@0.39.1': [{ file: 'webview2-rs-LICENSE.txt', source: 'https://github.com/wravery/webview2-rs/blob/edc2caf886175ccaebe86078c9cfe1ae2a187328/LICENSE' }],
  'cargo:webview2-com-sys@0.39.1': [{ file: 'webview2-rs-LICENSE.txt', source: 'https://github.com/wravery/webview2-rs/blob/edc2caf886175ccaebe86078c9cfe1ae2a187328/LICENSE' }],
  'cargo:webview2-com-macros@0.8.1': [{ file: 'webview2-rs-LICENSE.txt', source: 'https://github.com/wravery/webview2-rs/blob/dffa41a8a46d3f5565eefbff2de57d38d399f158/LICENSE' }],
  'npm:format@0.2.2': [{ file: 'format-MIT.txt', source: 'https://github.com/samsonjs/format/blob/4f898096759776b7c84fa7a25b13c923dadfe46e/format.js' }],
}
await mkdir(output, { recursive: true })
const records = []
for (const [license, packages] of Object.entries(npm)) {
  for (const pkg of packages) for (let i = 0; i < pkg.versions.length; i++) {
    records.push({ ecosystem: 'npm', name: pkg.name, version: pkg.versions[i], license, directory: pkg.paths[i] ?? pkg.paths[0] })
  }
}
for (const pkg of cargo.packages) {
  if (!pkg.source) continue
  records.push({ ecosystem: 'cargo', name: pkg.name, version: pkg.version, license: pkg.license ?? 'See license file', directory: dirname(pkg.manifest_path), licenseFile: pkg.license_file })
}
records.sort((a, b) => `${a.ecosystem}/${a.name}/${a.version}`.localeCompare(`${b.ecosystem}/${b.name}/${b.version}`))
const components = []
const lines = ['# Third-party dependency notices', '',
  'Generated from pnpm production dependencies and Cargo metadata filtered for x86_64-pc-windows-msvc. This inventory includes Rust build dependencies; other platforms need their own filtered inventory before distribution.', '',
  'License texts copied from installed package sources are linked below. Declared license expressions are metadata, not a legal review. No local source paths are included.', '',
  '| Ecosystem | Package | Version | Declared license | Bundled texts |', '| --- | --- | --- | --- | --- |']
const missing = []
const provenance = []
for (const pkg of records) {
  const files = (await readdir(pkg.directory)).filter((name) => /^(licen[sc]e|copying|notice|copyright)(?:$|[._-])/i.test(name))
  if (pkg.licenseFile) {
    const file = resolve(pkg.directory, pkg.licenseFile)
    if (!relative(pkg.directory, file).startsWith('..')) files.push(relative(pkg.directory, file))
  }
  const links = []
  for (const filename of new Set(files)) {
    const path = resolve(pkg.directory, filename)
    if (!(await stat(path)).isFile()) continue
    const text = await readFile(path)
    const hash = createHash('sha256').update(text).digest('hex')
    const target = `licenses/${hash}-${basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_')}.txt`
    await mkdir(resolve(output, 'licenses'), { recursive: true })
    await writeFile(resolve(output, target), text)
    links.push(`[${basename(filename)}](${target})`)
  }
  const external = externalLicenses[`${pkg.ecosystem}:${pkg.name}@${pkg.version}`] ?? []
  for (const item of external) {
    const source = resolve(externalLicenseRoot, item.file)
    const text = await readFile(source)
    const hash = createHash('sha256').update(text).digest('hex')
    const target = `licenses/${hash}-${basename(item.file).replace(/[^a-zA-Z0-9._-]/g, '_')}`
    await mkdir(resolve(output, 'licenses'), { recursive: true })
    await writeFile(resolve(output, target), text)
    links.push(`[${basename(item.file)}](${target})`)
    provenance.push({ package: `${pkg.ecosystem}:${pkg.name}@${pkg.version}`, file: target, sha256: hash, source: item.source })
  }
  if (!links.length) missing.push(`${pkg.ecosystem}:${pkg.name}@${pkg.version}`)
  const purl = `pkg:${pkg.ecosystem}/${pkg.name.split('/').map(encodeURIComponent).join('/')}@${pkg.version}`
  components.push({ type: 'library', 'bom-ref': purl, name: pkg.name, version: pkg.version, purl,
    licenses: pkg.license === 'UNKNOWN' || pkg.license === 'See license file' ? [{ license: { name: pkg.license } }] : [{ expression: pkg.license.replaceAll('/', ' OR ') }] })
  lines.push(`| ${pkg.ecosystem} | ${pkg.name} | ${pkg.version} | ${pkg.license.replaceAll('|', '\\|')} | ${links.join(', ') || 'Not present in package source'} |`)
}
lines.push('', `Inventory: ${records.length} dependency versions.`, '',
  '## Missing license texts', '', ...(missing.length ? missing.map((name) => `- ${name}`) : ['None.']), '',
  'Some packages do not ship a license file. Supplemental upstream license texts are vendored under `scripts/external-licenses/`; source commits, canonical license URLs and the format package extraction are documented in its README and `license-sources.json`. Regenerate using `pnpm licenses list --prod --json` and `cargo metadata --locked --filter-platform x86_64-pc-windows-msvc --format-version 1`, followed by `node scripts/generate-notices.mjs <npm-output> <cargo-output>`.', '')
await writeFile(resolve(output, 'THIRD-PARTY-NOTICES.md'), lines.join('\n'))
await writeFile(resolve(output, 'license-sources.json'), JSON.stringify(provenance, null, 2) + '\n')
await writeFile(resolve(output, 'sbom.cdx.json'), JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
  metadata: { component: { type: 'application', name: 'EasyM', version: '0.1.0', licenses: [{ license: { id: 'Apache-2.0' } }] } }, components }, null, 2) + '\n')
console.log(`${records.length} dependency versions; ${missing.length} packages missing bundled license texts.`)
