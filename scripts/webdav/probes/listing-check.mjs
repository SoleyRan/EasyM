// Append-only alternative: N clients each PUT a uniquely named entry into one collection at once,
// then PROPFIND Depth 1 must list every acknowledged entry (no CAS needed; visibility is the requirement).
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
const base = `${t.root}listing-${randomUUID()}/`
await request(t, 'MKCOL', base)
const summary = { missingFromListing: 0, missingFromGet: 0, acknowledged: 0, listingMs: [], statuses: {} }
for (let round = 0; round < rounds; round++) {
  const ids = Array.from({ length: racers }, () => randomUUID())
  // Retry refused writes (e.g. 423) like a queue would; entries never collide, so retry is safe.
  const res = await Promise.all(ids.map(async (id) => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const r = await request(t, 'PUT', `${base}${id}.json`, { body: enc(JSON.stringify({ v: id })), headers: { 'If-None-Match': '*' } }).catch((e) => ({ status: e.code }))
      summary.statuses[r.status] = (summary.statuses[r.status] ?? 0) + 1
      if (r.status === 201 || r.status === 204) return r
      await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 200))
    }
    return { status: 'gave_up' }
  }))
  const ok = ids.filter((_, i) => res[i].status === 201 || res[i].status === 204)
  summary.acknowledged += ok.length
  const started = performance.now()
  const listing = await request(t, 'PROPFIND', base, { headers: { Depth: '1', 'Content-Type': 'application/xml' }, body: enc('<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:getetag/></D:prop></D:propfind>') })
  summary.listingMs.push(performance.now() - started)
  const text = new TextDecoder().decode(listing.body)
  for (const id of ok) {
    if (!text.includes(`${id}.json`)) summary.missingFromListing++
    const got = await request(t, 'GET', `${base}${id}.json`)
    if (got.status !== 200 || JSON.parse(new TextDecoder().decode(got.body)).v !== id) summary.missingFromGet++
  }
}
const entries = rounds * racers
await request(t, 'DELETE', base)
const sorted = summary.listingMs.sort((a, b) => a - b)
console.log(name, 'listing', JSON.stringify({ rounds, racers, entries, acknowledged: summary.acknowledged, missingFromListing: summary.missingFromListing, missingFromGet: summary.missingFromGet, listingP95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)]), statuses: summary.statuses }))
