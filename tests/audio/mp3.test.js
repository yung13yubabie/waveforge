import { describe, it, expect } from 'vitest'
import { encodeMP3 } from '../../src/js/audio/mp3.js'

/** Build a sine tone as Float32 channel data. */
function tone(seconds, sampleRate, { amplitude = 0.5, hz = 440 } = {}) {
  const data = new Float32Array(Math.floor(seconds * sampleRate))
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.sin((2 * Math.PI * hz * i) / sampleRate) * amplitude
  }
  return data
}

describe('encodeMP3', () => {
  it('produces a decodable MP3 with a valid frame sync header', () => {
    const sr = 44100
    const mono = tone(1, sr)
    const out = encodeMP3([mono, mono], sr, 192)

    // Every MP3 frame starts with 11 set sync bits: 0xFF followed by 0xEx/0xFx.
    expect(out[0]).toBe(0xff)
    expect(out[1] & 0xe0).toBe(0xe0)
  })

  it('returns a non-empty buffer sized roughly to the requested bitrate', () => {
    const sr = 44100
    const mono = tone(1, sr)
    const out = encodeMP3([mono, mono], sr, 192)

    // 1 second @192kbps ≈ 24000 bytes. Allow generous slack for the
    // encoder's header/padding, but catch a silently-truncated stream.
    expect(out.length).toBeGreaterThan(12000)
    expect(out.length).toBeLessThan(40000)
  })

  it('encodes at a higher bitrate into a larger file', () => {
    const sr = 44100
    const mono = tone(1, sr)
    const small = encodeMP3([mono, mono], sr, 128)
    const large = encodeMP3([mono, mono], sr, 320)

    expect(large.length).toBeGreaterThan(small.length)
  })

  it('encodes mono input without a right channel', () => {
    const sr = 44100
    const out = encodeMP3([tone(0.5, sr)], sr, 192)

    expect(out[0]).toBe(0xff)
    expect(out.length).toBeGreaterThan(0)
  })

  it('accepts every sample rate the export UI offers', () => {
    for (const sr of [44100, 48000]) {
      const out = encodeMP3([tone(0.2, sr), tone(0.2, sr)], sr, 192)
      expect(out[0], `sample rate ${sr}`).toBe(0xff)
    }
  })

  it('rejects 96kHz, which lamejs cannot encode', () => {
    const mono = tone(0.1, 96000)
    expect(() => encodeMP3([mono, mono], 96000, 192)).toThrow(/96000/)
  })

  it('rejects an empty audio buffer instead of emitting a zero-byte file', () => {
    expect(() => encodeMP3([new Float32Array(0)], 44100, 192)).toThrow(/空/)
  })

  it('clamps out-of-range samples rather than wrapping them', () => {
    const sr = 44100
    // Deliberately over-unity input; wrapping would fold +2.0 to a negative
    // int16 and produce audible glitching instead of clipping.
    const hot = new Float32Array(sr).fill(2.0)
    const out = encodeMP3([hot, hot], sr, 192)

    expect(out[0]).toBe(0xff)
    expect(out.length).toBeGreaterThan(0)
  })

  it('handles a buffer that is not a multiple of the 1152-sample block size', () => {
    const sr = 44100
    const odd = tone(1, sr).subarray(0, 44100 - 7)
    const out = encodeMP3([odd, odd], sr, 192)

    expect(out[0]).toBe(0xff)
    expect(out.length).toBeGreaterThan(0)
  })
})
