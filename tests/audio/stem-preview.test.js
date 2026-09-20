import { it, expect } from 'vitest'
import { createStemGraph, normalizeBuffer } from '../../src/js/audio/stem-mix.js'

it('uses the same live stem controls for EQ, dynamics and volume', () => {
  const ctx = new AudioContext()
  const graph = createStemGraph(ctx, { lowGain: 3, midGain: -2, highGain: 1, thresh: -18, ratio: 3 }, 0.4)
  expect(graph.low.gain.value).toBe(3)
  expect(graph.gain.gain.value).toBe(0.4)
  expect(graph.pan.pan.value).toBe(0)
  graph.update({ lowGain: 6, midGain: 0, highGain: -3, thresh: -12, ratio: 2 }, 0.7)
  expect(graph.low.gain.setTargetAtTime).toHaveBeenLastCalledWith(6, 0, 0.01)
  expect(graph.comp.threshold.setTargetAtTime).toHaveBeenLastCalledWith(-12, 0, 0.01)
  expect(graph.gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(0.7, 0, 0.01)
})
it('explicit normalization returns a new buffer without overwriting original', () => {
  const ctx = new AudioContext(), b = ctx.createBuffer(1, 2, 48000)
  b.copyToChannel(new Float32Array([2, -1]), 0)
  const out = normalizeBuffer(b)
  expect(out.getChannelData(0)[0]).toBeCloseTo(0.99)
  expect(out.getChannelData(0)[1]).toBeCloseTo(-0.495)
  expect(b.getChannelData(0)[0]).toBe(2)
})
