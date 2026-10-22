import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { commitRename, planRename, renameTarget, trashDocument, workspaceOpError } from './workspace-ops'

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
    await commitRename('ws', { from: 'a.md', to: 'b.md', incoming: [], outgoing: 0, skipped: [], rewrites: [] })
    const [command, args] = vi.mocked(invoke).mock.calls[0] as [string, { operationId: string }]
    expect(command).toBe('workspace_rename')
    expect(args.operationId).toMatch(/^[0-9a-f-]{36}$/)
    vi.mocked(invoke).mockResolvedValueOnce({ operationId: 'x', path: 'a.md', documentId: null, warning: null })
    await trashDocument('ws', 'a.md', 'sha256:x')
    expect(invoke).toHaveBeenLastCalledWith('workspace_trash', expect.objectContaining({ id: 'ws', path: 'a.md', expected: 'sha256:x' }))
    expect(workspaceOpError('target_exists')).toContain('同名')
    expect(workspaceOpError('cross_directory')).toContain('跨目录')
  })
})
