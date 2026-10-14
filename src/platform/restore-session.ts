import type { RecentState } from './recent'
import type { SessionIndex } from './session'
import { reconcileSession } from './session'

export interface RestoreTab { draftKey: string; name: string; draft: boolean; recentId?: string }
export function planRestoration(index: SessionIndex | null, draftKeys: string[], native: RecentState | null) {
  const drafts = reconcileSession(index, draftKeys), draftSet = new Set(drafts.tabs.map(tab => tab.draftKey))
  const layout = native?.session.tabs.length ? native.session.tabs : index?.tabs.map(tab => ({ draftKey: tab.draftKey, recentId: null })) ?? []
  const names = new Map(index?.tabs.map(tab => [tab.draftKey, tab.name]))
  const tabs: RestoreTab[] = [], included = new Set<string>()
  let savedCount = 0, limited = false
  for (const tab of layout) {
    const entry = native?.entries.find(entry => entry.kind === 'file' && entry.id === tab.recentId)
    const draft = draftSet.has(tab.draftKey)
    if (!draft && !entry) continue
    if (!draft && savedCount++ >= 20) { limited = true; continue }
    tabs.push({ draftKey: tab.draftKey, name: names.get(tab.draftKey) ?? entry?.name ?? '未命名.md', draft, recentId: entry?.id })
    included.add(tab.draftKey)
  }
  for (const tab of drafts.tabs) if (!included.has(tab.draftKey)) tabs.push({ ...tab, draft: true })
  return { tabs, activeDraftKey: native?.session.tabs.length ? native.session.activeDraftKey : index?.activeDraftKey ?? drafts.activeDraftKey, workspaceId: native?.session.workspaceId ?? null, limited }
}
