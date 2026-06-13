// Pure, testable helpers for the scrolling spectrogram (time-frequency
// waterfall). The renderer (ui/spectrogram.js) reads an AnalyserNode each frame
// and uses these to colour magnitudes and place them on a log-frequency axis.

// Heat colour map (black → magenta → red → orange → white) keyed to a dB range.
// Monotonic luminance so louder = brighter — readable as an intensity ramp.
const STOPS = [
  { t: 0.00, r: 4,   g: 4,   b: 14 },   // floor: near-black
  { t: 0.30, r: 60,  g: 12,  b: 80 },   // deep violet
  { t: 0.55, r: 158, g: 18,  b: 86 },   // magenta
  { t: 0.75, r: 232, g: 40,  b: 60 },   // red (brand)
  { t: 0.90, r: 255, g: 150, b: 40 },   // orange
  { t: 1.00, r: 255, g: 248, b: 220 },  // hot white
]

function lerp(a, b, t) { return Math.round(a + (b - a) * t) }

/**
 * @param {number} db  magnitude in dBFS (−Infinity = silence)
 * @param {{floor?:number, ceil?:number}} [opt]
 * @returns {{r:number,g:number,b:number}}
 */
export function magnitudeToColor(db, opt = {}) {
  const floor = opt.floor ?? -90
  const ceil = opt.ceil ?? -10
  let t = Number.isFinite(db) ? (db - floor) / (ceil - floor) : 0
  if (t <= 0) return { r: STOPS[0].r, g: STOPS[0].g, b: STOPS[0].b }
  if (t >= 1) { const s = STOPS[STOPS.length - 1]; return { r: s.r, g: s.g, b: s.b } }
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i].t) {
      const a = STOPS[i - 1], c = STOPS[i]
      const k = (t - a.t) / (c.t - a.t)
      return { r: lerp(a.r, c.r, k), g: lerp(a.g, c.g, k), b: lerp(a.b, c.b, k) }
    }
  }
  const s = STOPS[STOPS.length - 1]
  return { r: s.r, g: s.g, b: s.b }
}

/**
 * Precompute, for each canvas row (0 = top = high freq), which FFT bin to read,
 * giving a log-frequency vertical axis.
 * @param {number} numBins  analyser.frequencyBinCount
 * @param {number} binHz     Hz per bin (sampleRate / fftSize)
 * @param {number} height    canvas height in pixels
 * @param {number} [fMin=20]
 * @param {number} [fMax=20000]
 * @returns {Int32Array} length === height
 */
export function buildRowToBin(numBins, binHz, height, fMin = 20, fMax = 20000) {
  const map = new Int32Array(height)
  const logMin = Math.log10(fMin)
  const logMax = Math.log10(Math.min(fMax, (numBins - 1) * binHz))
  for (let y = 0; y < height; y++) {
    // y = 0 → top → fMax ; y = height-1 → bottom → fMin
    const frac = 1 - y / Math.max(1, height - 1)
    const freq = Math.pow(10, logMin + frac * (logMax - logMin))
    let bin = Math.round(freq / binHz)
    if (bin < 0) bin = 0
    if (bin > numBins - 1) bin = numBins - 1
    map[y] = bin
  }
  return map
}
