// CUE sheet generation for a single-file CD-DA image (CUE + WAV). This is the
// open, widely-accepted CD master interchange (ImgBurn, Nero, most duplicators,
// many plants). NOT the proprietary DDP 2.00 descriptor set — that needs DCA's
// non-public spec, so we don't fake it.

// CD frame = 1/75 s. Convert an absolute frame index to CUE "MM:SS:FF".
export function framesToMSF(frames) {
  const f = Math.max(0, Math.round(frames))
  const ff = f % 75
  const totalSec = Math.floor(f / 75)
  const ss = totalSec % 60
  const mm = Math.floor(totalSec / 60)
  const p2 = n => String(n).padStart(2, '0')
  return `${p2(mm)}:${p2(ss)}:${p2(ff)}`
}

function cueQuote(s) {
  // CUE strings are double-quoted; strip embedded quotes/newlines defensively.
  return String(s ?? '').replace(/["\r\n]/g, '').slice(0, 80)
}

// ISRC in CUE is 12 alphanumerics, no dashes (e.g. "USABC2500001").
function normIsrc(isrc) {
  const s = String(isrc ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  return s.length === 12 ? s : ''
}

/**
 * @param {object} o
 * @param {string} o.imageFile   referenced WAV filename
 * @param {{index,startFrame,isrc,title}[]} o.markers  from assembleAlbum
 * @param {string} [o.albumTitle]
 * @param {string} [o.performer]
 * @param {string} [o.upc]        13-digit catalog/UPC-EAN (optional)
 * @returns {string} CUE sheet text
 */
export function generateCue({ imageFile, markers, albumTitle, performer, upc }) {
  const lines = []
  const upcDigits = String(upc ?? '').replace(/\D/g, '')
  if (upcDigits.length === 12 || upcDigits.length === 13) lines.push(`CATALOG ${upcDigits.padStart(13, '0')}`)
  if (performer) lines.push(`PERFORMER "${cueQuote(performer)}"`)
  if (albumTitle) lines.push(`TITLE "${cueQuote(albumTitle)}"`)
  lines.push(`FILE "${cueQuote(imageFile)}" WAVE`)

  for (const m of markers) {
    lines.push(`  TRACK ${String(m.index).padStart(2, '0')} AUDIO`)
    if (m.title) lines.push(`    TITLE "${cueQuote(m.title)}"`)
    if (performer) lines.push(`    PERFORMER "${cueQuote(performer)}"`)
    const isrc = normIsrc(m.isrc)
    if (isrc) lines.push(`    ISRC ${isrc}`)
    lines.push(`    INDEX 01 ${framesToMSF(m.startFrame)}`)
  }
  return lines.join('\n') + '\n'
}
