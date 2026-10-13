type Segment = { from: number; to: number; kind: string }
function segments(bytes: Uint8Array, mime: string): Segment[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), result: Segment[] = []
  if (mime === 'image/png') {
    for (let from = 8; from < bytes.length;) {
      if (from + 12 > bytes.length) throw new Error('PNG 元数据损坏。')
      const to = from + 12 + view.getUint32(from), kind = String.fromCharCode(...bytes.slice(from + 4, from + 8))
      if (to > bytes.length) throw new Error('PNG 元数据损坏。')
      result.push({ from, to, kind }); from = to
      if (kind === 'IEND') break
    }
  } else {
    let from = 2
    while (from < bytes.length) {
      if (bytes[from] !== 255 || from + 2 > bytes.length) throw new Error('JPEG 元数据损坏。')
      let tag = from + 1; while (bytes[tag] === 255) tag++
      const marker = bytes[tag], kind = marker.toString(16)
      if (marker === 0xda || marker === 0xd9) break
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) { from = tag + 1; continue }
      if (tag + 3 > bytes.length) throw new Error('JPEG 元数据损坏。')
      const length = view.getUint16(tag + 1), to = tag + 1 + length
      if (length < 2 || to > bytes.length) throw new Error('JPEG 元数据损坏。')
      result.push({ from, to, kind }); from = to
    }
  }
  return result
}
/** Copy only descriptive metadata that cannot reapply orientation or a color profile. */
export function describeMetadata(bytes: Uint8Array, mime: string): Uint8Array[] {
  const list = segments(bytes, mime)
  if (list.some(s => {
    if (mime !== 'image/png') return ['e1', 'e2', 'ed'].includes(s.kind)
    if (['eXIf', 'iCCP'].includes(s.kind)) return true
    if (!['tEXt', 'zTXt', 'iTXt'].includes(s.kind)) return false
    const payload = bytes.subarray(s.from + 8, s.to - 4), end = payload.indexOf(0)
    const keyword = new TextDecoder().decode(payload.subarray(0, end < 0 ? payload.length : end))
    return /^(XML:com\.adobe\.xmp|raw profile type (exif|iptc|xmp|icc))$/i.test(keyword)
  })) throw new Error('该图片含 EXIF、XMP、ICC 或 IPTC，不能安全原样保留；请勾选去除元数据。原始字节仍保留在快照与基准源。')
  return list.filter(s => mime === 'image/png' ? ['tEXt', 'zTXt', 'iTXt'].includes(s.kind) : s.kind === 'fe').map(s => bytes.slice(s.from, s.to))
}
export function removePrivateMetadata(bytes: Uint8Array, mime: string): Uint8Array {
  const list = segments(bytes, mime), remove = list.filter(s => mime === 'image/png' ? !['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM'].includes(s.kind) : (parseInt(s.kind, 16) >= 0xe1 && parseInt(s.kind, 16) <= 0xef && s.kind !== 'ee') || s.kind === 'fe')
  const parts: Uint8Array[] = []; let cursor = 0
  for (const segment of remove) { parts.push(bytes.slice(cursor, segment.from)); cursor = segment.to }
  parts.push(bytes.slice(cursor)); return joinBytes(parts)
}
export function joinBytes(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let offset = 0
  for (const part of parts) { result.set(part, offset); offset += part.length }
  return result
}
export function attachDescriptions(bytes: Uint8Array, mime: string, descriptions: Uint8Array[]): Uint8Array {
  const offset = mime === 'image/png' ? segments(bytes, mime).find(s => s.kind === 'IDAT')?.from : 2
  if (offset === undefined) throw new Error('编码图片无效。')
  return joinBytes([bytes.slice(0, offset), ...descriptions, bytes.slice(offset)])
}
