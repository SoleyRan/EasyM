// Reference WebDAV adapter for step-1 protocol verification only. The shipping Provider
// will be native (credentials stay in the OS store); this file keeps the same contract
// so the probe exercises real servers through src/core publish/resolve logic.
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

function failure(status) {
  if (status === 401 || status === 403) return new WebDavError('unauthorized', status)
  if (status === 507 || status === 413) return new WebDavError('quota_exceeded', status)
  return new WebDavError('unexpected_status', status)
}

/**
 * Implements the SyncProvider contract over a WebDAV collection laid out as
 * `<root>/easym-sync/v1/<workspaceId>/{head.json,objects/sha256/<hex>}`.
 */
export class WebDavSyncProvider {
  constructor(target, parseSyncHead) { this.target = target; this.parseSyncHead = parseSyncHead; this.stats = { requests: 0, bytesSent: 0, bytesReceived: 0 } }
  path(workspaceId, rest = '') { return `${this.target.root}easym-sync/v1/${workspaceId}/${rest}` }

  async send(method, path, options = {}) {
    this.stats.requests++; this.stats.bytesSent += options.body?.byteLength ?? 0
    const response = await (this.target.request ?? request)(this.target, method, path, options)
    this.stats.bytesReceived += response.body.byteLength
    return response
  }

  /** Creates the namespace collections; MKCOL on an existing collection returns 405. */
  async prepare(workspaceId, signal) {
    let path = this.target.root
    for (const part of ['easym-sync/', 'v1/', `${workspaceId}/`, 'objects/', 'sha256/']) {
      path += part
      const res = await this.send('MKCOL', path, { signal })
      if (![201, 405].includes(res.status)) throw failure(res.status)
    }
  }

  /**
   * Apache marks validators of files modified within the last second as weak; If-Match never
   * matches a weak tag. Wait briefly for a strong tag instead of accepting the weak one.
   */
  async readHead(workspaceId, signal) {
    for (let attempt = 0; ; attempt++) {
      const res = await this.send('GET', this.path(workspaceId, 'head.json'), { signal, maxBytes: MAX_HEAD })
      if (res.status === 404) return null
      if (res.status !== 200) throw failure(res.status)
      const revision = strong(res.headers.etag)
      if (revision) return { head: this.parseSyncHead(res.body, workspaceId), revision }
      if (!res.headers.etag?.startsWith('W/') || attempt >= 4) throw new WebDavError('weak_or_missing_etag', res.status)
      this.stats.weakEtagRetries = (this.stats.weakEtagRetries ?? 0) + 1
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 400)
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new WebDavError('aborted')) }, { once: true })
      })
    }
  }

  async publishHead(head, expected, signal) {
    const body = new TextEncoder().encode(JSON.stringify(head))
    const condition = expected.kind === 'absent' ? { 'If-None-Match': '*' } : { 'If-Match': expected.revision }
    let res
    try { res = await this.send('PUT', this.path(head.workspaceId, 'head.json'), { signal, body, headers: { 'Content-Type': 'application/json', ...condition } }) }
    // The request may have reached the server; only the ancestry can tell.
    catch (error) { if (error.code === 'cross_origin') throw error; return { kind: 'unknown' } }
    // `httpStatus` is diagnostic only (not part of the contract): the probe uses it to detect
    // servers that acknowledge several conditional writes against the same revision.
    if (res.status === 412) return { kind: 'conflict', httpStatus: res.status }
    if (res.status === 401 || res.status === 403 || res.status === 507 || res.status === 413) throw failure(res.status)
    if (res.status !== 201 && res.status !== 204) return { kind: 'unknown', httpStatus: res.status }
    const revision = strong(res.headers.etag)
    if (revision) return { kind: 'committed', value: { head, revision }, httpStatus: res.status }
    // Without an ETag in the PUT response, a follow-up read is not atomic; resolve via ancestry.
    return { kind: 'unknown', httpStatus: res.status }
  }

  async readObject(workspaceId, hash, signal) {
    const res = await this.send('GET', this.path(workspaceId, `objects/sha256/${hash.slice(7)}`), { signal })
    if (res.status === 404) return null
    if (res.status !== 200) throw failure(res.status)
    return res.body
  }

  async createObject(workspaceId, hash, bytes, signal) {
    if (sha(bytes) !== hash) throw new WebDavError('hash_mismatch')
    const path = this.path(workspaceId, `objects/sha256/${hash.slice(7)}`)
    const res = await this.send('PUT', path, { signal, body: bytes, headers: { 'Content-Type': 'application/octet-stream', 'If-None-Match': '*' } })
    if (res.status === 201 || res.status === 204) return 'created'
    if (res.status !== 412) throw failure(res.status)
    const existing = await this.readObject(workspaceId, hash, signal)
    if (!existing || sha(existing) !== hash) throw new WebDavError('remote_object_corrupt')
    return 'exists'
  }
}
