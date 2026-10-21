// Raw If-Match race diagnostics: N PUTs with the same ETag, record every status and the final body.
import { request } from '../webdav-provider.mjs'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
const env = Object.fromEntries(readFileSync('test-results/v2.0/step-1/webdav.env', 'utf8').split(/\r?\n/).filter(Boolean).map((l) => l.split(/=(.*)/s, 2)))
const name = process.argv[2] ?? 'nextcloud', rounds = Number(process.argv[3] ?? 20), racers = Number(process.argv[4] ?? 8)
const t = name === 'apache'
  ? { baseUrl: 'http://127.0.0.1:18081', root: '/dav/', user: env.EASYM_DAV_USER, password: env.EASYM_DAV_PASSWORD }
  : { baseUrl: 'http://127.0.0.1:18082', root: `/remote.php/dav/files/${env.EASYM_NC_ADMIN_USER}/`, user: env.EASYM_NC_ADMIN_USER, password: env.EASYM_NC_ADMIN_PASSWORD }
const p = `${t.root}race-${randomUUID()}.json`
const enc = (s) => new TextEncoder().encode(s)
await request(t, 'PUT', p, { body: enc(JSON.stringify({ v: 'init'.padEnd(36) })) })
await new Promise((r) => setTimeout(r, 1200))
const summary = { multiSuccess: 0, zeroSuccess: 0, finalNotWinner: 0, finalFromRefused: 0, statuses: {} }
for (let round = 0; round < rounds; round++) {
  let base
  for (;;) { base = await request(t, 'GET', p); if (!base.headers.etag.startsWith('W/')) break; await new Promise((r) => setTimeout(r, 300)) }
  const ids = Array.from({ length: racers }, () => randomUUID())
  const res = await Promise.all(ids.map((id) => request(t, 'PUT', p, { body: enc(JSON.stringify({ v: id })), headers: { 'If-Match': base.headers.etag } }).catch((e) => ({ status: e.code }))))
  for (const r of res) summary.statuses[r.status] = (summary.statuses[r.status] ?? 0) + 1
  const ok = ids.filter((_, i) => res[i].status === 201 || res[i].status === 204)
  let final
  for (;;) { final = await request(t, 'GET', p); if (!final.headers.etag.startsWith('W/')) break; await new Promise((r) => setTimeout(r, 300)) }
  const finalId = JSON.parse(new TextDecoder().decode(final.body)).v
  if (ok.length > 1) summary.multiSuccess++
  if (ok.length === 0) summary.zeroSuccess++
  if (!ok.includes(finalId)) summary.finalNotWinner++
  // A refused (non-2xx) writer whose body became the head would mean a write behind an error status.
  if (ids.some((id, i) => id === finalId && !ok.includes(id))) summary.finalFromRefused++
  if (ok.length !== 1) console.log(`round ${round}: successes=${ok.length} statuses=${res.map((r) => r.status).join(',')} finalIsSuccess=${ok.includes(finalId)}`)
}
await request(t, 'DELETE', p)
console.log(name, JSON.stringify({ rounds, racers, ...summary }))
