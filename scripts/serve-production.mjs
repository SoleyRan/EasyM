import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'

// Existing-user regression fixtures explicitly acknowledge onboarding; dedicated tests cover first run.
export async function acknowledgeGuide(page) {
  const { version } = JSON.parse(await readFile(resolve('package.json'), 'utf8'))
  await page.addInitScript(version => localStorage.setItem('easym-guide-version', version), version)
}

export async function selectAppearanceTheme(page, theme) {
  const labels = { light: '清爽浅色', dark: '午夜深色', paper: '暖纸', forest: '护眼绿' }
  const value = labels[theme] ? theme : Object.keys(labels).find(key => labels[key] === theme)
  if (!value) throw new Error(`Unknown theme: ${theme}`)
  await page.getByRole('button', { name: 'EM 菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '设置', exact: true }).click()
  await page.getByLabel('设置配色主题', { exact: true }).selectOption(value)
  await page.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '完成', exact: true }).click()
}

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
