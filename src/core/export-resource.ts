export function localImagePath(url: string): string | null {
  try {
    const path = decodeURIComponent(url)
    if (!path || /[\\:\x00-\x1f?#]/.test(path) || path.startsWith('/')) return null
    const parts = path.split('/').filter(part => part !== '.')
    if (parts.some(part => !part || part === '..')) return null
    return parts.join('/')
  } catch { return null }
}
