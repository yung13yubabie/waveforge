// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { planClipTranspose, renderClipTranspose } from '../../src/js/daw/transpose.js'
import { renderSignalsmithPitch } from '../../src/js/pitch/signalsmith-render.js'

function buffer(channels = 1, length = 48000, sampleRate = 48000) {
  const data = Array.from({ length: channels }, () => new Float32Array(length))
  return { length, sampleRate, numberOfChannels: channels, duration: length / sampleRate,
    getChannelData: c => data[c], copyToChannel: (input, c) => data[c].set(input) }
}
const slice = (offsetSeconds = 0, durationSeconds = .25) => ({ offsetSeconds, durationSeconds })
const createBuffer = (channels, length, rate) => buffer(channels, length, rate)
const client = { render: async (channels, rate, options) => ({ ...await renderSignalsmithPitch(channels, rate, { ...options, yieldControl: async () => {} }), sourceToken: options.sourceToken }) }

describe('native clip transpose allocation and ownership plan', () => {
  it.each([44100, 48000, 96000])('covers fractional bounds and keeps the original fractional offset at %i Hz', rate => {
    const source = buffer(2, rate * 2, rate), clip = slice(100.5 / rate, .333)
    const result = planClipTranspose(source, clip, { semitones: 1 })
    expect(result.first).toBe(100)
    expect(result.last).toBe(Math.ceil((clip.offsetSeconds + clip.durationSeconds) * rate))
    expect(result.offsetSeconds).toBe(clip.offsetSeconds - 100 / rate)
    expect(result.channels[0].buffer).toBe(source.getChannelData(0).buffer)
    expect(result.channels[0].byteOffset).toBe(400)
    expect(result.length / rate).toBeGreaterThanOrEqual(clip.durationSeconds)
  })
  it('budgets the retained original, worker input/output, native PCM, WAV/Blob/hash copies and native slack before allocating', () => {
    const source = buffer(2, 96000 * 30, 96000), plan = planClipTranspose(source, slice(0, 30))
    expect(plan.pcmBytes).toBe(23040000)
    expect(plan.fileBytes).toBe(23040058)
    expect(plan.reservedBytes).toBe(source.length * 8 + plan.pcmBytes * 3 + plan.fileBytes * 3 + 16 * 1024 * 1024)
  })
  it('rejects a 30-second selection whose fractional coverage needs one extra sample', () => {
    expect(() => planClipTranspose(buffer(1, 31 * 48000), slice(.5 / 48000, 30))).toThrow('30 秒')
  })
  it.each([
    [32000, 1, 48000, slice(0, .2)], [48000, 3, 48000, slice(0, .2)],
    [48000, 1, 48000, slice(-.1, .2)], [48000, 1, 48000, slice(.9, .2)],
    [48000, 1, 48000, slice(0, 0)], [48000, 1, 48000, slice(NaN, .2)],
  ])('rejects unsupported or invalid bounds before worker use', (rate, channels, length, clip) => {
    expect(() => planClipTranspose(buffer(channels, length, rate), clip)).toThrow()
  })
  it('checks the combined pitch and independent formant range and nonzero minimum duration', () => {
    const source = buffer()
    expect(() => planClipTranspose(source, slice(), { semitones: 2, cents: 1 })).toThrow('±2')
    expect(() => planClipTranspose(source, slice(), { formantSemitones: 2.01 })).toThrow('±2')
    expect(() => planClipTranspose(source, slice(0, .05), { formantSemitones: 1 })).toThrow('120 ms')
    expect(planClipTranspose(source, slice(0, .05), {})).toMatchObject({ length: 2400 })
  })
})

describe('one computed result becomes native audition and Float32 storage', () => {
  it.each([44100, 48000, 96000])('keeps exact native rate, mono/stereo samples and above-unity headroom at %i Hz', async rate => {
    for (const count of [1, 2]) {
      const source = buffer(count, rate, rate)
      for (let c = 0; c < count; c++) { source.getChannelData(c).fill(c ? -.3 : 1.25); source.getChannelData(c)[1] = -0 }
      const plan = planClipTranspose(source, slice(0, .2))
      const result = await renderClipTranspose(plan, { client, sourceToken: 'test', check() {}, settings: {}, createBuffer })
      expect(result.buffer.sampleRate).toBe(rate)
      const bytes = new DataView(result.bytes)
      expect(bytes.getUint16(20, true)).toBe(3)
      expect(bytes.getUint32(24, true)).toBe(rate)
      for (let c = 0; c < count; c++) {
        const expected = Buffer.from(source.getChannelData(c).buffer, 0, plan.length * 4)
        const decoded = new Float32Array(plan.length)
        for (let i = 0; i < plan.length; i++) decoded[i] = bytes.getFloat32(58 + (i * count + c) * 4, true)
        expect(Buffer.compare(Buffer.from(result.buffer.getChannelData(c).buffer), expected)).toBe(0)
        expect(Buffer.compare(Buffer.from(decoded.buffer), expected)).toBe(0)
      }
      expect(result.hash).toMatch(/^[a-f0-9]{64}$/)
    }
  })
  it('uses the genuine engine for nonzero pitch and independently different formants, without changing the source', async () => {
    const source = buffer(), data = source.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = .2 * Math.sin(i * 2 * Math.PI * 220 / 48000)
    const before = data.slice(), settings = { semitones: 1, formantSemitones: -1, formantCompensation: true }
    const result = await renderClipTranspose(planClipTranspose(source, slice(0, .25), settings), { client, sourceToken: 'test', check() {}, settings, createBuffer })
    expect(result.metadata).toMatchObject({ semitones: 1, formantSemitones: -1, formantCompensation: true, outputGain: 1 })
    expect(result.buffer.length).toBe(12000)
    expect(result.buffer.getChannelData(0)).not.toEqual(before.subarray(0, 12000))
    expect(data).toEqual(before)
  })
  it('checks source token and ownership after worker completion, before any native or WAV allocation', async () => {
    const make = vi.fn(createBuffer), encode = vi.fn(), plan = planClipTranspose(buffer(), slice())
    const bad = { render: async () => ({ sourceToken: 'wrong' }) }
    await expect(renderClipTranspose(plan, { client: bad, sourceToken: 'test', check() {}, createBuffer: make, encode })).rejects.toThrow('來源')
    expect(make).not.toHaveBeenCalled(); expect(encode).not.toHaveBeenCalled()
    let current = true
    const stale = { render: async () => { current = false; return { sourceToken: 'test' } } }
    await expect(renderClipTranspose(plan, { client: stale, sourceToken: 'test', check() { if (!current) throw new Error('stale') }, createBuffer: make, encode })).rejects.toThrow('stale')
    expect(make).not.toHaveBeenCalled()
  })
  it('rejects a native buffer with wrong rate and stale serialization/hash completion', async () => {
    const plan = planClipTranspose(buffer(), slice()), make = () => buffer(1, plan.length, 44100)
    await expect(renderClipTranspose(plan, { client, sourceToken: 1, check() {}, createBuffer: make })).rejects.toThrow('原始取樣率')
    let valid = true, hash = vi.fn()
    await expect(renderClipTranspose(plan, { client, sourceToken: 1, check() { if (!valid) throw new Error('stale') }, createBuffer,
      encode: async () => { valid = false; return new ArrayBuffer(1) }, hash })).rejects.toThrow('stale')
    expect(hash).not.toHaveBeenCalled()
    valid = true
    await expect(renderClipTranspose(plan, { client, sourceToken: 1, check() { if (!valid) throw new Error('stale') }, createBuffer,
      hash: async () => { valid = false; return 'a'.repeat(64) } })).rejects.toThrow('stale')
  })
})
