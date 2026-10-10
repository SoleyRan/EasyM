import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { expect, it } from 'vitest'
import { parseDocument } from '../core/markdown'
import { largeLines } from './large-lines'
import { liveRendering, setLiveBlocks, setLiveEnabled } from './live-decoration'

it('invalidates rendered block ranges on edits and rejects delayed results for a previous document', () => {
  const text = 'active\n\n```js\nconst x=1\n```\n\nlast'
  let state = EditorState.create({ doc: text, extensions: [largeLines, markdown({ base: markdownLanguage }), liveRendering({ image: async () => null, editImage: () => undefined })] })
  const doc = state.doc, blocks = parseDocument(text).blocks!
  const count = () => state.facet(EditorView.decorations).reduce((sum, value) => sum + (typeof value === 'function' ? 0 : value.size), 0)
  state = state.update({ effects: [setLiveEnabled.of(true), setLiveBlocks.of({ doc, blocks, context: null })] }).state
  expect(count()).toBe(1)
  state = state.update({ changes: { from: 0, insert: 'changed ' } }).state
  expect(count()).toBe(0)
  state = state.update({ effects: setLiveBlocks.of({ doc, blocks, context: null }) }).state
  expect(count()).toBe(0)
  state = state.update({ effects: setLiveBlocks.of({ doc: state.doc, blocks: parseDocument(state.doc.toString()).blocks!, context: null }) }).state
  expect(count()).toBe(1)
})
