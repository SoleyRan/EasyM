// Atomicity of alternative WebDAV primitives under N concurrent clients:
//  mkcol: N x MKCOL on the same new collection; exactly one 201 expected.
//  move:  N x (PUT own temp file, MOVE to the same destination with Overwrite: F); exactly one 2xx expected.
import { request } from '../webdav-provider.mjs'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
const env = Object.fromEntries(readFileSync('test-results/v2.0/step-1/webdav.env', 'utf8').split(/\r?\n/).filter(Boolean).map((l) => l.split(/=(.*)/s, 2)))
const [name = 'apache', kind = 'mkcol', roundsArg = '30', racersArg = '8'] = process.argv.slice(2)
const rounds = Number(roundsArg), racers = Number(racersArg)
const t = name === 'apache'
  ? { baseUrl: 'http://127.0.0.1:18081', root: '/dav/', user: env.EASYM_DAV_USER, password: env.EASYM_DAV_PASSWORD }
  : { baseUrl: 'http://127.0.0.1:18082', root: `/remote.php/dav/files/${env.EASYM_NC_ADMIN_USER}/`, user: env.EASYM_NC_ADMIN_USER, password: env.EASYM_NC_ADMIN_PASSWORD }
const enc = (s) => new TextEncoder().encode(s)
const base = `${t.root}primitive-${randomUUID()}/`
await request(t, 'MKCOL', base)
const summary = { multiSuccess: 0, zeroSuccess: 0, finalNotWinner: 0, statuses: {} }
for (let round = 0; round < rounds; round++) {
  const target = `${base}slot-${round}${kind === 'mkcol' ? '/' : '.json'}`
  const ids = Array.from({ length: racers }, () => randomUUID())
  if (kind === 'move') await Promise.all(ids.map((id) => request(t, 'PUT', `${base}tmp-${id}.json`, { body: enc(JSON.stringify({ v: id })) })))
  const res = await Promise.all(ids.map((id) => (kind === 'mkcol'
    ? request(t, 'MKCOL', target)
    : request(t, 'MOVE', `${base}tmp-${id}.json`, { headers: { Destination: new URL(target, t.baseUrl).href, Overwrite: 'F' } })).catch((e) => ({ status: e.code }))))
  for (const r of res) summary.statuses[r.status] = (summary.statuses[r.status] ?? 0) + 1
  const ok = ids.filter((_, i) => res[i].status === 201 || res[i].status === 204)
  if (ok.length > 1) summary.multiSuccess++
  if (ok.length === 0) summary.zeroSuccess++
  if (kind === 'move' && ok.length) {
    const final = await request(t, 'GET', target)
    const finalId = final.status === 200 ? JSON.parse(new TextDecoder().decode(final.body)).v : null
    if (!ok.includes(finalId) || (ok.length === 1 && finalId !== ok[0])) summary.finalNotWinner++
  }
}
await request(t, 'DELETE', base)
console.log(name, kind, JSON.stringify({ rounds, racers, ...summary }))
