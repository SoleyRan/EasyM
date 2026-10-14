import { expect, it } from 'vitest'
import { planRestoration } from './restore-session'
import type { RecentState } from './recent'
it('bounds saved-file startup without hiding draft bodies and retains native order and activity', () => {
  const native: RecentState = { entries: Array.from({ length: 30 }, (_, i) => ({ id: String(i), kind: 'file', name: '同名.md', location: `/${i}/同名.md` })), session: { tabs: Array.from({ length: 30 }, (_, i) => ({ draftKey: `document:${i}`, recentId: String(i) })), activeDraftKey: 'document:25', workspaceId: 'workspace' } }
  const result = planRestoration(null, ['document:25', 'document:orphan'], native)
  expect(result.tabs).toHaveLength(22)
  expect(result.tabs.filter(t => !t.draft)).toHaveLength(20)
  expect(result.tabs.find(t => t.draftKey === 'document:25')).toMatchObject({ draft: true, recentId: '25' })
  expect(result.tabs.at(-1)?.draftKey).toBe('document:orphan')
  expect(result.activeDraftKey).toBe('document:25'); expect(result.limited).toBe(true)
})
