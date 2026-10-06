// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { renderSignalsmithPitch, validateSignalsmithInput } from '../../src/js/pitch/signalsmith-render.js'
import { tone, noise, vowel, crossingFrequency, peak, periodicFrequency, centsError } from './pitch-shift-fixtures.js'
const render = (x, sr = 48000, options = {}) => renderSignalsmithPitch(x, sr, { yieldControl: async () => {}, ...options })
const sameBytes = (a, b) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength))

describe('Signalsmith retained source and byte-exact derivative', () => {
  it('retains pinned upstream and only the audited factory-export insertion', () => {
    const base = new URL('../../src/js/pitch/vendor/signalsmith-stretch/', import.meta.url)
    const upstream = readFileSync(new URL('upstream/SignalsmithStretch.mjs', base))
    expect(upstream.length).toBe(113867)
    expect(createHash('sha1').update(`blob ${upstream.length}\0`).update(upstream).digest('hex')).toBe('7d5cae72e77a84143ed91ba12fc91b806dc4d9d1')
    expect(createHash('sha256').update(upstream).digest('hex')).toBe('97530b11d5bc01015af4cde40d6aa55ff10c40aa1294ca4c8c5762027d517a46')
    const patch = '// WaveForge adapter patch: expose the bundled low-level factory; WASM unchanged.\nexport const createSignalsmithModule = SignalsmithStretch;\n'
    expect(readFileSync(new URL('SignalsmithStretch.mjs', base), 'utf8')).toBe(upstream.toString().replace('SignalsmithStretch = ((Module, audioNodeKey) => {', patch + 'SignalsmithStretch = ((Module, audioNodeKey) => {'))
  })
})

describe('Signalsmith bounded offline render contract', () => {
  it('zero controls return fresh bit-exact PCM including signed zero and above-unity headroom', async () => {
    const x = new Float32Array([0, -0, 1.5, -2, 1e-38])
    const y = await render([x], 44100, { semitones: 1, cents: -100, formantCompensation: true })
    expect(y.channels[0]).not.toBe(x)
    expect(sameBytes(x, y.channels[0])).toBe(true)
    expect(y.metadata.bypassed).toBe(true)
    expect(y.metadata.wasmMemoryBytes).toBe(0)
    expect(y.metadata.outputGain).toBe(1)
  })
  it('empty audio returns exact empty duration', async () => {
    const r = await render([new Float32Array(0)], 48000, { semitones: 2 })
    expect(r.channels[0].length).toBe(0)
  })
  for (const sr of [44100, 48000, 96000]) for (const st of [-2, 2]) {
    it(`genuinely shifts a tone without rate/duration change: ${sr} Hz, ${st} st`, async () => {
      const input = tone(sr, 1), before = input.slice()
      const r = await render([input], sr, { semitones: st })
      expect(r.channels[0].length).toBe(input.length)
      expect(r.sampleRate).toBe(sr)
      expect(sameBytes(input, before)).toBe(true)
      // Coarse semantic check only. Tight cent-error observations remain in the
      // characterization report, including failing quality gates.
      const frequency = crossingFrequency(r.channels[0], sr)
      expect(Math.sign(frequency - 220)).toBe(Math.sign(st))
      expect(Math.abs(frequency / (220 * 2 ** (st / 12)) - 1)).toBeLessThan(0.02)
      expect(r.metadata.inputLatency).toBe(Math.round(sr * 0.06))
      expect(r.metadata.outputLatency).toBe(Math.round(sr * 0.06))
      expect(r.metadata.wasmMemoryBytes).toBeLessThan(8 * 1024 * 1024)
    })
  }
  for (const st of [-2, 2]) for (const index of [0, 100, 24000, 47900, 47999]) {
    it(`drains EOF and aligns impulse at sample ${index}, ${st} st`, async () => {
      const x = new Float32Array(48000); x[index] = 0.8
      const y = (await render([x], 48000, { semitones: st })).channels[0]
      let maximum = 0, energy = 0
      y.forEach((value, i) => { energy += value ** 2; if (Math.abs(value) > Math.abs(y[maximum])) maximum = i })
      expect(maximum).toBe(index)
      expect(10 * Math.log10(energy / 0.64)).toBeGreaterThan(-1)
    })
  }
  it('native stereo retains channels and exact silence without mixing channels', async () => {
    const x = tone(48000, 1), r = await render([x, new Float32Array(x.length)], 48000, { semitones: 2 })
    expect(peak(r.channels[0])).toBeGreaterThan(.1)
    expect(peak(r.channels[1])).toBe(0)
  })
  it('is deterministic across fresh WASM instances for constant-time noise processing', async () => {
    const x = noise(48000, .3)
    const a = await render([x], 48000, { semitones: -2 }), b = await render([x], 48000, { semitones: -2 })
    expect(sameBytes(a.channels[0], b.channels[0])).toBe(true)
  })
  it('supports formant-only changes without an octave/rate shortcut', async () => {
    const x = vowel(48000, 1)
    const r = await render([x], 48000, { formantSemitones: 2, formantBaseHz: 180 })
    expect(r.metadata.bypassed).toBe(false)
    expect(r.metadata.semitones).toBe(0)
    expect(r.metadata.formantPreservationClaimed).toBe(false)
    expect(sameBytes(x, r.channels[0])).toBe(false)
    expect(Math.abs(centsError(periodicFrequency(r.channels[0], 48000, .5, 180).frequency, 180))).toBeLessThan(1)
  })
  it('reports overshoot without silently normalizing, clipping, or claiming a limiter', async () => {
    const x = tone(48000, 1, 220, 2)
    const r = await render([x], 48000, { semitones: 2 })
    expect(r.metadata.outputPeak).toBeGreaterThan(1)
    expect(r.metadata.outputGain).toBe(1)
    expect(peak(r.channels[0])).toBe(r.metadata.outputPeak)
  })
  it('loads embedded WASM without network requests', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Unexpected network') })
    try { await render([tone(48000, .2)], 48000, { cents: 37 }); expect(fetch).not.toHaveBeenCalled() } finally { fetch.mockRestore() }
  })
  it('only reports 1 on success and checks abort after progress callbacks', async () => {
    const controller = new AbortController(), progress = []
    await expect(render([tone(48000, 1)], 48000, { semitones: 2, signal: controller.signal, onProgress: p => { progress.push(p); if (p > .1) controller.abort() } })).rejects.toMatchObject({ name: 'AbortError' })
    expect(progress.at(-1)).toBeLessThan(1)
    expect(progress.every((p, i) => i === 0 || p >= progress[i - 1])).toBe(true)
  })
  it('checks cancellation before work and after an awaited yield', async () => {
    const c = new AbortController(); c.abort()
    await expect(render([tone(48000, 1)], 48000, { signal: c.signal })).rejects.toMatchObject({ name: 'AbortError' })
    const d = new AbortController()
    await expect(render([tone(48000, 1)], 48000, { signal: d.signal, yieldControl: async () => d.abort() })).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('does not turn completed DSP into failure when the terminal observer throws or aborts', async () => {
    const c = new AbortController(), events = []
    const result = await render([tone(48000, .2)], 48000, { semitones: 2, signal: c.signal, onProgress: value => { events.push(value); if (value === 1) c.abort(); throw Error('observer') } })
    expect(result.channels[0].length).toBe(9600)
    expect(events.at(-1)).toBe(1)
    expect(c.signal.aborted).toBe(true)
  })
  it.each([NaN, Infinity, -Infinity, 8.1])('rejects invalid input samples %s before DSP', async value => {
    const x = new Float32Array(6000); x[4000] = value
    await expect(render([x], 48000, { semitones: 2 })).rejects.toThrow('finite')
  })
  it('bounds allocation and rejects invalid shape/settings', () => {
    const x = new Float32Array(6000)
    for (const args of [[[], 48000], [[x,x,x],48000], [[x,,],48000], [[,x],48000], [[x],16000], [[x,new Float32Array(5)],48000], [[new Float64Array(6000)],48000], [[new Float32Array(48000*30+1)],48000], [[x],48000,{semitones:2,cents:1}], [[x],48000,{semitones:NaN}], [[x],48000,{formantSemitones:3}], [[x],48000,{formantCompensation:1}], [[x],48000,{formantBaseHz:20}], [[new Float32Array(100)],48000,{semitones:1}]]) expect(() => validateSignalsmithInput(...args)).toThrow()
  })
})
