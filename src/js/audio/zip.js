// Minimal store-only (no compression) ZIP writer — packages the CUE + WAV image
// + checksum into one download. Store method keeps it simple, valid, and fast;
// audio doesn't compress meaningfully anyway. Pure + testable.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(bytes) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

/**
 * @param {{ name: string, data: Uint8Array }[]} files
 * @returns {Uint8Array} a complete .zip archive (store method)
 */
export function createZip(files) {
  const enc = new TextEncoder()
  const local = []     // local header + data chunks
  const central = []   // central directory records
  let offset = 0

  for (const f of files) {
    const name = enc.encode(f.name)
    const data = f.data
    const crc = crc32(data)

    const lh = new Uint8Array(30 + name.length)
    const ld = new DataView(lh.buffer)
    ld.setUint32(0, 0x04034b50, true)   // local file header signature
    ld.setUint16(4, 20, true)           // version needed
    ld.setUint16(6, 0, true)            // flags
    ld.setUint16(8, 0, true)            // method = 0 (store)
    ld.setUint16(10, 0, true)           // mod time
    ld.setUint16(12, 0x21, true)        // mod date = 1980-01-01
    ld.setUint32(14, crc, true)
    ld.setUint32(18, data.length, true) // compressed size
    ld.setUint32(22, data.length, true) // uncompressed size
    ld.setUint16(26, name.length, true)
    ld.setUint16(28, 0, true)           // extra length
    lh.set(name, 30)
    local.push(lh, data)

    const cd = new Uint8Array(46 + name.length)
    const cv = new DataView(cd.buffer)
    cv.setUint32(0, 0x02014b50, true)   // central directory signature
    cv.setUint16(4, 20, true)           // version made by
    cv.setUint16(6, 20, true)           // version needed
    cv.setUint16(8, 0, true)
    cv.setUint16(10, 0, true)           // method
    cv.setUint16(12, 0, true)
    cv.setUint16(14, 0x21, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint16(30, 0, true)           // extra
    cv.setUint16(32, 0, true)           // comment
    cv.setUint16(34, 0, true)           // disk number
    cv.setUint16(36, 0, true)           // internal attrs
    cv.setUint32(38, 0, true)           // external attrs
    cv.setUint32(42, offset, true)      // offset of local header
    cd.set(name, 46)
    central.push(cd)

    offset += lh.length + data.length
  }

  const centralSize = central.reduce((a, c) => a + c.length, 0)
  const centralOffset = offset

  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)     // end of central directory signature
  ev.setUint16(8, files.length, true)   // entries on this disk
  ev.setUint16(10, files.length, true)  // total entries
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, centralOffset, true)
  ev.setUint16(20, 0, true)             // comment length

  const total = offset + centralSize + 22
  const out = new Uint8Array(total)
  let pos = 0
  for (const c of local)   { out.set(c, pos); pos += c.length }
  for (const c of central) { out.set(c, pos); pos += c.length }
  out.set(eocd, pos)
  return out
}
