import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'

export async function serveProduction() {
  const root = resolve('dist')
  const config = JSON.parse(await readFile(resolve('src-tauri/tauri.conf.json'), 'utf8'))
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname
      const path = resolve(root, '.' + decodeURIComponent(pathname === '/' ? '/index.html' : pathname))
      if (!path.startsWith(root + sep)) { response.writeHead(403).end(); return }
      const body = await readFile(path)
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[extname(path)] ?? 'application/octet-stream'
      response.writeHead(200, { 'Content-Type': mime, 'Content-Security-Policy': config.app.security.csp }); response.end(body)
    } catch { response.writeHead(404).end() }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}
