import { expect, it } from 'vitest'
import { decodeFile, encodeFile } from './codec'

it.each(['---\r\ntitle: 测试\r\n---\r\n<!-- comment -->\n[ref]: ./photo.png\n', '\uFEFF# 标题\r\n\r\n未知 ::: 语法 😀\r\n'])('preserves original bytes on an untouched round trip', (raw) => {
  const bytes = new TextEncoder().encode(raw)
  const file = decodeFile(bytes)
  expect(encodeFile(file, file.text)).toEqual(bytes)
})

it('retains BOM and CRLF after editing', () => {
  const file = decodeFile(new TextEncoder().encode('\uFEFFone\r\ntwo'))
  expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(encodeFile(file, 'one\ntwo\nthree'))).toBe('\uFEFFone\r\ntwo\r\nthree')
})

it('requires an explicit mixed newline decision before modifying a file', () => {
  const file = decodeFile(new TextEncoder().encode('one\r\ntwo\n'))
  expect(() => encodeFile(file, 'three')).toThrow('mixed_line_endings')
  expect(new TextDecoder().decode(encodeFile(file, 'three', 'lf'))).toBe('three')
})

it('rejects invalid UTF-8 without replacement characters', () => {
  expect(() => decodeFile(new Uint8Array([0xff]))).toThrow()
})
