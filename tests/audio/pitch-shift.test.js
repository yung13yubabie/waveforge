import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { shiftPitch, PITCH_SHIFT_LIMITS } from '../../src/js/pitch/shift.js'
import { tone, chirp, vowel, noise, rms, peak, crossingFrequency, periodicFrequency, centsError } from './pitch-shift-fixtures.js'

const immediate = async () => {}
const shift = (channels, sr, options = {}) => shiftPitch(channels, sr, { yieldControl: immediate, ...options })

function assertFinite(channels) {
  for (const channel of channels) for (const value of channel) {
    if (!Number.isFinite(value)) throw new Error('non-finite output')
  }
}

describe('bounded duration-preserving pitch DSP', () => {
  it('keeps the experimental shift module unreachable from shipping source imports', () => {
    const source = resolve('src')
    const target = resolve(source, 'js/pitch/shift.js')
    const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const path = resolve(directory, entry.name)
      return entry.isDirectory() ? walk(path) : path.endsWith('.js') ? [path] : []
    })
    for (const file of walk(source)) {
      if (file === target) continue
      const code = readFileSync(file, 'utf8')
      const imports = code.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/g)
      for (const match of imports) {
        if (match[1].startsWith('.')) expect(resolve(dirname(file), match[1]), file).not.toBe(target)
      }
    }
    expect(PITCH_SHIFT_LIMITS.releaseReadiness).toBe('internal-only')
  })
  for (const sr of [44100, 48000, 96000]) {
    for (const semitones of [-2, -0.37, 0.01, 0.37, 2]) {
      it(`changes measured frequency, preserving sample count/rate at ${sr} Hz, ${semitones} st`, async () => {
        const input = tone(sr, 1, 220)
        const before = input.slice()
        const result = await shift([input], sr, { semitones })
        const output = result.channels[0]
        expect(result.sampleRate).toBe(sr)
        expect(output.length).toBe(input.length)
        expect(input).toEqual(before)
        expect(output).not.toBe(input)
        const frequency = crossingFrequency(output, sr)
        expect(Math.abs(centsError(frequency, 220 * 2 ** (semitones / 12)))).toBeLessThan(1)
        expect(rms(output, sr * 0.2, sr * 0.8) / rms(input, sr * 0.2, sr * 0.8)).toBeGreaterThan(0.95)
        expect(rms(output, sr * 0.2, sr * 0.8) / rms(input, sr * 0.2, sr * 0.8)).toBeLessThan(1.05)
        expect(result.metadata.bypassed).toBe(false)
        expect(result.metadata.releaseReadiness).toBe('internal-only')
        expect(result.metadata.outputGain).toBe(1)
        assertFinite(result.channels)
      })
    }
    it(`has bit-exact independent zero-amount bypass at ${sr} Hz`, async () => {
      const input = Float32Array.of(0, -0, 1, -1, 7.99, 1e-25, -1e-25)
      const result = await shift([input, input.slice()], sr, { semitones: 1, cents: -100 })
      expect(new Uint8Array(result.channels[0].buffer)).toEqual(new Uint8Array(input.buffer))
      expect(result.channels[0]).not.toBe(input)
      expect(result.channels[0]).not.toBe(result.channels[1])
      expect(result.metadata.bypassed).toBe(true)
      expect(result.metadata.outputGain).toBe(1)
    })
    it(`handles empty and rejects inadequate nonzero duration at ${sr} Hz`, async () => {
      expect((await shift([new Float32Array()], sr, { semitones: 2 })).channels[0].length).toBe(0)
      const min = 2 ** Math.ceil(Math.log2(sr * 0.04)) * 2
      for (const length of [1, 2, 15, min - 1]) {
        await expect(shift([new Float32Array(length)], sr, { semitones: 1 })).rejects.toThrow('at least')
      }
      const smallest = await shift([tone(sr, min / sr)], sr, { semitones: 1 })
      expect(smallest.channels[0].length).toBe(min)
      expect(rms(smallest.channels[0])).toBeGreaterThan(0.05)
      assertFinite(smallest.channels)
    })
  }

  it('accepts cents and preserves detuned/non-bin-centered frequencies across the vocal band', async () => {
    for (const frequency of [82.41, 146.83, 391.995, 783.991]) {
      const result = await shift([tone(48000, 1, frequency)], 48000, { cents: 83 })
      const measured = crossingFrequency(result.channels[0], 48000)
      expect(Math.abs(centsError(measured, frequency * 2 ** (0.83 / 12)))).toBeLessThan(2)
    }
  })

  it('preserves exact linked stereo identity, scaled polarity and silence', async () => {
    const x = vowel(48000, 0.5)
    for (const factor of [1, -1, 0.5, 0]) {
      const result = await shift([x, x.map(v => v * factor)], 48000, { semitones: 1.5 })
      for (let i = 0; i < x.length; i++) {
        if (result.channels[1][i] !== result.channels[0][i] * factor) throw new Error('stereo relationship changed')
      }
    }
  })

  it('retains a stereo quarter-cycle phase relationship through a shared transform', async () => {
    const sr = 48000, f = 330
    const result = await shift([tone(sr, 1, f), tone(sr, 1, f, 0.3, Math.PI / 2)], sr, { semitones: -2 })
    const [a, b] = result.channels
    let cross = 0, aa = 0, bb = 0
    for (let i = sr * 0.2; i < sr * 0.8; i++) { cross += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2 }
    expect(Math.abs(cross / Math.sqrt(aa * bb))).toBeLessThan(0.01)
    expect(Math.abs(rms(a) / rms(b) - 1)).toBeLessThan(0.03)
    expect(Math.abs(centsError(crossingFrequency(a, sr), crossingFrequency(b, sr)))).toBeLessThan(0.1)
  })

  it('shifts independent left/right tones without summing channels together', async () => {
    const result = await shift([tone(48000, 1, 220), tone(48000, 1, 440)], 48000, { semitones: 2 })
    for (let ch = 0; ch < 2; ch++) {
      expect(Math.abs(centsError(crossingFrequency(result.channels[ch], 48000), (ch + 1) * 220 * 2 ** (2 / 12)))).toBeLessThan(2)
    }
  })

  for (const sr of [44100, 48000, 96000]) {
    it(`retains a slow synthetic pitch glide at ${sr} Hz`, async () => {
      for (const semitones of [-2, 2]) {
        const result = await shift([chirp(sr, 1.5)], sr, { semitones })
        for (const center of [0.3, 0.7, 1.1]) {
          const measured = crossingFrequency(result.channels[0], sr, center - 0.03, center + 0.03)
          expect(Math.abs(centsError(measured, (180 + 60 * center) * 2 ** (semitones / 12)))).toBeLessThan(8)
        }
      }
    })
    it(`shifts the fundamental of a harmonic-rich synthetic vowel at ${sr} Hz`, async () => {
      for (const semitones of [-2, 2]) {
        const input = vowel(sr, 1)
        const result = await shift([input], sr, { semitones })
        const expected = 180 * 2 ** (semitones / 12)
        const measured = periodicFrequency(result.channels[0], sr, 0.5, expected)
        expect(Math.abs(centsError(measured.frequency, expected))).toBeLessThan(3)
        expect(measured.correlation).toBeGreaterThan(0.98)
        expect(rms(result.channels[0]) / rms(input)).toBeGreaterThan(0.7)
        expect(rms(result.channels[0]) / rms(input)).toBeLessThan(1.2)
      }
    })
  }

  it('processes transient, clipped boundary, noise and DC fixtures without non-finite or runaway output', async () => {
    const sr = 48000
    const impulses = new Float32Array(sr)
    for (const index of [0, 100, sr / 2, sr - 100, sr - 1]) impulses[index] = 0.8
    const gate = tone(sr, 1, 110).map((v, i) => i >= 0.25 * sr && i < 0.75 * sr ? v : 0)
    for (const input of [impulses, gate, noise(sr, 1), new Float32Array(sr).fill(0.2), new Float32Array(sr)]) {
      for (const semitones of [-2, 2]) {
        const result = await shift([input], sr, { semitones })
        assertFinite(result.channels)
        expect(result.channels[0].length).toBe(input.length)
        expect(peak(result.channels[0])).toBeLessThanOrEqual(1)
        expect(rms(result.channels[0])).toBeLessThanOrEqual(Math.max(rms(input) * 2, 1e-12))
        if (rms(input) > 0.01) expect(rms(result.channels[0])).toBeGreaterThan(rms(input) * 0.3)
      }
    }
  })

  it('has no end-to-start wrapping and retains an internal impulse near its original time', async () => {
    const sr = 48000, input = new Float32Array(sr)
    input[sr / 2] = 0.7
    const result = await shift([input], sr, { semitones: 2 })
    const output = result.channels[0]
    let maximum = 0
    for (let i = 1; i < output.length; i++) if (Math.abs(output[i]) > Math.abs(output[maximum])) maximum = i
    expect(Math.abs(maximum - sr / 2) / sr).toBeLessThan(0.03)
    expect(rms(output, 0, sr / 4)).toBe(0)
    expect(rms(output, sr * 3 / 4)).toBe(0)
    expect(peak(output)).toBeGreaterThan(0.01)
  })

  it('attenuates aliased high frequencies on upward shifts', async () => {
    const result = await shift([tone(48000, 1, 23000)], 48000, { semitones: 2 })
    expect(rms(result.channels[0], 9600, 38400)).toBeLessThan(0.002)
  })

  it('uses one reported output attenuation instead of independent stereo clipping', async () => {
    const input = tone(48000, 0.5, 220, 3)
    const result = await shift([input, input.map(v => -0.5 * v)], 48000, { semitones: 2 })
    expect(result.metadata.outputGain).toBeGreaterThan(0)
    expect(result.metadata.outputGain).toBeLessThan(0.5)
    expect(peak(result.channels[0])).toBeCloseTo(0.999, 6)
    for (let i = 0; i < input.length; i++) {
      if (result.channels[1][i] !== result.channels[0][i] * -0.5) throw new Error('gain lost stereo relationship')
    }
  })

  it('is deterministic and independent of cooperative scheduling', async () => {
    const input = noise(48000, 0.4)
    const a = await shift([input], 48000, { semitones: 1 })
    const b = await shiftPitch([input], 48000, { semitones: 1 })
    expect(a.channels[0]).toEqual(b.channels[0])
    expect(a.metadata).toEqual(b.metadata)
  })

  it('checks cancellation before work, during validation, processing, resampling and gain stages', async () => {
    for (const at of [-1, 0, 0.1, 0.7, 0.95]) {
      const controller = new AbortController()
      const input = tone(48000, 1)
      const before = input.slice()
      const progress = []
      if (at < 0) controller.abort()
      await expect(shift([input], 48000, {
        semitones: 2,
        signal: controller.signal,
        onProgress(value) { progress.push(value); if (value >= at) controller.abort() },
      })).rejects.toMatchObject({ name: 'AbortError' })
      expect(input).toEqual(before)
      expect(progress).not.toContain(1)
    }
  })

  it('reports monotonic completed progress and propagates wrapper failures', async () => {
    const progress = []
    await shift([tone(48000, 0.5)], 48000, { semitones: -2, onProgress: value => progress.push(value) })
    expect(progress.at(-1)).toBe(1)
    expect(progress.every((value, i) => value >= 0 && value <= 1 && (!i || value >= progress[i - 1]))).toBe(true)
    await expect(shift([tone(48000, 0.2)], 48000, { yieldControl: () => { throw new Error('wrapper failed') } })).rejects.toThrow('wrapper failed')
  })

  it('rejects unsupported parameters before allocating large DSP buffers', async () => {
    const x = tone(48000, 0.2)
    for (const channels of [[], [x, x, x], [new Float64Array(10000)], [x, x.subarray(1)]]) {
      await expect(shift(channels, 48000)).rejects.toThrow()
    }
    for (const sr of [0, 16000, 47999, 192000, NaN]) await expect(shift([x], sr)).rejects.toThrow()
    for (const semitones of [-2.001, 2.001, NaN, Infinity, '1']) await expect(shift([x], 48000, { semitones })).rejects.toThrow()
    await expect(shift([x], 48000, { semitones: 2, cents: 1 })).rejects.toThrow('limited')
    await expect(shift([x], 48000, { cents: NaN })).rejects.toThrow()
    await expect(shift([x], 48000, { onProgress: true })).rejects.toThrow()
    await expect(shift([x], 48000, { yieldControl: false })).rejects.toThrow()
    await expect(shift([new Float32Array(48000 * 30 + 1)], 48000)).rejects.toThrow('30 seconds')
    for (const invalid of [NaN, Infinity, -Infinity, 8.1]) {
      const input = x.slice(); input[input.length - 1] = invalid
      await expect(shift([input], 48000, { semitones: 1 })).rejects.toThrow('finite')
    }
    expect(PITCH_SHIFT_LIMITS.experimental).toBe(true)
  })
})
