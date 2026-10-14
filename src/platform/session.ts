// A session index locates drafts; it never grants filesystem access or stores body text.
export const SESSION_KEY = 'easym-session'
export const MAX_SESSION_TABS = 100
export interface SessionTab { draftKey: string; name: string }
export interface SessionIndex { version: 1; tabs: SessionTab[]; activeDraftKey: string | null }
export interface SessionLoad { index: SessionIndex | null; error?: string }
const safeKey = (value: unknown): value is string => typeof value === 'string' && (value === 'current' || /^document:[^\s\x00-\x1f]{1,128}$/.test(value))

export function validateSession(value: unknown): SessionIndex {
  if (!value || typeof value !== 'object') throw new Error('会话索引无效，原记录已保留。')
  const data = value as Partial<SessionIndex>
  if (data.version !== 1 || !Array.isArray(data.tabs) || data.tabs.length > MAX_SESSION_TABS) throw new Error('会话索引格式不兼容或超过上限，原记录已保留。')
  const tabs: SessionTab[] = [], seen = new Set<string>()
  for (const item of data.tabs) {
    if (!item || !safeKey(item.draftKey) || typeof item.name !== 'string' || item.name.length > 512 || /[\x00-\x1f]/.test(item.name) || seen.has(item.draftKey)) throw new Error('会话索引条目无效，原记录已保留。')
    seen.add(item.draftKey); tabs.push({ draftKey: item.draftKey, name: item.name })
  }
  if (data.activeDraftKey !== null && (!safeKey(data.activeDraftKey) || !seen.has(data.activeDraftKey))) throw new Error('会话索引当前标签无效，原记录已保留。')
  return { version: 1, tabs, activeDraftKey: data.activeDraftKey }
}

export function loadSession(): SessionLoad {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return { index: null }
    if (raw.length > 100_000) throw new Error('会话索引超过大小上限，原记录已保留。')
    return { index: validateSession(JSON.parse(raw)) }
  } catch (error) { return { index: null, error: `无法读取会话索引：${String(error)}；仍会检查独立草稿。` } }
}

export function saveSession(index: SessionIndex): void {
  // Validation strips unknown fields, including old file handles or unsolicited paths.
  localStorage.setItem(SESSION_KEY, JSON.stringify(validateSession(index)))
}

export function reconcileSession(index: SessionIndex | null, draftKeys: string[]): SessionIndex {
  const available = new Set(draftKeys.filter(safeKey))
  const tabs = (index?.tabs ?? []).filter(tab => available.has(tab.draftKey))
  const included = new Set(tabs.map(tab => tab.draftKey))
  // Orphans remain recoverable even after an interrupted/failed index write.
  for (const draftKey of available) if (!included.has(draftKey)) tabs.push({ draftKey, name: '未命名.md' })
  const activeDraftKey = tabs.some(tab => tab.draftKey === index?.activeDraftKey) ? index!.activeDraftKey : tabs[0]?.draftKey ?? null
  return { version: 1, tabs, activeDraftKey }
}
