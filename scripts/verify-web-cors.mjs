// v2.0 step 5C: can a browser build of EasyM talk to the step-1 WebDAV servers directly?
// A probe page on its own origin sends the requests the sync core needs, with correct
// credentials, from Chromium and WebKit: once directly, once through a local proxy that only
// adds CORS headers. Direct shows what users get; proxy shows what server-side CORS would give.
// Usage: node scripts/verify-web-cors.mjs
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium, webkit } from 'playwright'

const env = Object.fromEntries((await readFile('test-results/v2.0/step-1/webdav.env', 'utf8')).split(/\r?\n/).filter(Boolean).map((l) => l.split(/=(.*)/s, 2)))
const targets = {
  apache: { origin: 'http://127.0.0.1:18081', root: '/dav/', user: env.EASYM_DAV_USER, password: env.EASYM_DAV_PASSWORD },
  nextcloud: { origin: 'http://127.0.0.1:18082', root: `/remote.php/dav/files/${env.EASYM_NC_ADMIN_USER}/`, user: env.EASYM_NC_ADMIN_USER, password: env.EASYM_NC_ADMIN_PASSWORD },
}
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

/** The page origin: any other port is a different origin, as a hosted web app would be. */
const page = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>probe</title>') })
const pagePort = await listen(page), pageOrigin = `http://127.0.0.1:${pagePort}`

/** Forwards to `target` and adds only what CORS needs; answers preflights itself. */
function corsProxy(target) {
  return http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': pageOrigin, 'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, PUT, DELETE, PROPFIND, MKCOL, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Depth, Content-Type, If-Match, If-None-Match',
      'Access-Control-Expose-Headers': 'ETag, Last-Modified', 'Access-Control-Max-Age': '60',
    }
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return }
    const { origin, referer, ...headers } = req.headers
    const upstream = http.request(new URL(req.url, target.origin), { method: req.method, headers: { ...headers, host: new URL(target.origin).host } }, (up) => {
      res.writeHead(up.statusCode, { ...up.headers, ...cors }); up.pipe(res)
    })
    upstream.on('error', () => { res.writeHead(502, cors); res.end() })
    req.pipe(upstream)
  })
}

/**
 * Same origin through a reverse proxy: serves the app page at /probe and forwards everything else
 * to the server unchanged, with no CORS headers. This is how a self-hosted web build would sit
 * next to its WebDAV server. (Navigating to the server's own 401 page is not equivalent: Nextcloud
 * sends `Content-Security-Policy: default-src 'none'` with it, which blocks every fetch.)
 */
function sameOriginProxy(target) {
  return http.createServer((req, res) => {
    if (req.url === '/probe') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>probe</title>'); return }
    const { origin, referer, ...headers } = req.headers
    const upstream = http.request(new URL(req.url, target.origin), { method: req.method, headers: { ...headers, host: new URL(target.origin).host } }, (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res) })
    upstream.on('error', () => { res.writeHead(502); res.end() })
    req.pipe(upstream)
  })
}

/** Runs in the page: what a web build would need for local files and offline use. */
function capabilities() {
  return {
    secureContext: window.isSecureContext,
    directoryPicker: typeof window.showDirectoryPicker === 'function',
    originPrivateFileSystem: typeof navigator.storage?.getDirectory === 'function',
    serviceWorker: 'serviceWorker' in navigator,
    persistentStorage: typeof navigator.storage?.persist === 'function',
    subtleCrypto: !!crypto.subtle,
  }
}

/**
 * Runs in the page: the request types the sync core needs, in order. Each step records the HTTP
 * status, or `blocked` when the browser refused it (CORS, mixed content) — fetch then rejects
 * without a status. Readable validators matter: the core needs ETag for conditional head writes.
 */
async function sequence({ base, user, password, workspace }) {
  const auth = { Authorization: 'Basic ' + btoa(unescape(encodeURIComponent(`${user}:${password}`))) }
  const steps = []
  const step = async (name, path, init) => {
    try {
      const res = await fetch(`${base}${path}`, { ...init, credentials: 'omit', redirect: 'manual' })
      const result = { name, status: res.status, etag: res.headers.get('ETag'), modified: res.headers.get('Last-Modified') }
      steps.push(result); return result
    } catch (error) {
      const result = { name, status: 'blocked', error: String(error).slice(0, 80) }
      steps.push(result); return result
    }
  }
  const propfind = '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>'
  const path = ''
  await step('propfind', path, { method: 'PROPFIND', headers: { ...auth, Depth: '1', 'Content-Type': 'application/xml' }, body: propfind })
  const ws = `easym-cors-${workspace}/`
  await step('mkcol', ws, { method: 'MKCOL', headers: auth })
  await step('put_create', `${ws}head.json`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json', 'If-None-Match': '*' }, body: '{"v":1}' })
  const get = await step('get', `${ws}head.json`, { method: 'GET', headers: auth })
  await step('put_if_match', `${ws}head.json`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json', 'If-Match': get.etag ?? '"none"' }, body: '{"v":2}' })
  await step('delete_file', `${ws}head.json`, { method: 'DELETE', headers: auth })
  await step('delete_collection', ws, { method: 'DELETE', headers: auth })
  return steps
}

// Each server and browser: directly (what a hosted web app gets) and through the CORS proxy
// (what server-side CORS configuration would give). Run in both engines a desktop browser uses.
const report = { verifiedAt: new Date().toISOString(), pageOrigin, scope: 'Loopback HTTP; real Chromium and WebKit; the proxy only adds CORS headers.', results: {} }
const proxies = []
try {
  for (const [name, target] of Object.entries(targets)) {
    const proxy = corsProxy(target); proxies.push(proxy)
    const proxyBase = `http://127.0.0.1:${await listen(proxy)}${target.root}`
    const reverse = sameOriginProxy(target); proxies.push(reverse)
    const sameOrigin = `http://127.0.0.1:${await listen(reverse)}`
    for (const engine of [chromium, webkit]) {
      const browser = await engine.launch()
      const tab = await browser.newPage(); await tab.goto(pageOrigin)
      for (const [mode, base] of [['direct', `${target.origin}${target.root}`], ['cors-proxy', proxyBase]]) {
        const steps = await tab.evaluate(sequence, { base, user: target.user, password: target.password, workspace: randomUUID() })
        report.results[`${name}/${engine.name()}/${mode}`] = steps
        console.log(`${name.padEnd(9)} ${engine.name().padEnd(8)} ${mode.padEnd(11)} ${steps.map((s) => `${s.name}=${s.status}`).join(' ')}`)
      }
      report.capabilities ??= {}
      report.capabilities[engine.name()] = await tab.evaluate(capabilities)
      await tab.close()
      // Same origin through a reverse proxy (no CORS headers at all).
      const sameTab = await browser.newPage()
      await sameTab.goto(`${sameOrigin}/probe`)
      const same = await sameTab.evaluate(sequence, { base: `${sameOrigin}${target.root}`, user: target.user, password: target.password, workspace: randomUUID() })
      report.results[`${name}/${engine.name()}/same-origin`] = same
      console.log(`${name.padEnd(9)} ${engine.name().padEnd(8)} same-origin ${same.map((s) => `${s.name}=${s.status}`).join(' ')}`)
      await sameTab.close()
      await browser.close()
    }
  }
} finally { page.close(); for (const proxy of proxies) proxy.close() }
await mkdir('test-results/v2.0/step-5', { recursive: true })
await writeFile('test-results/v2.0/step-5/web-cors.json', JSON.stringify(report, null, 2) + '\n')
console.log('Report: test-results/v2.0/step-5/web-cors.json')
