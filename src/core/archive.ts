// A small ZIP writer using STORE (no compression). Images are already compressed.
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function zipArchive(files: ReadonlyArray<{ path: string; bytes: Uint8Array }>): Uint8Array {
  if (files.length > 65535) throw new Error('Too many archive entries')
  const encoder = new TextEncoder()
  const entries = files.map((file) => {
    if (!file.path || file.path.startsWith('/') || file.path.includes('\\') || file.path.split('/').some((part) => part === '..' || part === '.' || part === '') || /[\x00-\x1f:]/.test(file.path)) throw new Error('Unsafe archive path')
    return { ...file, name: encoder.encode(file.path), crc: crc32(file.bytes), offset: 0 }
  })
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) throw new Error('Duplicate archive path')
  const bodySize = entries.reduce((sum, e) => sum + 30 + e.name.length + e.bytes.length, 0)
  const directorySize = entries.reduce((sum, e) => sum + 46 + e.name.length, 0)
  const output = new Uint8Array(bodySize + directorySize + 22)
  const view = new DataView(output.buffer)
  let pos = 0
  for (const e of entries) {
    e.offset = pos
    view.setUint32(pos, 0x04034b50, true); view.setUint16(pos + 4, 20, true); view.setUint16(pos + 6, 0x800, true)
    view.setUint16(pos + 12, 33, true) // 1980-01-01
    view.setUint32(pos + 14, e.crc, true); view.setUint32(pos + 18, e.bytes.length, true); view.setUint32(pos + 22, e.bytes.length, true); view.setUint16(pos + 26, e.name.length, true)
    output.set(e.name, pos + 30); output.set(e.bytes, pos + 30 + e.name.length)
    pos += 30 + e.name.length + e.bytes.length
  }
  for (const e of entries) {
    view.setUint32(pos, 0x02014b50, true); view.setUint16(pos + 4, 20, true); view.setUint16(pos + 6, 20, true); view.setUint16(pos + 8, 0x800, true)
    view.setUint16(pos + 14, 33, true); view.setUint32(pos + 16, e.crc, true); view.setUint32(pos + 20, e.bytes.length, true); view.setUint32(pos + 24, e.bytes.length, true); view.setUint16(pos + 28, e.name.length, true); view.setUint32(pos + 42, e.offset, true)
    output.set(e.name, pos + 46); pos += 46 + e.name.length
  }
  view.setUint32(pos, 0x06054b50, true); view.setUint16(pos + 8, entries.length, true); view.setUint16(pos + 10, entries.length, true); view.setUint32(pos + 12, directorySize, true); view.setUint32(pos + 16, bodySize, true)
  return output
}
