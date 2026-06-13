import { describe, it, expect } from 'vitest'
import { crc32, createZip } from '../../src/js/audio/zip.js'
import { md5 } from '../../src/js/audio/md5.js'

const enc = new TextEncoder()

describe('crc32', () => {
  it('matches the standard check value for "123456789"', () => {
    expect(crc32(enc.encode('123456789')) >>> 0).toBe(0xCBF43926)
  })
  it('empty input → 0', () => {
    expect(crc32(new Uint8Array(0))).toBe(0)
  })
})

describe('createZip', () => {
  it('starts with a local file header signature', () => {
    const zip = createZip([{ name: 'a.txt', data: enc.encode('hello') }])
    const dv = new DataView(zip.buffer)
    expect(dv.getUint32(0, true)).toBe(0x04034b50)
  })

  it('ends with an EOCD record with the right entry count', () => {
    const zip = createZip([
      { name: 'a.txt', data: enc.encode('hello') },
      { name: 'b.bin', data: new Uint8Array([1, 2, 3, 4]) },
    ])
    const dv = new DataView(zip.buffer)
    // EOCD is the last 22 bytes
    const eocdOff = zip.length - 22
    expect(dv.getUint32(eocdOff, true)).toBe(0x06054b50)
    expect(dv.getUint16(eocdOff + 10, true)).toBe(2)  // total entries
  })

  it('stores the file name and raw data (store method, recoverable)', () => {
    const data = enc.encode('PAYLOAD')
    const zip = createZip([{ name: 'x.txt', data }])
    const text = new TextDecoder().decode(zip)
    expect(text).toContain('x.txt')
    expect(text).toContain('PAYLOAD')   // store method → data is verbatim
    // local header records uncompressed size == data length at offset 22
    const dv = new DataView(zip.buffer)
    expect(dv.getUint32(22, true)).toBe(data.length)
    expect(dv.getUint16(8, true)).toBe(0)  // method = store
  })

  it('records a correct CRC32 in the local header', () => {
    const data = enc.encode('check me')
    const zip = createZip([{ name: 'c', data }])
    const dv = new DataView(zip.buffer)
    expect(dv.getUint32(14, true) >>> 0).toBe(crc32(data))
  })
})

describe('md5 (RFC 1321 test vectors)', () => {
  const v = s => md5(enc.encode(s))
  it('empty string', () => expect(v('')).toBe('d41d8cd98f00b204e9800998ecf8427e'))
  it('"a"', () => expect(v('a')).toBe('0cc175b9c0f1b6a831c399e269772661'))
  it('"abc"', () => expect(v('abc')).toBe('900150983cd24fb0d6963f7d28e17f72'))
  it('"message digest"', () => expect(v('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0'))
  it('alphabet', () => expect(v('abcdefghijklmnopqrstuvwxyz')).toBe('c3fcd3d76192e4007dfb496cca67e13b'))
  it('long digits', () =>
    expect(v('12345678901234567890123456789012345678901234567890123456789012345678901234567890'))
      .toBe('57edf4a22be3c955ac49da2e2107b67a'))
})
