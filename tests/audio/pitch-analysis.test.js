// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { analyzePitch, describePitch, frequencyToMidi, midiToFrequency, midiToNote, PITCH_ANALYSIS_INFO } from '../../src/js/pitch/analysis.js'
import { tone, seededNoise, linearGlide } from './pitch-analysis-fixtures.js'

const centsError = (actual, expected) => Math.abs(1200 * Math.log2(actual / expected))
const voiced = result => result.frames.filter(frame => frame.state === 'voiced')

describe('pitch conversion, standard A4 = 440 Hz', () => {
  it('converts Hz/MIDI/note names and signed cents without judging musical intent', () => {
    expect(frequencyToMidi(440)).toBe(69)
    expect(midiToFrequency(69)).toBe(440)
    expect(midiToNote(60)).toBe('C4')
    expect(midiToNote(61)).toBe('C♯4')
    expect(midiToNote(-1)).toBe('B-2')
    const info = describePitch(440 * 2 ** (23 / 1200), 69)
    expect(info.note).toBe('A4')
    expect(info.cents).toBeCloseTo(23, 9)
    expect(info.referenceCents).toBeCloseTo(23, 9)
    expect(describePitch(440 * 2 ** (-31 / 1200)).cents).toBeCloseTo(-31, 9)
    expect(describePitch(440).referenceCents).toBeNull()
  })
  it.each([null, undefined, NaN, Infinity, -1, 0])('keeps invalid Hz %s unknown', value => {
    expect(frequencyToMidi(value)).toBeNull()
    expect(describePitch(value)).toEqual({ frequencyHz: null, midi: null, note: null, cents: null, referenceCents: null })
  })
  it('rejects invalid conversion inputs without infinite output', () => {
    for (const value of [null, undefined, Infinity, NaN, 999]) expect(midiToFrequency(value)).toBeNull()
    expect(midiToNote(NaN)).toBeNull()
  })
})

describe('real DSP on synthetic monophonic fixtures (not real singing validation)', () => {
  it.each([44100, 48000, 96000])('tracks known tones at the true %i Hz input rate', async sampleRate => {
    for (const frequency of [55, 110, 220, 440, 880, 1190]) {
      const input = tone({ sampleRate, frequency, duration: 0.18 })
      const copy = input.slice()
      const result = await analyzePitch(input, sampleRate)
      expect(result.sampleRate).toBe(sampleRate)
      expect(result.analysisSampleRate).toBe(sampleRate === 44100 ? 11025 : 12000)
      expect(result.summary.voicedFraction).toBeGreaterThan(0.9)
      expect(centsError(result.summary.medianFrequencyHz, frequency)).toBeLessThan(3)
      for (const frame of voiced(result)) expect(centsError(frame.frequencyHz, frequency)).toBeLessThan(4)
      expect(input).toEqual(copy)
    }
  })
  it.each([44100, 48000, 96000])('treats exact range endpoints conservatively at %i Hz, without clamping or promising inclusivity', async sampleRate => {
    for (const frequency of [50, 1200]) {
      const result = await analyzePitch(tone({ sampleRate, frequency, duration: 0.2 }), sampleRate)
      for (const frame of result.frames) {
        if (frame.state === 'voiced') {
          expect(frame.frequencyHz).toBeGreaterThanOrEqual(50)
          expect(frame.frequencyHz).toBeLessThanOrEqual(1200)
          expect(centsError(frame.frequencyHz, frequency)).toBeLessThan(4)
        } else expect(frame.frequencyHz).toBeNull()
      }
      expect(result.limitations.join(' ')).toMatch(/range limits can be left unknown/)
    }
  })
  it.each([8000, 192000])('handles supported boundary sample rate %i Hz', async sampleRate => {
    const result = await analyzePitch(tone({ sampleRate, frequency: 440, duration: 0.15 }), sampleRate)
    expect(centsError(result.summary.medianFrequencyHz, 440)).toBeLessThan(1)
  })
  it.each([-37, 19, 43])('measures a %+i cent detune instead of quantizing to a note', async cents => {
    const frequency = 440 * 2 ** (cents / 1200)
    const result = await analyzePitch(tone({ frequency }), 48000)
    expect(centsError(result.summary.medianFrequencyHz, frequency)).toBeLessThan(1)
    expect(voiced(result).every(frame => Math.abs(frame.cents - cents) < 1)).toBe(true)
  })
  it('tracks a glide at source-buffer times without staircase quantization', async () => {
    const result = await analyzePitch(linearGlide(), 48000, { start: 3.25 })
    expect(result.timestampOrigin).toBe('source-buffer')
    expect(result.frames[0].time).toBeCloseTo(3.282, 6)
    expect(result.summary.voicedFraction).toBeGreaterThan(0.9)
    for (const frame of voiced(result)) {
      const frequency = 220 + 110 * (frame.time - 3.25) / 0.8
      expect(centsError(frame.frequencyHz, frequency)).toBeLessThan(6)
    }
    expect(result.frames.at(-1).frequencyHz).toBeGreaterThan(result.frames[0].frequencyHz + 90)
  })
  it('tracks a harmonic-rich waveform, including a weaker fundamental', async () => {
    const result = await analyzePitch(tone({ frequency: 173, harmonics: [0.35, 0.8, 0.4, 0.15] }), 48000)
    expect(result.summary.voicedFraction).toBeGreaterThan(0.9)
    expect(centsError(result.summary.medianFrequencyHz, 173)).toBeLessThan(2)
  })
  it('rejects silence, DC, extremely quiet tones and deterministic noise', async () => {
    for (const input of [new Float32Array(24000), new Float32Array(24000).fill(0.3), tone({ amplitude: 0.0001 }), seededNoise({ duration: 1 })]) {
      const result = await analyzePitch(input, 48000)
      expect(result.summary.voicedFrames).toBe(0)
      expect(result.summary.medianFrequencyHz).toBeNull()
      expect(result.summary.reason).toBe('no-reliable-pitch')
      for (const frame of result.frames) {
        expect(frame.frequencyHz).toBeNull()
        expect(frame.midi).toBeNull()
        expect(frame.note).toBeNull()
        expect(frame.cents).toBeNull()
      }
    }
  })
  it('does not label isolated impulses as notes', async () => {
    const impulse = new Float32Array(48000)
    for (const index of [5000, 10000, 27000]) impulse[index] = 1
    const result = await analyzePitch(impulse, 48000)
    expect(result.summary.voicedFrames).toBe(0)
  })
  it('leaves a low-periodicity mixture unknown, without claiming a polyphony classifier', async () => {
    const mix = tone({ frequency: 220 })
    for (const frequency of [307, 463]) {
      const other = tone({ frequency })
      for (let i = 0; i < mix.length; i++) mix[i] += other[i]
    }
    const result = await analyzePitch(mix, 48000)
    expect(result.summary.voicedFrames).toBe(0)
    expect(result.limitations.join(' ')).toMatch(/overlapping notes/)
    expect(result.limitations.join(' ')).toMatch(/Octave errors/)
    expect(result.limitations.join(' ')).toMatch(/not a probability/)
  })
  it('documents that a periodic mixture can pass: confidence cannot identify an isolated voice', async () => {
    const mix = tone({ frequency: 440 })
    const other = tone({ frequency: 523.251 })
    for (let i = 0; i < mix.length; i++) mix[i] += other[i]
    const result = await analyzePitch(mix, 48000)
    // This counterexample must not become a product claim of voice detection.
    expect(result.summary.voicedFrames).toBeGreaterThan(0)
    expect(result.limitations.join(' ')).toMatch(/not a detected human voice/)
    expect(result.limitations.join(' ')).toMatch(/not been calibrated/)
    expect(result).not.toHaveProperty('key')
    expect(result).not.toHaveProperty('correctness')
  })
  it.each([35, 1600, 5000])('does not convert an out-of-range %i Hz pure tone into a confident note', async frequency => {
    const result = await analyzePitch(tone({ frequency }), 48000)
    expect(result.summary.voicedFrames).toBe(0)
  })
  it('accepts empty/short selections with no invented or padded frames', async () => {
    for (const input of [new Float32Array(), tone({ duration: 0.02 })]) {
      const result = await analyzePitch(input, 48000)
      expect(result.frames).toEqual([])
      expect(result.summary.reason).toBe('too-short')
      expect(result.summary.voicedFraction).toBe(0)
    }
  })
  it('reports measured, bounded progress and ignores failing observers', async () => {
    const progress = []
    const result = await analyzePitch(tone(), 48000, { onProgress: p => { progress.push(p.progress); throw new Error('view detached') } })
    expect(result.frames.length).toBeGreaterThan(0)
    expect(progress.at(-1)).toBe(1)
    expect(progress.every((value, i) => value >= 0 && value <= 1 && (!i || value >= progress[i - 1]))).toBe(true)
  })
})

describe('bounded work and input safety', () => {
  it('rejects invalid rates, starts, data types and non-finite samples', async () => {
    for (const rate of [0, NaN, Infinity, 7999, 192001]) await expect(analyzePitch(tone(), rate)).rejects.toThrow()
    for (const start of [-1, Infinity, NaN]) await expect(analyzePitch(tone(), 48000, { start })).rejects.toThrow()
    await expect(analyzePitch([0, 1], 48000)).rejects.toThrow(/Float32Array/)
    const input = tone(); input[7] = NaN
    await expect(analyzePitch(input, 48000)).rejects.toThrow(/non-finite/)
  })
  it('rejects selections over the hard 60-second cap before doing DSP', async () => {
    await expect(analyzePitch(new Float32Array(8000 * 60 + 1), 8000)).rejects.toThrow(/60 seconds/)
    expect(PITCH_ANALYSIS_INFO.maxDuration).toBe(60)
  })
  it('honors pre-abort and cancellation during preparation and contour analysis', async () => {
    await expect(analyzePitch(tone(), 48000, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
    for (const phase of ['preparing', 'analyzing']) {
      const controller = new AbortController()
      const observer = vi.fn(progress => { if (progress.phase === phase) controller.abort() })
      await expect(analyzePitch(tone({ duration: 1 }), 48000, { signal: controller.signal, onProgress: observer })).rejects.toMatchObject({ name: 'AbortError' })
      expect(observer.mock.calls.some(([p]) => p.phase === phase)).toBe(true)
      expect(observer.mock.calls.some(([p]) => p.phase === 'complete')).toBe(false)
    }
  })
})
