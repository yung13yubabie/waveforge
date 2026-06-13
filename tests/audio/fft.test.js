import { describe, it, expect } from 'vitest'
import { fft, nextPow2, fftConvolve } from '../../src/js/audio/fft.js'

describe('fft', () => {
  it('rejects non-power-of-2 lengths', () => {
    expect(() => fft(new Float64Array(3), new Float64Array(3))).toThrow()
  })

  it('FFT of a delta is flat (all ones)', () => {
    const re = new Float64Array(8), im = new Float64Array(8)
    re[0] = 1
    fft(re, im)
    for (let i = 0; i < 8; i++) {
      expect(re[i]).toBeCloseTo(1, 9)
      expect(im[i]).toBeCloseTo(0, 9)
    }
  })

  it('forward then inverse recovers the original signal', () => {
    const N = 16
    const orig = Array.from({ length: N }, (_, i) => Math.sin(i) + 0.5 * Math.cos(2 * i))
    const re = Float64Array.from(orig), im = new Float64Array(N)
    fft(re, im)
    fft(re, im, true)
    for (let i = 0; i < N; i++) expect(re[i]).toBeCloseTo(orig[i], 9)
  })

  it('puts a pure cosine energy at its bin', () => {
    const N = 16, bin = 2
    const re = new Float64Array(N), im = new Float64Array(N)
    for (let i = 0; i < N; i++) re[i] = Math.cos(2 * Math.PI * bin * i / N)
    fft(re, im)
    const mag = i => Math.hypot(re[i], im[i])
    expect(mag(bin)).toBeGreaterThan(N / 2 - 0.01)   // ≈ N/2
    expect(mag(1)).toBeLessThan(0.01)
    expect(mag(3)).toBeLessThan(0.01)
  })
})

describe('nextPow2', () => {
  it('rounds up to the next power of two', () => {
    expect(nextPow2(1)).toBe(1)
    expect(nextPow2(5)).toBe(8)
    expect(nextPow2(4096)).toBe(4096)
    expect(nextPow2(4097)).toBe(8192)
  })
})

describe('fftConvolve', () => {
  it('matches naive convolution', () => {
    const a = [1, 2, 3, 4], b = [0.5, -1, 0.25]
    const naive = new Array(a.length + b.length - 1).fill(0)
    for (let i = 0; i < a.length; i++)
      for (let j = 0; j < b.length; j++) naive[i + j] += a[i] * b[j]
    const got = fftConvolve(a, b)
    expect(got.length).toBe(naive.length)
    naive.forEach((v, i) => expect(got[i]).toBeCloseTo(v, 6))
  })

  it('convolving with a delta returns the original (zero-padded)', () => {
    const a = [3, 1, 4, 1, 5, 9, 2, 6]
    const got = fftConvolve(a, [1])
    a.forEach((v, i) => expect(got[i]).toBeCloseTo(v, 6))
  })

  it('handles a long signal across multiple overlap-add blocks', () => {
    const a = Array.from({ length: 500 }, (_, i) => Math.sin(i * 0.3))
    const b = Array.from({ length: 64 }, (_, i) => (i === 32 ? 1 : 0))  // pure delay 32
    const got = fftConvolve(a, b)
    // delayed copy: got[i+32] ≈ a[i]
    for (let i = 0; i < a.length; i++) expect(got[i + 32]).toBeCloseTo(a[i], 6)
  })
})
