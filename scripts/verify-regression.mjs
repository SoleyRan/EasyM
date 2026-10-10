import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'

// Build/typecheck/unit tests run before this suite. Each browser script creates
// its own profile and production server; run serially to keep timing reproducible.
const scripts = ['workers', 'browser', 'writing', 'search', 'live-preview', 'workspace', 'templates', 'export', 'context-menu']
if (process.argv.includes('--performance')) scripts.push('performance')
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'))
if (pkg.version !== config.version) throw new Error('Application version mismatch')
const report = { version: pkg.version, startedAt: new Date().toISOString(), browser: process.env.EASYM_TEST_BROWSER ?? 'chromium', passed: false, checks: [] }
await mkdir('test-results', { recursive: true })
const hash = createHash('sha256').update(await readFile('dist/index.html')).digest('hex')
report.distIndexSha256 = hash
try {
  for (const script of scripts) {
    console.log(`\nVerify ${script}`)
    const started = Date.now()
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [`scripts/verify-${script}.mjs`], { stdio: 'inherit', env: process.env })
      child.once('error', reject); child.once('exit', code => resolve(code))
    })
    report.checks.push({ script, passed: exitCode === 0, durationMs: Date.now() - started })
    if (exitCode !== 0) throw new Error(`${script} verification failed (${exitCode})`)
  }
  if (createHash('sha256').update(await readFile('dist/index.html')).digest('hex') !== hash) throw new Error('Production build changed during regression')
  report.passed = true
} catch (error) { report.error = error.message; process.exitCode = 1 }
finally {
  report.finishedAt = new Date().toISOString()
  await writeFile('test-results/regression-verification.json', JSON.stringify(report, null, 2) + '\n')
}
