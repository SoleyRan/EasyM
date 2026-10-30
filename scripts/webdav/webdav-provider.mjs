// Reference WebDAV adapter for step-1 protocol verification only. The shipping Provider
// will be native (credentials stay in the OS store); this file keeps the same contract
// so the probe exercises real servers through the src/core per-device log.
import http from 'node:http'
import https from 'node:https'
import { createHash } from 'node:crypto'

const MAX_HEAD = 4096, MAX_OBJECT = 32 * 1024 * 1024

export class WebDavError extends Error {
  constructor(code, status) { super(code); this.name = 'WebDavError'; this.code = code; this.status = status }
}

/** One HTTP exchange with no keep-alive, no redirects and a hard byte limit. */
export function request(target, method, path, { headers = {}, body, signal, timeoutMs = 15000, maxBytes = MAX_OBJECT } = {}) {
  const url = new URL(path, target.baseUrl)
  if (url.origin !== new URL(target.baseUrl).origin) throw new WebDavError('cross_origin')
  const client = url.protocol === 'https:' ? https : http
  const auth = 'Basic ' + Buffer.from(`${target.user}:${target.password}`).toString('base64')
  return new Promise((resolve, reject) => {
    const req = client.request(url, { method, agent: false, timeout: timeoutMs, signal, headers: { Authorization: auth, ...headers, ...(body ? { 'Content-Length': body.byteLength } : {}) } }, (res) => {
      const chunks = []; let size = 0
      res.on('data', (chunk) => {
        size += chunk.length
        if (size > maxBytes) { req.destroy(); reject(new WebDavError('response_too_large', res.statusCode)) } else chunks.push(chunk)
      })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: new Uint8Array(Buffer.concat(chunks)) }))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new WebDavError('timeout')))
    req.on('error', (error) => reject(error instanceof WebDavError ? error : new WebDavError(signal?.aborted ? 'aborted' : 'transport_failed')))
    req.end(body ? Buffer.from(body) : undefined)
  })
}

const sha = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
const strong = (etag) => (typeof etag === 'string' && /^"[^"]*"$/.test(etag) ? etag : null)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PROPFIND = new TextEncoder().encode('<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>')

function failure(status) {
  if (status === 401 || status === 403) return new WebDavError('unauthorized', status)
  if (status === 507 || status === 413) return new WebDavError('quota_exceeded', status)
  return new WebDavError('unexpected_status', status)
}


/**
 * SyncProvider over a WebDAV collection laid out as
 * `<root>/easym-sync/v1/<workspaceId>/{devices/<deviceId>.json, objects/sha256/<hex>}`.
 * Each device head has a single writer, so no server-side compare-and-swap is required.
 */
export class WebDavSyncProvider {
  /** `codec` supplies parseSyncDeviceHead/encodeSyncDeviceHead from src/core. */
  constructor(target, codec) { this.target = target; this.parseDeviceHead = codec.parseSyncDeviceHead; this.encodeDeviceHead = codec.encodeSyncDeviceHead; this.stats = { requests: 0, bytesSent: 0, bytesReceived: 0, weakEtagRetries: 0 } }
  path(workspaceId, rest = '') { return `${this.target.root}easym-sync/v1/${workspaceId}/${rest}` }

  async send(method, path, options = {}) {
    this.stats.requests++; this.stats.bytesSent += options.body?.byteLength ?? 0
    const response = await (this.target.request ?? request)(this.target, method, path, options)
    this.stats.bytesReceived += response.body.byteLength
    return response
  }

  /** Creates the namespace collections; MKCOL on an existing collection returns 405. */
  async prepare(workspaceId, signal) {
    const root = this.target.root
    for (const path of [`${root}easym-sync/`, `${root}easym-sync/v1/`, this.path(workspaceId), this.path(workspaceId, 'devices/'), this.path(workspaceId, 'objects/'), this.path(workspaceId, 'objects/sha256/')]) {
      const res = await this.send('MKCOL', path, { signal })
      if (![201, 405].includes(res.status)) throw failure(res.status)
    }
  }

  /**
   * Lists `devices/` with PROPFIND Depth 1 and reads each head. Unknown names, non-files and
   * truncated (non-207) listings are errors so that a partial view never looks complete.
   */
  async listDeviceHeads(workspaceId, signal) {
    const base = this.path(workspaceId, 'devices/')
    const res = await this.send('PROPFIND', base, { signal, body: PROPFIND, headers: { Depth: '1', 'Content-Type': 'application/xml' }, maxBytes: 1024 * 1024 })
    if (res.status === 404) return []
    if (res.status !== 207) throw failure(res.status)
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(res.body)
    const hrefs = [...xml.matchAll(/<(?:[A-Za-z]+:)?href>([^<]*)<\/(?:[A-Za-z]+:)?href>/g)].map((m) => decodeURIComponent(new URL(m[1].replace(/&amp;/g, '&'), this.target.baseUrl).pathname))
    const self = decodeURIComponent(new URL(base, this.target.baseUrl).pathname)
    const ids = []
    for (const href of hrefs) {
      if (href === self || href === self.slice(0, -1)) continue
      if (!href.startsWith(self)) throw new WebDavError('invalid_listing')
      const name = href.slice(self.length)
      // Ignore server temp/part files only if they are clearly not heads; anything else stops sync.
      if (/^\.(?:~|_|#)/.test(name)) continue
      const match = /^([0-9a-f-]{36})\.json$/.exec(name)
      if (!match || !UUID.test(match[1])) throw new WebDavError('invalid_listing')
      ids.push(match[1])
    }
    const heads = []
    for (const id of ids.sort()) {
      const head = await this.readDeviceHead(workspaceId, id, signal)
      // Listed but gone: a concurrent delete or an inconsistent listing; never silently skip.
      if (!head) throw new WebDavError('invalid_listing')
      heads.push(head)
    }
    return heads
  }

  /**
   * Apache marks validators of files modified within the last second as weak. The head is
   * single-writer, so a weak or missing validator is reported as null instead of waited for.
   */
  async readDeviceHead(workspaceId, deviceId, signal) {
    const res = await this.send('GET', this.path(workspaceId, `devices/${deviceId}.json`), { signal, maxBytes: MAX_HEAD })
    if (res.status === 404) return null
    if (res.status !== 200) throw failure(res.status)
    const modified = Date.parse(res.headers['last-modified'] ?? '')
    return { head: this.parseDeviceHead(res.body, workspaceId, deviceId), revision: strong(res.headers.etag), modified: Number.isFinite(modified) ? modified : null }
  }

  // Step 5A: retirement records and device info. Mirrors src-tauri/src/sync_native.rs.
  async ensureCollection(workspaceId, rest, signal) {
    const res = await this.send('MKCOL', this.path(workspaceId, rest), { signal })
    if (![201, 405].includes(res.status)) throw failure(res.status)
  }
  async listRetiredDevices(workspaceId, signal) {
    const base = this.path(workspaceId, 'retired/')
    const res = await this.send('PROPFIND', base, { signal, body: PROPFIND, headers: { Depth: '1', 'Content-Type': 'application/xml' }, maxBytes: 1024 * 1024 })
    if (res.status === 404) return []
    if (res.status !== 207) throw failure(res.status)
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(res.body)
    const self = decodeURIComponent(new URL(base, this.target.baseUrl).pathname), ids = []
    for (const m of xml.matchAll(/<(?:[A-Za-z]+:)?href>([^<]*)<\/(?:[A-Za-z]+:)?href>/g)) {
      const href = decodeURIComponent(new URL(m[1].replace(/&amp;/g, '&'), this.target.baseUrl).pathname)
      if (href === self || href === self.slice(0, -1)) continue
      if (!href.startsWith(self)) throw new WebDavError('invalid_listing')
      const name = href.slice(self.length)
      if (/^\.(?:~|_|#)/.test(name)) continue
      const match = /^([0-9a-f-]{36})\.json$/.exec(name)
      if (!match || !UUID.test(match[1])) throw new WebDavError('invalid_listing')
      ids.push(match[1])
    }
    return [...new Set(ids)].sort()
  }
  async retireDevice(head, revision, signal) {
    await this.ensureCollection(head.workspaceId, 'retired/', signal)
    const created = await this.send('PUT', this.path(head.workspaceId, `retired/${head.deviceId}.json`), { signal, body: this.encodeDeviceHead(head), headers: { 'Content-Type': 'application/json', 'If-None-Match': '*' } })
    if (![200, 201, 204, 412].includes(created.status)) throw failure(created.status)
    const deleted = await this.send('DELETE', this.path(head.workspaceId, `devices/${head.deviceId}.json`), { signal, headers: revision ? { 'If-Match': revision } : {} })
    if (deleted.status === 412) throw new WebDavError('device_changed')
    if (![200, 204, 404].includes(deleted.status)) throw failure(deleted.status)
  }
  async readDeviceInfo(workspaceId, deviceId, signal) {
    const res = await this.send('GET', this.path(workspaceId, `device-info/${deviceId}.json`), { signal, maxBytes: MAX_HEAD })
    if (res.status === 404) return null
    if (res.status !== 200) throw failure(res.status)
    return res.body
  }
  async publishDeviceInfo(workspaceId, deviceId, bytes, signal) {
    await this.ensureCollection(workspaceId, 'device-info/', signal)
    const res = await this.send('PUT', this.path(workspaceId, `device-info/${deviceId}.json`), { signal, body: bytes, headers: { 'Content-Type': 'application/json' } })
    if (![200, 201, 204].includes(res.status)) throw failure(res.status)
  }

  async publishDeviceHead(head, expected, signal) {
    const body = this.encodeDeviceHead(head)
    const condition = expected.kind === 'absent' ? { 'If-None-Match': '*' } : expected.kind === 'match' ? { 'If-Match': expected.revision } : {}
    let res
    try { res = await this.send('PUT', this.path(head.workspaceId, `devices/${head.deviceId}.json`), { signal, body, headers: { 'Content-Type': 'application/json', ...condition } }) }
    // The request may have reached the server; the caller reads its own head back.
    catch (error) { if (error.code === 'cross_origin') throw error; return { kind: 'unknown' } }
    if (res.status === 412) return { kind: 'conflict' }
    if (res.status === 401 || res.status === 403 || res.status === 507 || res.status === 413) throw failure(res.status)
    if (res.status !== 201 && res.status !== 204) return { kind: 'unknown', httpStatus: res.status }
    return { kind: 'committed', revision: strong(res.headers.etag) }
  }

  async readObject(workspaceId, hash, signal) {
    const res = await this.send('GET', this.path(workspaceId, `objects/sha256/${hash.slice(7)}`), { signal })
    if (res.status === 404) return null
    if (res.status !== 200) throw failure(res.status)
    return res.body
  }

  /** If-None-Match is advisory here (not atomic on Apache); content addressing makes races harmless. */
  async createObject(workspaceId, hash, bytes, signal) {
    if (sha(bytes) !== hash) throw new WebDavError('hash_mismatch')
    const path = this.path(workspaceId, `objects/sha256/${hash.slice(7)}`)
    for (let attempt = 0; ; attempt++) {
      const res = await this.send('PUT', path, { signal, body: bytes, headers: { 'Content-Type': 'application/octet-stream', 'If-None-Match': '*' } })
      if (res.status === 201 || res.status === 204) return 'created'
      // Nextcloud answers 423 while another request holds the file lock; retry with backoff.
      if (res.status === 423 && attempt < 8) { await backoff(attempt, signal); continue }
      // Nextcloud also answers 404 to some racing creates of one path; content addressing makes a
      // read-back (hash-checked) or a retry safe. Mirrors src-tauri/src/sync_native.rs.
      if (res.status === 404 && attempt < 8) {
        const existing = await this.readObject(workspaceId, hash, signal)
        if (existing && sha(existing) === hash) return 'exists'
        await backoff(attempt, signal); continue
      }
      if (res.status !== 412) throw failure(res.status)
      const existing = await this.readObject(workspaceId, hash, signal)
      if (!existing || sha(existing) !== hash) throw new WebDavError('remote_object_corrupt')
      return 'exists'
    }
  }
}

function backoff(attempt, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, Math.min(2000, 100 * 2 ** attempt) * (0.5 + Math.random() / 2))
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new WebDavError('aborted')) }, { once: true })
  })
}
