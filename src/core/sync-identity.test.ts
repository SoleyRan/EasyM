import { describe, expect, it } from 'vitest'
import { encodeWorkspaceIdentity, IdentityError, parseWorkspaceIdentity, reconcileIdentity, resolveIdentity, type DiskDocument, type WorkspaceIdentity } from './sync-identity'

const workspaceId = '1358f0a2-25b8-441b-9d55-379f6ca303dc'
const id = (n: number) => `a1b2c3d4-0000-4000-8000-${String(n).padStart(12, '0')}`
const counter = (start = 100) => { let n = start; return () => id(n++) }
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const code = (fn: () => unknown) => { try { fn(); return 'none' } catch (error) { return error instanceof IdentityError ? error.code : String(error) } }
const identity = (documents: WorkspaceIdentity['documents']): WorkspaceIdentity => ({ schemaVersion: 1, workspaceId, documents })
const disk = (path: string, historyId: string | null = null, extra: Partial<DiskDocument> = {}): DiskDocument => ({ path, historyId, ...extra })

describe('workspace identity file', () => {
  it('round-trips deterministically and keeps the history mapping', () => {
    const value = identity([{ documentId: id(2), path: '笔记/b.md' }, { documentId: id(1), path: 'a.md', historyId: id(9) }])
    const bytes = encodeWorkspaceIdentity(value)
    expect(encodeWorkspaceIdentity({ ...value, documents: [...value.documents].reverse() })).toEqual(bytes)
    expect(parseWorkspaceIdentity(bytes).documents.map((d) => d.path)).toEqual(['a.md', '笔记/b.md'])
    expect(parseWorkspaceIdentity(bytes).documents[0].historyId).toBe(id(9))
  })

  it('rejects unknown schema, extra fields, absolute paths, devices paths and non-Markdown', () => {
    const valid = { schemaVersion: 1, workspaceId, documents: [{ documentId: id(1), path: 'a.md' }] }
    expect(code(() => parseWorkspaceIdentity(encode({ ...valid, schemaVersion: 2 })))).toBe('unsupported_schema')
    expect(code(() => parseWorkspaceIdentity(encode({ ...valid, endpoint: 'https://x' })))).toBe('invalid_identity')
    for (const path of ['C:/Users/a.md', '/home/a.md', '../a.md', 'con.md', 'a.txt', 'e\u0301.md']) {
      expect(code(() => parseWorkspaceIdentity(encode({ ...valid, documents: [{ documentId: id(1), path }] })))).toBe('invalid_identity')
    }
    expect(code(() => parseWorkspaceIdentity(encode({ ...valid, documents: [{ documentId: id(1), path: 'a.md', absolutePath: 'C:/a.md' }] })))).toBe('invalid_identity')
    expect(code(() => parseWorkspaceIdentity(encode({ ...valid, documents: [{ documentId: id(1), path: 'a.md', historyId: id(1) }] })))).toBe('invalid_identity')
    expect(code(() => parseWorkspaceIdentity(new Uint8Array([0xff])))).toBe('invalid_identity')
  })

  it('rejects duplicate identities and case-folded duplicate paths', () => {
    expect(code(() => parseWorkspaceIdentity(encode(identity([{ documentId: id(1), path: 'a.md' }, { documentId: id(1), path: 'b.md' }]))))).toBe('duplicate_identity')
    expect(code(() => parseWorkspaceIdentity(encode(identity([{ documentId: id(1), path: 'Readme.md' }, { documentId: id(2), path: 'README.md' }]))))).toBe('path_conflict')
  })
})

describe('identity reconciliation', () => {
  it('creates a workspace identity, reusing unique history ids and generating the rest', () => {
    const plan = reconcileIdentity(null, [disk('a.md', id(7)), disk('b.md')], () => workspaceId, counter())
    expect(plan.changed).toBe(true)
    expect(plan.identity.workspaceId).toBe(workspaceId)
    expect(plan.added).toEqual([{ documentId: id(7), path: 'a.md', reusedHistory: true }, { documentId: id(100), path: 'b.md', reusedHistory: false }])
  })

  it('keeps identity for unchanged paths and reports no change', () => {
    const current = identity([{ documentId: id(1), path: 'a.md' }])
    const plan = reconcileIdentity(current, [disk('a.md', id(55))], () => workspaceId, counter())
    expect(plan.changed).toBe(false)
    expect(plan.identity.documents).toEqual(current.documents)
  })

  it('never matches by content: a missing document plus a new file pauses instead of guessing', () => {
    const current = identity([{ documentId: id(1), path: 'old.md' }])
    const plan = reconcileIdentity(current, [disk('new.md')], () => workspaceId, counter())
    expect(plan.missing).toEqual([{ documentId: id(1), path: 'old.md' }])
    expect(plan.paused).toEqual([{ path: 'new.md', reason: 'possible_move', historyId: null }])
    expect(plan.identity.documents).toEqual(current.documents)
  })

  it('pauses duplicate history ids from copied directories, case conflicts and unreadable history', () => {
    const plan = reconcileIdentity(null, [disk('a/x.md', id(7)), disk('b/x.md', id(7)), disk('Note.md'), disk('NOTE.md'), disk('h.md', null, { historyUnreadable: true }), disk('ok.md')], () => workspaceId, counter())
    expect(plan.paused.map((p) => [p.path, p.reason])).toEqual([['NOTE.md', 'path_conflict'], ['Note.md', 'path_conflict'], ['a/x.md', 'duplicate_history_id'], ['b/x.md', 'duplicate_history_id'], ['h.md', 'history_unreadable']])
    expect(plan.added.map((d) => d.path)).toEqual(['ok.md'])
  })

  it('pauses a history id already used by another tracked document', () => {
    const current = identity([{ documentId: id(7), path: 'a.md' }])
    const plan = reconcileIdentity(current, [disk('a.md', id(7)), disk('copy/a.md', id(7))], () => workspaceId, counter())
    expect(plan.paused).toEqual([{ path: 'copy/a.md', reason: 'duplicate_history_id', historyId: id(7) }])
  })

  it('pauses paths that cannot exist on every platform', () => {
    const plan = reconcileIdentity(null, [disk('aux.md'), disk('dir./a.md'), disk('fine.md')], () => workspaceId, counter())
    expect(plan.paused.map((p) => p.reason)).toEqual(['unportable_path', 'unportable_path'])
  })
})

describe('explicit identity resolution', () => {
  const current = identity([{ documentId: id(1), path: 'old.md' }, { documentId: id(2), path: 'gone.md' }])
  const plan = reconcileIdentity(current, [disk('new.md'), disk('other.md', id(9))], () => workspaceId, counter())

  it('binds a moved file to its previous identity, assigns new ones and forgets confirmed deletions', () => {
    const result = resolveIdentity(plan, [{ kind: 'bind', path: 'new.md', documentId: id(1) }, { kind: 'assign', path: 'other.md' }, { kind: 'forget', documentId: id(2) }], counter(200))
    expect(result.documents).toEqual([{ documentId: id(1), path: 'new.md' }, { documentId: id(200), path: 'other.md', historyId: id(9) }])
  })

  it('rejects binding to an unknown or present document and resolving unpaused paths', () => {
    expect(code(() => resolveIdentity(plan, [{ kind: 'bind', path: 'new.md', documentId: id(3) }], counter()))).toBe('invalid_identity')
    expect(code(() => resolveIdentity(plan, [{ kind: 'assign', path: 'old.md' }], counter()))).toBe('invalid_identity')
    expect(code(() => resolveIdentity(plan, [{ kind: 'forget', documentId: id(9) }], counter()))).toBe('invalid_identity')
    expect(code(() => resolveIdentity(plan, [{ kind: 'assign', path: 'new.md' }, { kind: 'bind', path: 'new.md', documentId: id(1) }], counter()))).toBe('invalid_identity')
  })

  it('refuses to resolve case conflicts or unportable paths by assignment', () => {
    const conflict = reconcileIdentity(null, [disk('A.md'), disk('a.md')], () => workspaceId, counter())
    expect(code(() => resolveIdentity(conflict, [{ kind: 'assign', path: 'A.md' }], counter()))).toBe('invalid_identity')
  })
})
