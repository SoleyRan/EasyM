import { describe, expect, it } from 'vitest'
import { zipArchive } from './archive'

describe('workspace archive', () => {
  it('writes a zip local header, central directory and rejects traversal', () => {
    const bytes = zipArchive([{ path: 'note.md', bytes: new TextEncoder().encode('# note') }])
    expect(Array.from(bytes.slice(0, 4))).toEqual([80, 75, 3, 4])
    expect(Array.from(bytes.slice(-22, -18))).toEqual([80, 75, 5, 6])
    expect(() => zipArchive([{ path: '../note.md', bytes: new Uint8Array() }])).toThrow()
  })

  it('rejects absolute, device, duplicate and normalized traversal paths', () => {
    for (const path of ['/note.md', 'C:/note.md', 'assets\\note.md', 'assets/../note.md', 'assets//note.md', 'assets/./note.md', 'a\u0000.md']) {
      expect(() => zipArchive([{ path, bytes: new Uint8Array() }])).toThrow()
    }
    const file = { path: 'note.md', bytes: new Uint8Array() }
    expect(() => zipArchive([file, file])).toThrow('Duplicate')
  })
})
