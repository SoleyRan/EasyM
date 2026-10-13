import { expect, it } from 'vitest'
import { attachDescriptions, describeMetadata, joinBytes, removePrivateMetadata } from './image-metadata'
const segment = (marker: number, values: number[]) => new Uint8Array([255, marker, 0, values.length + 2, ...values])
it('removes EXIF, XMP/ICC and comments without changing JPEG scan bytes', () => {
  const bytes = joinBytes([new Uint8Array([255,216]), segment(0xe1, [1,2]), segment(0xe2, [3]), segment(0xfe, [4]), new Uint8Array([255,218,0,2,7,8,255,217])])
  expect([...removePrivateMetadata(bytes, 'image/jpeg')]).toEqual([255,216,255,218,0,2,7,8,255,217])
  expect(() => describeMetadata(bytes, 'image/jpeg')).toThrow(/EXIF/)
})
it('explicitly preserves supported descriptive comments and rejects malformed segments', () => {
  const comment = segment(0xfe, [65,66]), scan = new Uint8Array([255,216,255,218,0,2,1,255,217])
  const withComment = attachDescriptions(scan, 'image/jpeg', [comment])
  expect(describeMetadata(withComment, 'image/jpeg')).toEqual([comment])
  expect(removePrivateMetadata(withComment, 'image/jpeg')).toEqual(scan)
  expect(() => removePrivateMetadata(new Uint8Array([255,216,255,225,0,100]), 'image/jpeg')).toThrow()
})
it('rejects XMP and raw profiles carried in PNG text chunks while allowing ordinary descriptions', () => {
  function pngText(kind: string, keyword: string) {
    const payload = new TextEncoder().encode(keyword + '\0text'), chunk = new Uint8Array(12 + payload.length)
    new DataView(chunk.buffer).setUint32(0, payload.length)
    chunk.set(new TextEncoder().encode(kind), 4); chunk.set(payload, 8)
    return joinBytes([new Uint8Array([137,80,78,71,13,10,26,10]), chunk])
  }
  expect(() => describeMetadata(pngText('iTXt', 'XML:com.adobe.xmp'), 'image/png')).toThrow(/XMP/)
  expect(() => describeMetadata(pngText('zTXt', 'Raw profile type exif'), 'image/png')).toThrow(/EXIF/)
  expect(describeMetadata(pngText('tEXt', 'Description'), 'image/png')).toHaveLength(1)
})
