import { describe, expect, it, vi } from 'vitest'
import { EditorSelection } from '@codemirror/state'
import { CommandRegistry, commandDefinitions, validateCommandEdit, type CommandContext } from './commands'
const context = (): CommandContext => ({ documentId: 'tab-a', fileId: 'file-a', textRevision: 9, selection: { anchor: 3, head: 1 }, active: true, reading: false, composing: false })

describe('command dispatch contracts', () => {
  it('captures CodeMirror selection getters as an immutable target', () => {
    const current = { ...context(), selection: EditorSelection.range(3, 1) }
    const registry = new CommandRegistry(() => current)
    expect(registry.capture().selection).toEqual({ anchor: 3, head: 1 })
    current.selection = EditorSelection.cursor(0)
    expect(registry.capture().selection).toEqual({ anchor: 0, head: 0 })
  })
  it('rechecks target, revision and reverse selection before calling the shared handler', async () => {
    let current = context()
    const registry = new CommandRegistry(() => current), run = vi.fn()
    registry.register({ ...commandDefinitions[0], run })
    const captured = registry.capture()
    for (const replacement of [{ documentId: 'tab-b' }, { fileId: 'file-b' }, { textRevision: 10 }, { selection: { anchor: 1, head: 3 } }]) {
      current = { ...context(), ...replacement }
      expect((await registry.execute('format.bold', undefined, captured)).enabled).toBe(false)
    }
    expect(run).not.toHaveBeenCalled()
    current = context()
    expect((await registry.execute('format.bold', undefined, captured)).enabled).toBe(true)
    expect(run).toHaveBeenCalledExactlyOnceWith(context(), undefined)
  })
  it('checks runtime locks even when a button was enabled when rendered', async () => {
    let current = context()
    const registry = new CommandRegistry(() => current), run = vi.fn()
    registry.register({ ...commandDefinitions[0], status: () => ({ enabled: true, checked: 'mixed' }), run })
    expect(registry.status('format.bold').checked).toBe('mixed')
    for (const replacement of [{ composing: true }, { active: false }, { reading: true }, { lockReason: '图片正在提交' }]) {
      current = { ...context(), ...replacement }
      expect((await registry.execute('format.bold')).enabled).toBe(false)
      expect(registry.status('format.bold').reason).toBeTruthy()
    }
    expect(run).not.toHaveBeenCalled()
  })
  it('allows reading tools, retains shortcuts, refuses unknown and duplicate commands', async () => {
    const registry = new CommandRegistry(() => ({ ...context(), reading: true })), run = vi.fn()
    const reading = commandDefinitions.find(item => item.id === 'view.reading')!
    registry.register({ ...reading, run })
    expect((await registry.execute('view.reading')).enabled).toBe(true)
    expect((await registry.execute('shell')).enabled).toBe(false)
    expect(() => registry.register({ ...reading, run })).toThrow('Duplicate')
    expect(commandDefinitions.find(item => item.id === 'file.print')?.shortcut).toBe('Mod+P')
    expect(commandDefinitions.find(item => item.id === 'insert.image')?.shortcut).toBe('Mod+Shift+P')
  })
  it('invokes handlers before yielding and propagates cancellation/failure', async () => {
    const registry = new CommandRegistry(context), order: string[] = []
    registry.register({ ...commandDefinitions[0], run: () => { order.push('locked'); return false } })
    const result = registry.execute('format.bold'); order.push('caller')
    expect(order).toEqual(['locked', 'caller'])
    expect((await result).enabled).toBe(false)
  })
})

describe('atomic editor results', () => {
  const valid = { baseTextRevision: 9, patches: [{ from: 1, to: 3, insert: '**🙂**' }], selection: { anchor: 5, head: 3 } }
  it('uses UTF-16 offsets and accepts a reverse selection after a local patch', () => {
    expect(validateCommandEdit('a🙂z', valid, context(), context())).toBe(true)
    expect(validateCommandEdit('a🙂z', { ...valid, selection: undefined, patches: [] }, context(), context())).toBe(false)
    expect(validateCommandEdit('a🙂z', { ...valid, selection: undefined, patches: [{ from: 1, to: 3, insert: '🙂' }] }, context(), context())).toBe(false)
  })
  it('rejects obsolete or blocked edits without applying any patch', () => {
    for (const replacement of [{ fileId: null }, { textRevision: 10 }, { composing: true }, { lockReason: '保存' }, { reading: true }, { active: false }]) {
      expect(() => validateCommandEdit('a🙂z', valid, context(), { ...context(), ...replacement })).toThrow()
    }
    expect(() => validateCommandEdit('a🙂z', { ...valid, baseTextRevision: 0 }, context(), context())).toThrow()
  })
  it('rejects out of range, overlapping, ambiguous or invalid resulting selections', () => {
    for (const patches of [[{ from: -1, to: 2, insert: '' }], [{ from: 1.5, to: 2, insert: '' }], [{ from: 0, to: 5, insert: '' }], [{ from: 0, to: 3, insert: '' }, { from: 2, to: 4, insert: '' }], [{ from: 1, to: 1, insert: 'x' }, { from: 1, to: 1, insert: 'y' }]]) {
      expect(() => validateCommandEdit('a🙂z', { ...valid, patches }, context(), context())).toThrow()
    }
    expect(() => validateCommandEdit('a🙂z', { ...valid, selection: { anchor: 100, head: 0 } }, context(), context())).toThrow()
  })
})
