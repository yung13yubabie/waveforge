import { describe, it, expect, afterEach, vi } from 'vitest'
import { processStem, mixBuffers } from '../../src/js/audio/stem-mix.js'

const SR = 48000

/** Minimal AudioBuffer stand-in holding the given channel data. */
function bufferOf(...channels) {
  return {
    numberOfChannels: channels.length,
    length: channels[0].length,
    sampleRate: SR,
    getChannelData: (c) => channels[c],
  }
}

const DEFAULT_PARAMS = { lowGain: 0, midGain: 0, highGain: 0, thresh: -24, ratio: 4 }

afterEach(() => vi.unstubAllGlobals())

describe('mixBuffers', () => {
  it('returns null when there is nothing to mix', () => {
    expect(mixBuffers([])).toBeNull()
    expect(mixBuffers([null, null, null, null])).toBeNull()
  })

  it('sums overlapping stems sample by sample', () => {
    const a = bufferOf(new Float32Array([0.1, 0.2, 0.3]))
    const b = bufferOf(new Float32Array([0.2, 0.1, 0.1]))

    const out = mixBuffers([a, b])

    expect(Array.from(out.getChannelData(0))).toEqual(
      [0.1 + 0.2, 0.2 + 0.1, 0.3 + 0.1].map((v) => Math.fround(v))
    )
  })

  it('skips null stems instead of throwing', () => {
    const a = bufferOf(new Float32Array([0.5, 0.5]))

    const out = mixBuffers([null, a, null, null])

    expect(Array.from(out.getChannelData(0))).toEqual([0.5, 0.5])
  })

  it('preserves over-full-scale samples without hidden normalization', () => {
    const a = bufferOf(new Float32Array([0.8, 0.4]))
    const b = bufferOf(new Float32Array([0.8, 0.4]))

    // Sum peaks at 1.6 — well past full scale.
    const out = mixBuffers([a, b])
    const data = out.getChannelData(0)

    expect(Math.max(...data.map(Math.abs))).toBeCloseTo(1.6, 5)
    // Normalization must be a uniform scale, so the 2:1 ratio is preserved.
    expect(data[0] / data[1]).toBeCloseTo(2.0, 5)
  })

  it('preserves negative overload too', () => {
    const a = bufferOf(new Float32Array([-1.5, 0.3]))

    const out = mixBuffers([a])

    expect(out.getChannelData(0)[0]).toBeCloseTo(-1.5, 5)
  })

  it('leaves a mix that fits below full scale untouched', () => {
    const a = bufferOf(new Float32Array([0.5, 0.25]))

    const out = mixBuffers([a])

    expect(Array.from(out.getChannelData(0))).toEqual([0.5, 0.25])
  })

  it('sizes the mix to the longest stem', () => {
    const short = bufferOf(new Float32Array([0.1, 0.1]))
    const long = bufferOf(new Float32Array([0.1, 0.1, 0.1, 0.1]))

    const out = mixBuffers([short, long])

    expect(out.length).toBe(4)
  })

  it('mixes every channel of a stereo stem', () => {
    const a = bufferOf(new Float32Array([0.1, 0.1]), new Float32Array([0.2, 0.2]))
    const b = bufferOf(new Float32Array([0.1, 0.1]), new Float32Array([0.2, 0.2]))

    const out = mixBuffers([a, b])

    expect(out.numberOfChannels).toBe(2)
    expect(out.getChannelData(0)[0]).toBeCloseTo(0.2, 5)
    expect(out.getChannelData(1)[0]).toBeCloseTo(0.4, 5)
  })
})

describe('processStem', () => {
  /** Record every node an OfflineAudioContext hands out so params are inspectable. */
  function spyOnContext() {
    const made = { biquads: [], gains: [], comps: [], connections: [] }
    const Base = global.OfflineAudioContext

    class SpyCtx extends Base {
      createBiquadFilter() {
        const n = super.createBiquadFilter()
        made.biquads.push(n)
        return n
      }
      createGain() {
        const n = super.createGain()
        made.gains.push(n)
        return n
      }
      createDynamicsCompressor() {
        const n = super.createDynamicsCompressor()
        made.comps.push(n)
        return n
      }
    }
    vi.stubGlobal('OfflineAudioContext', SpyCtx)
    return made
  }

  it('returns null for a missing stem rather than rendering silence', async () => {
    await expect(processStem(null, DEFAULT_PARAMS, 1)).resolves.toBeNull()
  })

  it('renders a buffer for a present stem', async () => {
    const out = await processStem(bufferOf(new Float32Array(128)), DEFAULT_PARAMS, 1)
    expect(out).not.toBeNull()
    expect(out.sampleRate).toBe(SR)
  })

  it('builds a three-band EQ at the documented frequencies', async () => {
    const made = spyOnContext()

    await processStem(bufferOf(new Float32Array(128)), DEFAULT_PARAMS, 1)

    expect(made.biquads.map((b) => b.type)).toEqual(['lowshelf', 'peaking', 'highshelf'])
    expect(made.biquads.map((b) => b.frequency.value)).toEqual([200, 1000, 8000])
  })

  it('applies the per-band gains from params', async () => {
    const made = spyOnContext()

    await processStem(
      bufferOf(new Float32Array(128)),
      { lowGain: 3, midGain: -2, highGain: 4.5, thresh: -24, ratio: 4 },
      1
    )

    expect(made.biquads.map((b) => b.gain.value)).toEqual([3, -2, 4.5])
  })

  it('applies the compressor threshold and ratio from params', async () => {
    const made = spyOnContext()

    await processStem(
      bufferOf(new Float32Array(128)),
      { ...DEFAULT_PARAMS, thresh: -18, ratio: 8 },
      1
    )

    expect(made.comps[0].threshold.value).toBe(-18)
    expect(made.comps[0].ratio.value).toBe(8)
  })

  it('applies the per-stem volume as output gain', async () => {
    const made = spyOnContext()

    await processStem(bufferOf(new Float32Array(128)), DEFAULT_PARAMS, 0.35)

    expect(made.gains[0].gain.value).toBe(0.35)
  })

  it('renders at the source buffer geometry', async () => {
    const out = await processStem(bufferOf(new Float32Array(256), new Float32Array(256)), DEFAULT_PARAMS, 1)

    expect(out.length).toBe(256)
  })
})
