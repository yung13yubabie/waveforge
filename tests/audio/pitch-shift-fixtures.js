// Deterministic, generated-only DSP fixtures. No recordings, models, or uploads.
export function tone(sampleRate, seconds, frequency = 220, amplitude = 0.3, phase = 0) {
  return Float32Array.from({ length: Math.round(sampleRate * seconds) }, (_, i) =>
    amplitude * Math.sin(2 * Math.PI * frequency * i / sampleRate + phase))
}

export function chirp(sampleRate, seconds, initial = 180, slope = 60) {
  return Float32Array.from({ length: Math.round(sampleRate * seconds) }, (_, i) => {
    const t = i / sampleRate
    return 0.3 * Math.sin(2 * Math.PI * (initial * t + slope * t * t / 2))
  })
}

export function noise(sampleRate, seconds, amplitude = 0.15, seed = 42) {
  let state = seed >>> 0
  return Float32Array.from({ length: Math.round(sampleRate * seconds) }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return amplitude * (state / 2147483648 - 1)
  })
}

// Source-filter-like harmonic mixture with three deliberately synthetic formant
// bands. It can exercise harmonic preservation but is not a human vocal corpus.
export function vowel(sampleRate, seconds, frequency = 180) {
  const amplitudes = Array.from({ length: 28 }, (_, i) => {
    const harmonic = i + 1, hz = harmonic * frequency
    const formants = [[700, 120, 1], [1200, 160, 0.7], [2600, 250, 0.35]]
    return (0.15 + formants.reduce((sum, [center, width, level]) =>
      sum + level * Math.exp(-0.5 * ((hz - center) / width) ** 2), 0)) / harmonic
  })
  const x = Float32Array.from({ length: Math.round(sampleRate * seconds) }, (_, i) => {
    const phase = 2 * Math.PI * frequency * i / sampleRate
    return amplitudes.reduce((sum, amplitude, index) => sum + amplitude * Math.sin((index + 1) * phase), 0)
  })
  let peak = 0
  for (const value of x) peak = Math.max(peak, Math.abs(value))
  return x.map(value => 0.5 * value / peak)
}

export function rms(x, start = 0, end = x.length) {
  let sum = 0
  for (let i = start; i < end; i++) sum += x[i] ** 2
  return Math.sqrt(sum / Math.max(1, end - start))
}

export function peak(x) {
  let result = 0
  for (const value of x) result = Math.max(result, Math.abs(value))
  return result
}

export function crossingFrequency(x, sampleRate, startSeconds = 0.2, endSeconds = 0.8) {
  const crossings = []
  for (let i = Math.max(1, Math.floor(sampleRate * startSeconds)); i < Math.min(x.length, sampleRate * endSeconds); i++) {
    if (x[i - 1] < 0 && x[i] >= 0) crossings.push(i - x[i] / (x[i] - x[i - 1]))
  }
  if (crossings.length < 3) throw new Error('Insufficient crossings to measure frequency')
  return sampleRate * (crossings.length - 1) / (crossings.at(-1) - crossings[0])
}

// Independent normalized time-domain periodicity measurement, constrained only
// to the intended fundamental neighborhood to avoid subharmonic ambiguity.
export function periodicFrequency(x, sampleRate, centerSeconds, expectedHz) {
  const start = Math.floor((centerSeconds - 0.06) * sampleRate)
  const count = Math.floor(0.12 * sampleRate)
  const low = Math.floor(sampleRate / (expectedHz * 1.2))
  const high = Math.ceil(sampleRate / (expectedHz * 0.8))
  const values = new Float64Array(high + 2)
  for (let lag = low - 1; lag <= high + 1; lag++) {
    let numerator = 0, denominatorA = 0, denominatorB = 0
    for (let j = start; j < start + count; j++) {
      const a = x[j], b = x[j + lag]
      numerator += a * b
      denominatorA += a * a
      denominatorB += b * b
    }
    values[lag] = numerator / Math.sqrt(denominatorA * denominatorB + 1e-30)
  }
  let lag = low
  for (let k = low + 1; k <= high; k++) if (values[k] > values[lag]) lag = k
  const offset = 0.5 * (values[lag - 1] - values[lag + 1])
    / (values[lag - 1] - 2 * values[lag] + values[lag + 1])
  return { frequency: sampleRate / (lag + offset), correlation: values[lag] }
}

export const centsError = (actual, expected) => 1200 * Math.log2(actual / expected)
