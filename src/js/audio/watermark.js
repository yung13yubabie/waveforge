/**
 * Basic spread-spectrum audio watermark.
 *
 * Embeds an inaudible, payload-derived pseudo-noise (PN) signal into the audio
 * at a low, RMS-scaled amplitude. Detection correlates the suspect audio
 * against the same PN sequence and reports a self-calibrated confidence
 * (z-score vs random payloads), so it does NOT depend on knowing the exact
 * embed strength.
 *
 * HONEST LIMITS: this proves file provenance and survives mild changes
 * (transcode, volume, light EQ). It does NOT survive pitch/tempo shifting,
 * heavy spectral destruction, or AI re-creation — no watermark does. It is a
 * deterrent + evidence layer, not military-grade.
 */

const FRAME = 4096

// FNV-1a string hash → 32-bit seed
function hashSeed(str) {
  let h = 2166136261 >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// mulberry32 deterministic PRNG
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ±1 PN sequence of length n, deterministic per payload
function pnSequence(payload, n) {
  const rng = mulberry32(hashSeed(payload))
  const pn = new Float32Array(n)
  for (let i = 0; i < n; i++) pn[i] = rng() < 0.5 ? -1 : 1
  return pn
}

/**
 * Embed a watermark. Returns NEW channel arrays (original untouched).
 * @param {Float32Array[]} channels
 * @param {number} sampleRate (unused today; kept for API stability)
 * @param {string} payload - user watermark id (name / ISRC / anything)
 * @param {{strength?: number}} opts - amplitude relative to per-frame RMS
 * @returns {Float32Array[]}
 */
export function embedWatermark(channels, sampleRate, payload, { strength = 0.02 } = {}) {
  if (!payload) throw new Error('watermark payload required')
  const pn = pnSequence(payload, FRAME)
  return channels.map((ch) => {
    const out = new Float32Array(ch.length)
    for (let start = 0; start < ch.length; start += FRAME) {
      const end = Math.min(start + FRAME, ch.length)
      let sumSq = 0
      for (let i = start; i < end; i++) sumSq += ch[i] * ch[i]
      const rms = Math.sqrt(sumSq / (end - start)) || 0
      const amp = strength * rms
      for (let i = start; i < end; i++) {
        out[i] = Math.max(-1, Math.min(1, ch[i] + amp * pn[i - start]))
      }
    }
    return out
  })
}

// Raw normalized correlation of channels against a payload's PN
function rawCorrelation(channels, payload) {
  const pn = pnSequence(payload, FRAME)
  let corrSum = 0
  let frames = 0
  for (const ch of channels) {
    for (let start = 0; start + FRAME <= ch.length; start += FRAME) {
      let dot = 0
      let sumSq = 0
      for (let i = 0; i < FRAME; i++) {
        const s = ch[start + i]
        dot += s * pn[i]
        sumSq += s * s
      }
      const rms = Math.sqrt(sumSq / FRAME) || 1e-9
      corrSum += dot / FRAME / rms
      frames++
    }
  }
  return frames ? corrSum / frames : 0
}

/**
 * Detect a watermark. Self-calibrated: compares the payload correlation to the
 * distribution of correlations from random payloads (z-score), so no knowledge
 * of embed strength is needed.
 * @returns {{confidence: number, z: number}} confidence in 0..1
 */
export function detectWatermark(channels, sampleRate, payload) {
  if (!payload) throw new Error('watermark payload required')
  const target = Math.abs(rawCorrelation(channels, payload))

  // Baseline distribution from random (wrong) payloads
  const samples = []
  for (let k = 0; k < 12; k++) samples.push(Math.abs(rawCorrelation(channels, `__wm_baseline_${k}__`)))
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length
  const std = Math.sqrt(variance) || 1e-9

  const z = (target - mean) / std
  // z ≈ 0 → absent; z ≥ 8 → confidently present
  const confidence = Math.max(0, Math.min(1, z / 8))
  return { confidence, z }
}
