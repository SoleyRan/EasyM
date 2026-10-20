// Raw If-None-Match: * race: N PUTs create the same new path; more than one 2xx means create is not atomic.
import { request } from '../webdav-provider.mjs'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
const env = Object.fromEntries(readFileSync('test-results/v2.0/step-1/webdav.env', 'utf8').split(/\r?\n/).filter(Boolean).map((l) => l.split(/=(.*)/s, 2)))
const name = process.argv[2] ?? 'nextcloud', rounds = Number(process.argv[3] ?? 20), racers = Number(process.argv[4] ?? 8)
const t = name === 'apache'
  ? { baseUrl: 'http://127.0.0.1:18081', root: '/dav/', user: env.EASYM_DAV_USER, password: env.EASYM_DAV_PASSWORD }
  : { baseUrl: 'http://127.0.0.1:18082', root: `/remote.php/dav/files/${env.EASYM_NC_ADMIN_USER}/`, user: env.EASYM_NC_ADMIN_USER, password: env.EASYM_NC_ADMIN_PASSWORD }
const enc = (s) => new TextEncoder().encode(s)
const summary = { multiSuccess: 0, zeroSuccess: 0, finalNotWinner: 0, statuses: {} }
for (let round = 0; round < rounds; round++) {
  const p = `${t.root}create-${randomUUID()}.json`, ids = Array.from({ length: racers }, () => randomUUID())
  const res = await Promise.all(ids.map((id) => request(t, 'PUT', p, { body: enc(JSON.stringify({ v: id })), headers: { 'If-None-Match': '*' } }).catch((e) => ({ status: e.code }))))
  for (const r of res) summary.statuses[r.status] = (summary.statuses[r.status] ?? 0) + 1
  const ok = ids.filter((_, i) => res[i].status === 201 || res[i].status === 204)
  const final = await request(t, 'GET', p)
  const finalId = final.status === 200 ? JSON.parse(new TextDecoder().decode(final.body)).v : null
  if (ok.length > 1) summary.multiSuccess++
  if (ok.length === 0) summary.zeroSuccess++
  if (ok.length && !ok.includes(finalId)) summary.finalNotWinner++
  await request(t, 'DELETE', p)
}
console.log(name, 'create', JSON.stringify({ rounds, racers, ...summary }))
