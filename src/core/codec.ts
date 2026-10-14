import { detectLineEnding, type LineEnding } from './document'

export interface FileSnapshot {
  text: string
  originalBytes: Uint8Array
  originalText: string
  encoding: 'utf-8' | 'utf-8-bom'
  lineEnding: LineEnding
}

export function decodeFile(bytes: Uint8Array): FileSnapshot {
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? bytes.slice(3) : bytes)
  if (raw.includes('\0')) throw new Error('不支持二进制文件或 UTF-16；请先转换为 UTF-8。')
  const text = raw.replace(/\r\n/g, '\n')
  return { text, originalText: text, originalBytes: bytes.slice(), encoding: bom ? 'utf-8-bom' : 'utf-8', lineEnding: detectLineEnding(raw) }
}

export function encodeFile(snapshot: FileSnapshot, text: string, mixedPolicy?: 'lf'): Uint8Array {
  if (text === snapshot.originalText) return snapshot.originalBytes.slice()
  if (snapshot.lineEnding === 'mixed' && mixedPolicy !== 'lf') throw new Error('mixed_line_endings')
  const normalized = snapshot.lineEnding === 'crlf' ? text.replace(/\n/g, '\r\n') : text
  return new TextEncoder().encode((snapshot.encoding === 'utf-8-bom' ? '\uFEFF' : '') + normalized)
}

export const blankSnapshot = (): FileSnapshot => decodeFile(new Uint8Array())
