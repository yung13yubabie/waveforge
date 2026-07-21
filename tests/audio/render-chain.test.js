// Unit-level wiring checks for the shared offline render chain. Real DSP
// correctness is covered by Playwright E2E (export + album render); here we use
// the mock OfflineAudioContext to confirm it wires up and returns a buffer at
// the requested sample rate without throwing across module on/off combinations.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AudioEngine } from '../../src/js/audio/engine.js'
import { renderMasterChain, buildFreqGrid } from '../../src/js/audio/render-chain.js'

vi.mock('../../src/js/audio/lufs-worklet.js?url', () => ({ default: 'mock-lufs-url' }))
vi.mock('../../src/js/audio/dynamics-worklet.js?url', () => ({ default: 'mock-dyn-url' }))

describe('renderMasterChain', () => {
  let engine
  beforeEach(async () => { engine = new AudioEngine(); await engine.init() })

  function srcBuf(sr = 44100, secs = 1) {
    return engine.ctx.createBuffer(2, Math.round(sr * secs), sr)
  }

  it('renders at the requested 44.1kHz sample rate', async () => {
    const snap = engine.serialize()
    const out = await renderMasterChain({
      engine, sourceBuffer: srcBuf(44100), params: snap.params, bypassed: snap.bypassed,
      sampleRate: 44100, dynamicsWorkletUrl: 'mock-dyn-url',
    })
    expect(out.sampleRate).toBe(44100)
    expect(out.numberOfChannels).toBe(2)
  })

  it('renders at 48kHz too (export path)', async () => {
    const snap = engine.serialize()
    const out = await renderMasterChain({
      engine, sourceBuffer: srcBuf(48000), params: snap.params, bypassed: snap.bypassed,
      sampleRate: 48000, dynamicsWorkletUrl: 'mock-dyn-url',
    })
    expect(out.sampleRate).toBe(48000)
  })

  it('does not throw with all optional modules bypassed', async () => {
    const snap = engine.serialize()  // dyneq/ms/deesser/sat start bypassed
    await expect(renderMasterChain({
      engine, sourceBuffer: srcBuf(), params: snap.params, bypassed: snap.bypassed,
      sampleRate: 44100, dynamicsWorkletUrl: 'mock-dyn-url',
    })).resolves.toBeDefined()
  })

  it('does not throw with dyneq + deesser + M/S active', async () => {
    engine.setModuleBypassed('dyneq', false)
    engine.setModuleBypassed('deesser', false)
    engine.setModuleBypassed('ms', false)
    const snap = engine.serialize()
    await expect(renderMasterChain({
      engine, sourceBuffer: srcBuf(), params: snap.params, bypassed: snap.bypassed,
      sampleRate: 44100, dynamicsWorkletUrl: 'mock-dyn-url',
    })).resolves.toBeDefined()
  })

  it('accepts a linear-phase magnitude without throwing', async () => {
    const snap = engine.serialize()
    const mag = new Float32Array(4096 / 2 + 1).fill(1)
    await expect(renderMasterChain({
      engine, sourceBuffer: srcBuf(48000), params: snap.params, bypassed: snap.bypassed,
      sampleRate: 48000, linPhaseMag: mag, dynamicsWorkletUrl: 'mock-dyn-url',
    })).resolves.toBeDefined()
  })
})

describe('buildFreqGrid', () => {
  it('spans from near-zero to the Nyquist frequency over n+1 points', () => {
    const grid = buildFreqGrid(24000, 2048)
    expect(grid.length).toBe(2049)
    expect(grid[2048]).toBe(24000)
  })

  it('clamps the first bin above 0 — a biquad response is undefined at 0Hz', () => {
    const grid = buildFreqGrid(24000, 2048)
    expect(grid[0]).toBe(1)
  })

  it('is linearly spaced', () => {
    const grid = buildFreqGrid(24000, 4)
    expect(Array.from(grid)).toEqual([1, 6000, 12000, 18000, 24000])
  })

  it('scales with the given Nyquist frequency', () => {
    const grid44k = buildFreqGrid(22050, 2)
    const grid48k = buildFreqGrid(24000, 2)
    expect(grid44k[2]).toBe(22050)
    expect(grid48k[2]).toBe(24000)
  })
})
