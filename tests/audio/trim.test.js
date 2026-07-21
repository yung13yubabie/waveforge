import { describe, it, expect } from 'vitest'
import { trimBuffer } from '../../src/js/audio/trim.js'

const SR = 48000

/** Minimal AudioBuffer stand-in holding the given channel data. */
function bufferOf(...channels) {
  return {
    numberOfChannels: channels.length,
    length: channels[0].length,
    sampleRate: SR,
    duration: channels[0].length / SR,
    getChannelData: (c) => channels[c],
  }
}

describe('trimBuffer', () => {
  it('extracts exactly the requested sample range', () => {
    // 1 sample per millisecond at this rate would be unreadable; use a tiny
    // buffer and disable the fade so this test isolates extraction only.
    const data = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    const buf = bufferOf(data)
    const startSec = 3 / SR
    const endSec = 7 / SR

    const out = trimBuffer(buf, startSec, endSec, { fadeMs: 0 })

    expect(out.length).toBe(4)
    expect(Array.from(out.getChannelData(0))).toEqual([3, 4, 5, 6])
  })

  it('linearly fades the first and last samples so a cut does not click', () => {
    const data = new Float32Array(10).fill(1)
    const buf = bufferOf(data)
    const fadeSamples = 3

    const out = trimBuffer(buf, 0, 10 / SR, { fadeMs: (fadeSamples / SR) * 1000 })
    const d = out.getChannelData(0)

    // Fade-in ramps 0 -> 1 over the first `fadeSamples`; fade-out mirrors it
    // at the tail. The untouched middle stays at full amplitude.
    expect(d[0]).toBeCloseTo(0 / fadeSamples, 5)
    expect(d[1]).toBeCloseTo(1 / fadeSamples, 5)
    expect(d[2]).toBeCloseTo(2 / fadeSamples, 5)
    expect(d[5]).toBe(1)
    expect(d[9]).toBeCloseTo(0 / fadeSamples, 5)
    expect(d[8]).toBeCloseTo(1 / fadeSamples, 5)
    expect(d[7]).toBeCloseTo(2 / fadeSamples, 5)
  })

  it('clamps a start below 0 and an end past the buffer duration', () => {
    const data = new Float32Array([0, 1, 2, 3, 4])
    const buf = bufferOf(data)

    const out = trimBuffer(buf, -1, 100, { fadeMs: 0 })

    expect(Array.from(out.getChannelData(0))).toEqual([0, 1, 2, 3, 4])
  })

  it('rejects a range where start is not before end', () => {
    const buf = bufferOf(new Float32Array(10))

    expect(() => trimBuffer(buf, 5 / SR, 2 / SR)).toThrow(/裁剪範圍無效/)
    expect(() => trimBuffer(buf, 5 / SR, 5 / SR)).toThrow(/裁剪範圍無效/)
  })

  it('caps the fade so a very short selection cannot double-attenuate itself', () => {
    // 4 output samples with a fade window requesting 10 samples on each side
    // must fall back to a symmetric 2-sample fade (floor(4/2)), not apply
    // fade-in and fade-out on top of each other on the middle samples.
    const data = new Float32Array([1, 1, 1, 1])
    const buf = bufferOf(data)

    const out = trimBuffer(buf, 0, 4 / SR, { fadeMs: (10 / SR) * 1000 })

    expect(Array.from(out.getChannelData(0))).toEqual([0, 0.5, 0.5, 0])
  })

  it('defaults to a 5ms fade when no options are given', () => {
    const fiveMsSamples = Math.round(0.005 * SR) // 240 @ 48kHz
    const data = new Float32Array(fiveMsSamples * 4).fill(1)
    const buf = bufferOf(data)

    const withDefault = trimBuffer(buf, 0, data.length / SR)
    const withExplicit = trimBuffer(buf, 0, data.length / SR, { fadeMs: 5 })

    expect(Array.from(withDefault.getChannelData(0))).toEqual(Array.from(withExplicit.getChannelData(0)))
    expect(withDefault.getChannelData(0)[0]).toBe(0)
  })

  it('preserves channel count and sample rate, trimming each channel independently', () => {
    const left = new Float32Array([0, 10, 20, 30, 40])
    const right = new Float32Array([0, -1, -2, -3, -4])
    const buf = bufferOf(left, right)

    const out = trimBuffer(buf, 1 / SR, 4 / SR, { fadeMs: 0 })

    expect(out.numberOfChannels).toBe(2)
    expect(out.sampleRate).toBe(SR)
    expect(Array.from(out.getChannelData(0))).toEqual([10, 20, 30])
    expect(Array.from(out.getChannelData(1))).toEqual([-1, -2, -3])
  })
})
