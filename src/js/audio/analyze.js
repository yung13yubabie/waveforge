// Client-side BPM and musical Key detection — no backend required.
// BPM: energy-onset autocorrelation with harmonic reinforcement.
// Key: Goertzel pitch class profile + Krumhansl-Schmuckler correlation.
// Both functions return a confidence score [0-1]; low confidence = ambiguous signal.

// Krumhansl-Schmuckler probe tone ratings (normalised, not rounded)
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function pearson(a, b) {
  const n = a.length
  let sA = 0, sB = 0
  for (let i = 0; i < n; i++) { sA += a[i]; sB += b[i] }
  const mA = sA / n, mB = sB / n
  let num = 0, da2 = 0, db2 = 0
  for (let i = 0; i < n; i++) {
    const da = a[i] - mA, db = b[i] - mB
    num += da * db; da2 += da * da; db2 += db * db
  }
  const den = Math.sqrt(da2 * db2)
  return den < 1e-10 ? 0 : num / den
}

function monoMix(audioBuffer, maxLen) {
  const N    = Math.min(audioBuffer.length, maxLen)
  const mono = new Float32Array(N)
  const l    = audioBuffer.getChannelData(0)
  if (audioBuffer.numberOfChannels >= 2) {
    const r = audioBuffer.getChannelData(1)
    for (let i = 0; i < N; i++) mono[i] = (l[i] + r[i]) * 0.5
  } else {
    mono.set(l.subarray(0, N))
  }
  return mono
}

/**
 * Estimate tempo via energy-onset autocorrelation.
 * @param  {AudioBuffer} audioBuffer
 * @returns {{ bpm: number|null, confidence: number }}
 */
export function detectBPM(audioBuffer) {
  const sr   = audioBuffer.sampleRate
  const mono = monoMix(audioBuffer, sr * 45)
  const N    = mono.length

  // Frame energy (hop = 512 samples ≈ 10.7 ms at 48kHz)
  const HOP    = 512
  const frames = Math.floor(N / HOP)
  if (frames < 64) return { bpm: null, confidence: 0 }

  const energy = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    let s = 0
    const base = f * HOP
    for (let i = 0; i < HOP; i++) { const v = mono[base + i]; s += v * v }
    energy[f] = s / HOP
  }

  // Half-wave rectified first-difference → onset strength
  const onset = new Float32Array(frames)
  for (let f = 1; f < frames; f++) {
    const d = energy[f] - energy[f - 1]
    onset[f] = d > 0 ? d : 0
  }

  // Autocorrelation within 50–210 BPM range
  const FPS  = sr / HOP                              // frames per second
  const minL = Math.max(1, Math.floor(FPS * 60 / 210))
  const maxL = Math.floor(FPS * 60 / 50)
  const ac   = new Float32Array(maxL + 1)

  for (let lag = minL; lag <= maxL; lag++) {
    let s = 0
    const n = frames - lag
    for (let f = 0; f < n; f++) s += onset[f] * onset[f + lag]
    ac[lag] = s / n
  }

  // Score each lag: base autocorrelation + harmonic bonuses
  let bestLag = minL, bestScore = -Infinity
  for (let lag = minL; lag <= maxL; lag++) {
    let score = ac[lag]
    const half   = Math.round(lag / 2)
    const double = lag * 2
    if (half >= minL)    score += ac[half] * 0.2
    if (double <= maxL)  score += ac[double] * 0.3
    if (score > bestScore) { bestScore = score; bestLag = lag }
  }

  const bpm = FPS * 60 / bestLag

  // Confidence: peak-to-mean ratio of the RAW AC at the chosen lag.
  // bestLag was selected with harmonic bonuses, so this may understate
  // confidence slightly — conservative on purpose (never overstate).
  let acSum = 0
  for (let lag = minL; lag <= maxL; lag++) acSum += ac[lag]
  const acMean = acSum / (maxL - minL + 1)
  const confidence = acMean > 1e-12
    ? Math.min(1, Math.max(0, (ac[bestLag] / acMean - 1) / 3))
    : 0

  if (confidence < 0.05) return { bpm: null, confidence: 0 }
  return { bpm: Math.round(bpm * 2) / 2, confidence }
}

/**
 * Estimate musical key via Goertzel pitch-class profiling + K-S correlation.
 * @param  {AudioBuffer} audioBuffer
 * @returns {{ key: string|null, scale: string|null, confidence: number }}
 */
export function detectKey(audioBuffer) {
  const sr   = audioBuffer.sampleRate
  const mono = monoMix(audioBuffer, sr * 30)
  const N    = mono.length

  // Hann window coefficients (pre-computed once per FRAME size)
  const FRAME = 4096
  if (N < FRAME) return { key: null, scale: null, confidence: 0 }

  const hann = new Float32Array(FRAME)
  for (let k = 0; k < FRAME; k++) hann[k] = 0.5 * (1 - Math.cos(2 * Math.PI * k / (FRAME - 1)))

  // Pitch-class profile (PCP): 12 bins, summed across octaves 3–5
  const pcp = new Float32Array(12)
  let framesDone = 0

  for (let start = 0; start + FRAME <= N; start += FRAME * 4) {
    for (let note = 0; note < 12; note++) {
      for (let oct = 3; oct <= 5; oct++) {
        const hz    = 440 * Math.pow(2, (oct * 12 + note - 69) / 12)
        if (hz < 80 || hz >= sr / 2) continue

        // Goertzel DFT magnitude at frequency hz: ω = 2πk/N, k = hz·N/sr
        const omegaG = 2 * Math.PI * (hz * FRAME / sr) / FRAME
        const coeffG = 2 * Math.cos(omegaG)
        let s0 = 0, s1 = 0, s2 = 0
        for (let i = 0; i < FRAME; i++) {
          s0 = mono[start + i] * hann[i] + coeffG * s1 - s2
          s2 = s1; s1 = s0
        }
        const re = s1 - s2 * Math.cos(omegaG)
        const im = s2 * Math.sin(omegaG)
        pcp[note] += re * re + im * im
      }
    }
    if (++framesDone >= 8) break
  }

  // Normalize PCP to unit sum
  const pcpSum = pcp.reduce((s, v) => s + v, 0)
  if (pcpSum < 1e-10) return { key: null, scale: null, confidence: 0 }
  const pcpNorm = Array.from(pcp).map(v => v / pcpSum)

  // Correlate against all 24 keys (12 major + 12 minor) via rotation
  let bestCorr = -Infinity, bestKey = 0, bestScale = 'major'
  for (let root = 0; root < 12; root++) {
    const rotated = Array.from({ length: 12 }, (_, i) => pcpNorm[(i + root) % 12])
    const cMaj = pearson(rotated, MAJOR)
    const cMin = pearson(rotated, MINOR)
    if (cMaj > bestCorr) { bestCorr = cMaj; bestKey = root; bestScale = 'major' }
    if (cMin > bestCorr) { bestCorr = cMin; bestKey = root; bestScale = 'minor' }
  }

  // Map Pearson [-1, 1] to confidence [0, 1]; typical good detection: 0.5–0.9
  const confidence = Math.max(0, Math.min(1, (bestCorr + 0.1) / 1.1))
  if (confidence < 0.1) return { key: null, scale: null, confidence }

  return {
    key:   NOTE_NAMES[bestKey],
    scale: bestScale === 'major' ? '大調' : '小調',
    confidence,
  }
}
