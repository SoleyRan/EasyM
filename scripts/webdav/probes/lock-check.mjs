// WebDAV LOCK as a mutual-exclusion primitive: N clients LOCK the same resource, the holder
// PUTs with If: (<token> [etag]) and UNLOCKs. Records exclusivity and whether unlocked writes are refused.
import { request } from '../webdav-provider.mjs'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
const env = Object.fromEntries(readFileSync('test-results/v2.0/step-1/webdav.env', 'utf8').split(/\r?\n/).filter(Boolean).map((l) => l.split(/=(.*)/s, 2)))
const [name = 'apache', roundsArg = '30', racersArg = '8'] = process.argv.slice(2)
const rounds = Number(roundsArg), racers = Number(racersArg)
const t = name === 'apache'
  ? { baseUrl: 'http://127.0.0.1:18081', root: '/dav/', user: env.EASYM_DAV_USER, password: env.EASYM_DAV_PASSWORD }
  : { baseUrl: 'http://127.0.0.1:18082', root: `/remote.php/dav/files/${env.EASYM_NC_ADMIN_USER}/`, user: env.EASYM_NC_ADMIN_USER, password: env.EASYM_NC_ADMIN_PASSWORD }
const enc = (s) => new TextEncoder().encode(s)
const LOCK = enc('<?xml version="1.0" encoding="utf-8"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner>easym-probe</D:owner></D:lockinfo>')
const p = `${t.root}lock-${randomUUID()}.json`, url = new URL(p, t.baseUrl).href
await request(t, 'PUT', p, { body: enc(JSON.stringify({ v: 'init' })) })
const summary = { multiLock: 0, zeroLock: 0, unlockedWriteRefused: 0, lockedWriteOk: 0, statuses: {} }
for (let round = 0; round < rounds; round++) {
  const res = await Promise.all(Array.from({ length: racers }, () => request(t, 'LOCK', p, { body: LOCK, headers: { 'Content-Type': 'application/xml', Timeout: 'Second-30', Depth: '0' } }).catch((e) => ({ status: e.code, headers: {} }))))
  for (const r of res) summary.statuses[r.status] = (summary.statuses[r.status] ?? 0) + 1
  const holders = res.filter((r) => r.status === 200)
  if (holders.length > 1) summary.multiLock++
  if (holders.length === 0) { summary.zeroLock++; continue }
  const token = holders[0].headers['lock-token']
  const unlocked = await request(t, 'PUT', p, { body: enc(JSON.stringify({ v: 'intruder' })) })
  if (unlocked.status === 423) summary.unlockedWriteRefused++
  const etag = (await request(t, 'GET', p)).headers.etag
  const locked = await request(t, 'PUT', p, { body: enc(JSON.stringify({ v: round })), headers: { If: `<${url}> (${token} [${etag}])` } })
  if (locked.status === 204 || locked.status === 201) summary.lockedWriteOk++
  for (const h of holders) await request(t, 'UNLOCK', p, { headers: { 'Lock-Token': h.headers['lock-token'] } })
}
await request(t, 'DELETE', p)
console.log(name, 'lock', JSON.stringify({ rounds, racers, ...summary }))
