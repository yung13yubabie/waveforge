// Linear-phase EQ: turn a magnitude response into a symmetric (linear-phase)
// FIR, then convolve. Applied at EXPORT for a phase-coherent master; realtime
// preview uses the minimum-phase biquad EQ (low latency). Pure + testable.
import { fft, fftConvolve } from './fft.js'

/**
 * Build a windowed linear-phase FIR from a half-spectrum magnitude response.
 * @param {Float32Array|number[]} mag  magnitude at DC..Nyquist (length N/2+1)
 * @param {number} N  FIR length (power of two)
 * @returns {Float32Array} symmetric FIR, peak at index N/2 (delay = N/2)
 */
export function designLinearPhaseFIR(mag, N) {
  const re = new Float64Array(N), im = new Float64Array(N)
  const half = N >> 1
  for (let k = 0; k <= half; k++) re[k] = mag[k]
  for (let k = half + 1; k < N; k++) re[k] = mag[N - k]  // Hermitian mirror (zero phase)
  fft(re, im, true)                                       // → real zero-phase impulse (peak at 0)

  const fir = new Float32Array(N)
  for (let k = 0; k < N; k++) {
    const src = (k + half) % N                            // fftshift: peak 0 → centre N/2
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / N)  // periodic Hann (symmetric about N/2)
    fir[k] = re[src] * win
  }
  return fir
}

/**
 * Apply a linear-phase EQ (from a magnitude response) to channel data.
 * Output is delay-compensated to the same length/alignment as the input.
 * @param {Float32Array[]} channels
 * @param {Float32Array|number[]} mag  half-spectrum magnitude (length N/2+1)
 * @param {number} N  FIR length (power of two), default 4096
 * @returns {Float32Array[]}
 */
export function applyLinearPhaseEQ(channels, mag, N = 4096) {
  const fir = designLinearPhaseFIR(mag, N)
  const delay = N >> 1
  return channels.map(x => {
    const conv = fftConvolve(x, fir)        // length x.length + N - 1
    const out = new Float32Array(x.length)
    for (let i = 0; i < x.length; i++) out[i] = conv[i + delay] ?? 0
    return out
  })
}
