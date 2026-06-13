// MD5 (RFC 1321) — needed for the DDP/CD-master CHECKSUM file. WebCrypto's
// subtle.digest does NOT support MD5, so a pure implementation is required.
// Verified against the RFC 1321 test-suite vectors. Pure + testable.

function add32(a, b) { return (a + b) & 0xFFFFFFFF }
function rol(x, c) { return (x << c) | (x >>> (32 - c)) }

export function md5(bytes) {
  const msgLenBits = bytes.length * 8
  // pad: append 0x80, then zeros to 56 mod 64, then 64-bit little-endian length
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) * 64)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const dv = new DataView(padded.buffer)
  dv.setUint32(padded.length - 8, msgLenBits >>> 0, true)
  dv.setUint32(padded.length - 4, Math.floor(msgLenBits / 0x100000000), true)

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476

  const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
             5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
             4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
             6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21]
  const K = new Uint32Array(64)
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0

  const M = new Uint32Array(16)
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true)
    let A = a0, B = b0, C = c0, D = d0
    for (let i = 0; i < 64; i++) {
      let F, g
      if (i < 16)      { F = (B & C) | (~B & D);        g = i }
      else if (i < 32) { F = (D & B) | (~D & C);        g = (5 * i + 1) & 15 }
      else if (i < 48) { F = B ^ C ^ D;                 g = (3 * i + 5) & 15 }
      else             { F = C ^ (B | (~D & 0xFFFFFFFF)); g = (7 * i) & 15 }
      F = add32(add32(add32(F, A), K[i]), M[g])
      A = D; D = C; C = B
      B = add32(B, rol(F, S[i]))
    }
    a0 = add32(a0, A); b0 = add32(b0, B); c0 = add32(c0, C); d0 = add32(d0, D)
  }

  const hex = n => {
    let s = ''
    for (let i = 0; i < 4; i++) s += ((n >>> (i * 8)) & 0xFF).toString(16).padStart(2, '0')
    return s
  }
  return hex(a0) + hex(b0) + hex(c0) + hex(d0)
}
