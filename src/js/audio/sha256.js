/**
 * SHA-256 of an ArrayBuffer → lowercase hex string.
 * Used to fingerprint the user's ORIGINAL file for a takedown evidence report
 * (proof they hold the source recording). Uses Web Crypto (browser + Node 16+).
 * @param {ArrayBuffer} buffer
 * @returns {Promise<string>}
 */
export async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}
