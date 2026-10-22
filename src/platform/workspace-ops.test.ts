import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { commitRename, isManagedImage, moveTarget, planRename, renameTarget, renameWarning, trashDocument, workspaceOpError } from './workspace-ops'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
beforeEach(() => vi.mocked(invoke).mockReset())
const bytes = (text: string | Uint8Array) => Array.from(typeof text === 'string' ? new TextEncoder().encode(text) : text)
const text = (value: number[]) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array(value))

describe('rename planning', () => {
  it('builds same-directory targets and rejects unportable names', () => {
    expect(renameTarget('notes/a.md', '新名')).toBe('notes/新名.md')
    expect(renameTarget('a.md', 'b.markdown')).toBe('b.markdown')
    for (const name of ['', 'x/y', 'con', 'aux.md', 'a\\b', 'q?.md']) expect(() => renameTarget('a.md', name), name).toThrow('invalid_name')
  })

  it('rewrites incoming links byte-exactly, keeping BOM, CRLF and mixed line endings', async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('[a](a.md)\r\nline\nend')])
    vi.mocked(invoke).mockResolvedValueOnce({ from: 'a.md', to: 'b.md', candidates: [
      { path: 'a.md', bytes: bytes('# A [self](a.md#x) [o](other.md)'), revision: 'r-a' },
      { path: 'index.md', bytes: bytes(bom), revision: 'r-i' },
      { path: 'unrelated.md', bytes: bytes('[x](c.md)'), revision: 'r-u' },
      { path: 'binary.md', bytes: [0xff, 0x00], revision: 'r-b' },
    ] })
    const plan = await planRename('ws', 'a.md', 'b.md')
    expect(invoke).toHaveBeenCalledWith('workspace_rename_prepare', { id: 'ws', from: 'a.md', to: 'b.md' })
    expect(plan.incoming).toEqual([{ path: 'index.md', links: 1 }])
    expect(plan.outgoing).toBe(1)
    expect(plan.skipped).toEqual(['binary.md'])
    const index = plan.rewrites.find((r) => r.path === 'index.md')!
    expect(index.expected).toBe('r-i')
    expect(index.bytes.slice(0, 3)).toEqual([0xef, 0xbb, 0xbf])
    expect(text(index.bytes)).toBe('﻿[a](b.md)\r\nline\nend')
    expect(text(plan.rewrites.find((r) => r.path === 'a.md')!.bytes)).toBe('# A [self](b.md#x) [o](other.md)')
  })

  it('commits with a fresh operation id and maps errors', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ path: 'b.md', warnings: [] })
    await commitRename('ws', { from: 'a.md', to: 'b.md', incoming: [], outgoing: 0, skipped: [], rewrites: [], images: [] })
    const [command, args] = vi.mocked(invoke).mock.calls[0] as [string, { operationId: string }]
    expect(command).toBe('workspace_rename')
    expect(args.operationId).toMatch(/^[0-9a-f-]{36}$/)
    vi.mocked(invoke).mockResolvedValueOnce({ operationId: 'x', path: 'a.md', documentId: null, warning: null })
    await trashDocument('ws', 'a.md', 'sha256:x')
    expect(invoke).toHaveBeenLastCalledWith('workspace_trash', expect.objectContaining({ id: 'ws', path: 'a.md', expected: 'sha256:x' }))
    expect(workspaceOpError('target_exists')).toContain('同名')
    expect(workspaceOpError('target_missing')).toContain('目标目录')
  })
})

describe('cross-directory move planning', () => {
  it('keeps managed images beside the document, re-points other links and updates incoming links', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ from: 'notes/a.md', to: 'archive/2026/a.md', candidates: [
      { path: 'notes/a.md', bytes: bytes('![图](assets/img-x-v1.png) [兄弟](b.md) [自身](a.md#h) [外](https://x.test)\n\n[ref]: ./assets/img-y-v1.png\n'), revision: 'r-a' },
      { path: 'notes/b.md', bytes: bytes('[回](a.md)'), revision: 'r-b' },
      { path: 'index.md', bytes: bytes('[入口](notes/a.md)'), revision: 'r-i' },
    ] })
    const plan = await planRename('ws', 'notes/a.md', 'archive/2026/a.md')
    expect(plan.images).toEqual(['assets/img-x-v1.png', 'assets/img-y-v1.png'])
    expect(text(plan.rewrites.find((r) => r.path === 'notes/a.md')!.bytes)).toBe('![图](assets/img-x-v1.png) [兄弟](../../notes/b.md) [自身](a.md#h) [外](https://x.test)\n\n[ref]: ./assets/img-y-v1.png\n')
    expect(text(plan.rewrites.find((r) => r.path === 'notes/b.md')!.bytes)).toBe('[回](../archive/2026/a.md)')
    expect(text(plan.rewrites.find((r) => r.path === 'index.md')!.bytes)).toBe('[入口](archive/2026/a.md)')
    vi.mocked(invoke).mockResolvedValueOnce({ path: 'archive/2026/a.md', warnings: [], sessions: [] })
    await commitRename('ws', plan)
    expect((vi.mocked(invoke).mock.calls[1][1] as { resources: { references: string[] } }).resources.references).toEqual(plan.images)
  })

  it('builds move targets and never treats unmanaged images as copyable', async () => {
    expect(moveTarget('notes/a.md', 'archive')).toBe('archive/a.md')
    expect(moveTarget('notes/a.md', '')).toBe('a.md')
    expect(() => moveTarget('notes/a.md', 'notes')).toThrow('invalid_name')
    expect(isManagedImage('assets/img-a-v1.png')).toBe(true)
    for (const path of ['photo.png', 'assets/photo.png', '../assets/img-a.png', 'assets/img-a.gif']) expect(isManagedImage(path)).toBe(false)
    vi.mocked(invoke).mockResolvedValueOnce({ from: 'a.md', to: 'd/a.md', candidates: [{ path: 'a.md', bytes: bytes('![x](photo.png)'), revision: 'r' }] })
    const plan = await planRename('ws', 'a.md', 'd/a.md')
    expect(plan.images).toEqual([])
    expect(text(plan.rewrites[0].bytes)).toBe('![x](../photo.png)')
    expect(renameWarning('link_skipped:b.md')).toContain('b.md')
  })
})
