import { Text } from '@codemirror/state'
import { markdownLanguage } from '@codemirror/lang-markdown'
import { describe, expect, it } from 'vitest'
import { applyPatches, type Selection } from './document'
import { formatState, indentListItems, toggleFormat, type Format } from './formatting'

function state(text: string, selection: Selection) {
  return formatState(Text.of(text.split('\n')), selection, markdownLanguage.parser.parse(text))
}
function toggle(text: string, selection: Selection, kind: Format) {
  const result = toggleFormat(4, Text.of(text.split('\n')), selection, markdownLanguage.parser.parse(text), kind)
  return { text: applyPatches(text, result.patches), selection: result.selection! }
}
describe('format toggles and selection state', () => {
  it('toggles bold and italic without stacking and keeps reverse selections', () => {
    for (const kind of ['bold', 'italic'] as const) {
      const selection = { anchor: 6, head: 2 }, original = '前缀中文文字后缀'
      const applied = toggle(original, selection, kind)
      expect(state(applied.text, applied.selection)[kind]).toBe(true)
      expect(toggle(applied.text, applied.selection, kind)).toEqual({ text: original, selection })
      expect(applied.selection.anchor).toBeGreaterThan(applied.selection.head)
    }
  })
  it('recognizes alternate markers, excludes escapes/code, and retains the other nested format', () => {
    expect(state('__hello__', { anchor: 2, head: 7 }).bold).toBe(true)
    expect(toggle('__hello__', { anchor: 2, head: 7 }, 'bold').text).toBe('hello')
    expect(toggle('***both***', { anchor: 3, head: 7 }, 'bold').text).toBe('*both*')
    expect(toggle('***both***', { anchor: 3, head: 7 }, 'italic').text).toBe('**both**')
    expect(state('`**literal**`', { anchor: 3, head: 6 }).bold).toBe(false)
    expect(state('\\*literal\\*', { anchor: 2, head: 8 }).italic).toBe(false)
  })
  it('removes formatting only from the selected portion and preserves surrounding formatted text', () => {
    const changed = toggle('before **one two three** after', { anchor: 13, head: 16 }, 'bold')
    expect(changed.text).toBe('before **one** two **three** after')
    expect(state(changed.text, changed.selection).bold).toBe(false)
    expect(toggle('__abcdef__', { anchor: 4, head: 6 }, 'bold').text).toBe('**ab**cd**ef**')
  })
  it('normalizes mixed ranges instead of nesting the same format', () => {
    const text = '**one** plain **two**'
    expect(state(text, { anchor: 0, head: text.length }).bold).toBe('mixed')
    const applied = toggle(text, { anchor: 0, head: text.length }, 'bold')
    expect(applied.text).toBe('**one plain two**')
    expect(toggle(applied.text, applied.selection, 'bold').text).toBe('one plain two')
    expect(toggle('**abc** plain', { anchor: 3, head: 13 }, 'bold').text).toBe('**abc plain**')
    const spaces = toggle('  hello  ', { anchor: 0, head: 9 }, 'bold')
    expect(spaces.text).toBe('  **hello**  ')
    expect(state(spaces.text, spaces.selection).bold).toBe(true)
    expect(toggle(spaces.text, spaces.selection, 'bold').text).toBe('  hello  ')
    expect(toggle(spaces.text, { anchor: 4, head: 9 }, 'bold').text).toBe('  hello  ')
  })
  it('handles carets and selections including Markdown markers', () => {
    expect(toggle('**hello**', { anchor: 4, head: 4 }, 'bold').text).toBe('hello')
    expect(toggle('**hello**', { anchor: 0, head: 9 }, 'bold').text).toBe('hello')
    const added = toggle('a b', { anchor: 2, head: 2 }, 'bold')
    expect(added.text).toBe('a **文本**b')
    expect(toggle(added.text, added.selection, 'bold').text).toBe('a 文本b')
  })
  it('toggles line formats and replaces list types without duplicate prefixes', () => {
    for (const kind of ['heading', 'quote', 'bullet', 'ordered', 'task'] as const) {
      const original = 'one\ntwo\nuntouched', selection = { anchor: 0, head: 8 }
      const applied = toggle(original, selection, kind)
      expect(state(applied.text, applied.selection)[kind]).toBe(true)
      expect(toggle(applied.text, applied.selection, kind).text).toBe(original)
    }
    expect(toggle('- [x] done\n+ item', { anchor: 0, head: 17 }, 'ordered').text).toBe('1. done\n1. item')
    expect(toggle('### heading', { anchor: 5, head: 9 }, 'heading').text).toBe('heading')
    expect(toggle('### heading ###', { anchor: 5, head: 9 }, 'heading').text).toBe('heading')
    expect(toggle('### ###', { anchor: 0, head: 7 }, 'heading').text).toBe('')
    expect(toggle('> - item', { anchor: 5, head: 8 }, 'task').text).toBe('> - [ ] item')
    expect(toggle('> one\ntwo', { anchor: 0, head: 9 }, 'quote').text).toBe('> one\n> two')
  })
  it('removes setext headings without losing the next paragraph', () => {
    expect(toggle('Heading\n=======\n\nkeep', { anchor: 1, head: 6 }, 'heading').text).toBe('Heading\n\nkeep')
    expect(toggle('Heading\n=======\nplain', { anchor: 0, head: 20 }, 'heading').text).toBe('## Heading\n## plain')
  })
  it('toggles fenced code separately from language changes', () => {
    const applied = toggle('hello', { anchor: 0, head: 5 }, 'code')
    expect(applied.text).toBe('```\nhello\n```\n')
    expect(state(applied.text, applied.selection).code).toBe(true)
    expect(toggle(applied.text, applied.selection, 'code').text).toBe('hello\n')
    expect(toggle('~~~python\ntext\n~~~', { anchor: 11, head: 14 }, 'code').text).toBe('text')
    expect(toggle('```', { anchor: 3, head: 3 }, 'code').text).toBe('')
    expect(toggle('```js\nunfinished', { anchor: 7, head: 10 }, 'code').text).toBe('unfinished')
  })
  it('cancels links while retaining the label, nested formatting and definitions', () => {
    expect(toggle('[**hello**](https://example.com)', { anchor: 3, head: 8 }, 'link').text).toBe('**hello**')
    expect(toggle('[hello][id]\n\n[id]: /target', { anchor: 1, head: 6 }, 'link').text).toBe('hello\n\n[id]: /target')
    expect(() => toggle('hello', { anchor: 0, head: 5 }, 'link')).toThrow('链接工具')
  })
})

describe('list indentation with Tab', () => {
  const run = (text: string, selection: Selection, outdent = false) => {
    const result = indentListItems(4, Text.of(text.split('\n')), selection, markdownLanguage.parser.parse(text), outdent)
    return result && { text: applyPatches(text, result.patches), selection: result.selection!, changed: result.patches.length > 0 }
  }
  const at = (text: string, marker: string) => text.indexOf(marker) + marker.length

  it('nests an ordered item under the previous item at its content column and restarts at 1', () => {
    const text = '1. a\n2. '
    const nested = run(text, { anchor: text.length, head: text.length })!
    expect(nested.text).toBe('1. a\n   1. ')
    expect(nested.selection).toEqual({ anchor: nested.text.length, head: nested.text.length })
    expect(run('18. a\n19. b', { anchor: at('18. a\n19. b', '19. '), head: at('18. a\n19. b', '19. ') })!.text).toBe('18. a\n    1. b')
    expect(run('- a\n- b', { anchor: 6, head: 6 })!.text).toBe('- a\n  - b')
    expect(run('1.  a\n2.  b', { anchor: 10, head: 10 })!.text).toBe('1.  a\n    1.  b')
  })
  it('outdents back to the parent level and continues its numbering', () => {
    const text = '1. a\n   1. b\n   2. c\n2. d'
    expect(run(text, { anchor: at(text, '2. c'), head: at(text, '2. c') }, true)!.text).toBe('1. a\n   1. b\n2. c\n2. d')
    expect(run('3. a\n   1. b', { anchor: 12, head: 12 }, true)!.text).toBe('3. a\n4. b')
  })
  it('moves several selected items and their children together', () => {
    const text = '1. a\n2. b\n3. c\n   - child\n4. d'
    const selection = { anchor: at(text, '2. '), head: at(text, '3. c') }
    expect(run(text, selection)!.text).toBe('1. a\n   1. b\n   2. c\n      - child\n4. d')
  })
  it('keeps Tab for navigation outside lists and swallows it on items that cannot move', () => {
    expect(run('plain text', { anchor: 3, head: 3 })).toBeNull()
    expect(run('```\n1. a\n```', { anchor: 6, head: 6 })).toBeNull()
    expect(run('> 1. a\n> 2. b', { anchor: 12, head: 12 })).toBeNull()
    expect(run('1. a\n\ntext', { anchor: 0, head: 10 })).toBeNull()
    expect(run('1. first', { anchor: 3, head: 3 })!.changed).toBe(false)
    expect(run('1. top', { anchor: 3, head: 3 }, true)!.changed).toBe(false)
  })
  it('renders the nested result as a nested ordered list', () => {
    const tree = markdownLanguage.parser.parse('1. a\n   1. b')
    let lists = 0
    tree.iterate({ enter: ref => { if (ref.name === 'OrderedList') lists++ } })
    expect(lists).toBe(2)
  })
})
