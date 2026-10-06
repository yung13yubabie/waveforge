// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { sourceFrameBounds } from '../../src/js/daw/sample-bounds.js'
import { planClipTranspose } from '../../src/js/daw/transpose.js'

const rates = [44100, 48000, 96000]
function buffer(length, sampleRate) {
  const samples = new Float32Array(length)
  return { length, sampleRate, numberOfChannels: 1, duration: length / sampleRate, getChannelData: () => samples }
}

describe('source sample bounds tolerate arithmetic roundoff only', () => {
  it.each([[44100, 5518], [48000, 6007], [96000, 12001], [44100, 44107], [48000, 48003], [96000, 96006]])('retains a valid full-source %i Hz / %i frame clip', (rate, frames) => {
    const source = buffer(frames, rate)
    expect(Math.ceil(source.duration * rate)).toBe(frames + 1) // Exact baseline reproduction.
    const plan = planClipTranspose(source, { offsetSeconds: 0, durationSeconds: source.duration }, { semitones: 1 })
    expect(plan).toMatchObject({ first: 0, last: frames, length: frames, offsetSeconds: 0 })
  })
  it.each(rates)('covers every whole-sample duration from 1 frame through 30 seconds at %i Hz', rate => {
    let failures = 0, rawOverruns = 0
    for (let frames = 1; frames <= 30 * rate; frames++) {
      const bounds = sourceFrameBounds(0, frames / rate, rate)
      if (bounds.first !== 0 || bounds.last !== frames || bounds.offsetSeconds !== 0) failures++
      if (Math.ceil(frames / rate * rate) !== frames) rawOverruns++
    }
    expect(failures).toBe(0); expect(rawOverruns).toBeGreaterThan(1000)
  })
  it.each(rates)('preserves real fractions on both sides of frame boundaries at %i Hz', rate => {
    for (const frame of [100, rate, rate * 100, rate * 599]) for (const delta of [.5, .25, .0001, .000001, -.5, -.25, -.0001, -.000001]) {
      const offset = (frame + delta) / rate, duration = 1000 / rate
      const bounds = sourceFrameBounds(offset, duration, rate)
      const expectedFirst = delta > 0 ? frame : frame - 1, expectedLast = delta > 0 ? frame + 1001 : frame + 1000
      expect(bounds.first).toBe(expectedFirst); expect(bounds.last).toBe(expectedLast)
      expect(bounds.offsetSeconds).toBe(offset - expectedFirst / rate)
      expect(bounds.offsetSeconds).toBeGreaterThan(0)
    }
  })
  it.each(rates)('keeps subtraction-derived start frames nonnegative and exact at %i Hz', rate => {
    const offsetSeconds = .35 - .25
    expect(offsetSeconds - .1).toBeLessThan(0)
    const plan = planClipTranspose(buffer(rate, rate), { offsetSeconds, durationSeconds: .2 }, { semitones: 1 })
    expect(plan.first).toBe(rate / 10); expect(plan.last).toBe(rate * .3)
    expect(plan.offsetSeconds).toBe(0)
  })
  it.each(rates)('keeps integer crop boundaries stable across a broad offset/length scan at %i Hz', rate => {
    const source = buffer(rate * 2, rate)
    let failures = 0
    for (let first = 1; first < rate; first += 97) for (const length of [Math.ceil(rate * .12), Math.ceil(rate * .333), rate]) {
      const offsetSeconds = first / rate, durationSeconds = (first + length) / rate - offsetSeconds
      const plan = planClipTranspose(source, { offsetSeconds, durationSeconds }, { semitones: 1 })
      if (plan.first !== first || plan.last !== first + length || plan.offsetSeconds !== 0) failures++
    }
    expect(failures).toBe(0)
  })
  it('still rejects real duration overages and fractional coverage beyond 30 seconds', () => {
    expect(() => planClipTranspose(buffer(31 * 48000, 48000), { offsetSeconds: .5 / 48000, durationSeconds: 30 })).toThrow('30 秒')
    expect(() => planClipTranspose(buffer(6007, 48000), { offsetSeconds: 0, durationSeconds: (6007.000001) / 48000 })).toThrow('超出原錄音')
  })
})
