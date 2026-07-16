// Tests the real src/js/audio/lufs-worklet.js, not a mirrored copy.
// The file is loaded as a `?url` asset in production and runs in AudioWorklet
// scope, so the three globals that scope provides are shimmed here and the
// module is imported for its registerProcessor side effect.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'

const SR = 48000
const QUANTUM = 128

const registry = {}

beforeAll(async () => {
  global.sampleRate = SR
  global.currentTime = 0
  global.AudioWorkletProcessor = class {
    constructor() {
      this.port = { postMessage: (m) => this.port.messages.push(m), onmessage: null, messages: [] }
    }
  }
  global.registerProcessor = (name, cls) => { registry[name] = cls }

  await import('../../src/js/audio/lufs-worklet.js')
})

/** Run `quanta` render quanta of a signal through the processor. */
function feed(proc, sampleAt, quanta, channels = 2) {
  let n = 0
  let last = null
  for (let q = 0; q < quanta; q++) {
    const inp = Array.from({ length: channels }, () => new Float32Array(QUANTUM))
    const out = Array.from({ length: channels }, () => new Float32Array(QUANTUM))
    for (let i = 0; i < QUANTUM; i++, n++) {
      const v = sampleAt(n)
      for (let c = 0; c < channels; c++) inp[c][i] = v
    }
    proc.process([inp], [out])
    last = { inp, out }
  }
  return last
}

const sine = (hz, amp) => (n) => Math.sin((2 * Math.PI * hz * n) / SR) * amp
const silence = () => 0
const dbfs = (db) => Math.pow(10, db / 20)

/** Quanta needed to fill the 400ms momentary window. */
const QUANTA_400MS = Math.ceil((SR * 0.4) / QUANTUM)

function newProc() {
  return new registry['lufs-processor']()
}

const lastReport = (proc) => proc.port.messages.at(-1)

describe('lufs-worklet registration', () => {
  it('registers under the name engine.js connects to', () => {
    expect(registry['lufs-processor']).toBeTypeOf('function')
  })
})

describe('LUFSProcessor.process', () => {
  let proc
  beforeEach(() => { proc = newProc() })

  it('passes audio through unchanged — it only measures', () => {
    const { inp, out } = feed(proc, sine(1000, 0.5), 1)
    expect(Array.from(out[0])).toEqual(Array.from(inp[0]))
    expect(Array.from(out[1])).toEqual(Array.from(inp[1]))
  })

  it('reports every 100ms of audio', () => {
    // 100ms @48kHz = 4800 samples = 37.5 quanta; the counter trips on the 38th.
    feed(proc, sine(1000, 0.5), 37)
    expect(proc.port.messages).toHaveLength(0)

    feed(proc, sine(1000, 0.5), 1)
    expect(proc.port.messages).toHaveLength(1)
    expect(lastReport(proc).type).toBe('lufs')
  })

  it('reports a 6 dB louder tone as 6 LU louder', () => {
    feed(proc, sine(1000, 0.1), QUANTA_400MS)
    const quiet = lastReport(proc).m

    const loud = newProc()
    feed(loud, sine(1000, 0.2), QUANTA_400MS)

    expect(lastReport(loud).m - quiet).toBeCloseTo(6.02, 1)
  })

  it('reports -Infinity for digital silence rather than a bogus floor', () => {
    feed(proc, silence, QUANTA_400MS)
    const r = lastReport(proc)

    expect(r.m).toBe(-Infinity)
    expect(r.tp).toBe(-Infinity)
  })

  it('attenuates sub-bass per the RLB high-pass stage', () => {
    // The 38Hz Butterworth high-pass means a 20Hz tone must read quieter than
    // a 1kHz tone of identical amplitude.
    feed(proc, sine(20, 0.5), QUANTA_400MS)
    const low = lastReport(proc).m

    const mid = newProc()
    feed(mid, sine(1000, 0.5), QUANTA_400MS)

    expect(low).toBeLessThan(lastReport(mid).m - 6)
  })

  it('boosts highs per the +4 dB shelf stage', () => {
    feed(proc, sine(10000, 0.1), QUANTA_400MS)
    const high = lastReport(proc).m

    const mid = newProc()
    feed(mid, sine(1000, 0.1), QUANTA_400MS)

    expect(high).toBeGreaterThan(lastReport(mid).m + 2)
  })

  it('ignores an empty input without throwing', () => {
    expect(() => proc.process([[]], [[]])).not.toThrow()
    expect(proc.process([[]], [[]])).toBe(true)
    expect(proc.process([], [[]])).toBe(true)
  })

  it('ignores a zero-length render quantum', () => {
    expect(proc.process([[new Float32Array(0)]], [[new Float32Array(0)]])).toBe(true)
    expect(proc.port.messages).toHaveLength(0)
  })

  it('keeps measuring when only one channel is connected', () => {
    feed(proc, sine(1000, dbfs(-20)), QUANTA_400MS, 1)
    expect(lastReport(proc).m).toBeCloseTo(-23.0, 1)
  })
})

// ITU-R BS.1770-4 §2 defines loudness as -0.691 + 10·log10(Σ G_i · z_i) with
// G = 1.0 for L and R. Averaging the channel powers instead of summing them
// read every stereo source 3.01 LU quiet, which silently pushed masters 3 dB
// hotter than their target. These are the published EBU Tech 3341 tones.
describe('EBU Tech 3341 calibration', () => {
  const momentaryOf = (amp, channels) => {
    const proc = newProc()
    feed(proc, sine(1000, amp), QUANTA_400MS, channels)
    return lastReport(proc).m
  }

  it('reads a stereo 1kHz tone at -23 dBFS as -23.0 LUFS', () => {
    expect(momentaryOf(dbfs(-23), 2)).toBeCloseTo(-23.0, 1)
  })

  it('reads a stereo 1kHz tone at -20 dBFS as -20.0 LUFS', () => {
    expect(momentaryOf(dbfs(-20), 2)).toBeCloseTo(-20.0, 1)
  })

  it('reads a single-channel 1kHz tone at -20 dBFS as -23.0 LUFS', () => {
    expect(momentaryOf(dbfs(-20), 1)).toBeCloseTo(-23.0, 1)
  })

  it('reads stereo 3 LU louder than mono at the same amplitude', () => {
    // The direct consequence of summing rather than averaging.
    expect(momentaryOf(dbfs(-20), 2) - momentaryOf(dbfs(-20), 1)).toBeCloseTo(3.01, 1)
  })
})

describe('true peak (BS.1770-4 Annex 2)', () => {
  it('detects an inter-sample peak above the sample peak', () => {
    const proc = newProc()
    // A sine landing between samples: worst case for a sample-peak meter.
    feed(proc, sine(SR / 4.03, 0.98), QUANTA_400MS)

    expect(lastReport(proc).tp).toBeGreaterThan(-0.3)
  })

  it('tracks the running maximum rather than the latest block', () => {
    const proc = newProc()
    feed(proc, sine(1000, 0.9), QUANTA_400MS)
    const loudPeak = lastReport(proc).tp

    // Quiet audio afterwards must not lower the reported true peak.
    feed(proc, sine(1000, 0.01), QUANTA_400MS)

    expect(lastReport(proc).tp).toBeCloseTo(loudPeak, 5)
  })
})

describe('integrated loudness gating', () => {
  it('gates out silence so a pause does not drag the integrated value down', () => {
    const proc = newProc()
    feed(proc, sine(1000, 0.1), QUANTA_400MS * 3)
    const toneOnly = lastReport(proc).i

    // 1.2s of digital silence sits far below the -70 LUFS absolute gate, so it
    // must not pull the integrated value toward -Infinity. Blocks straddling
    // the tone/silence boundary do count, so allow a fraction of a LU of drift.
    feed(proc, silence, QUANTA_400MS * 3)

    expect(lastReport(proc).i).toBeGreaterThan(toneOnly - 1.5)
  })

  it('reports -Infinity integrated when every block is gated out', () => {
    const proc = newProc()
    feed(proc, silence, QUANTA_400MS * 2)
    expect(lastReport(proc).i).toBe(-Infinity)
  })

  it('tracks momentary but keeps integrated stable across a level change', () => {
    const proc = newProc()
    feed(proc, sine(1000, 0.1), QUANTA_400MS * 2)
    const beforeI = lastReport(proc).i

    feed(proc, sine(1000, 0.4), QUANTA_400MS * 2)
    const after = lastReport(proc)

    // Momentary follows the new level immediately; integrated averages both.
    expect(after.m).toBeGreaterThan(beforeI + 6)
    expect(after.i).toBeGreaterThan(beforeI)
    expect(after.i).toBeLessThan(after.m)
  })
})

describe('reset', () => {
  it('clears loudness and true peak when the host sends reset', () => {
    const proc = newProc()
    feed(proc, sine(1000, 0.9), QUANTA_400MS)
    expect(lastReport(proc).tp).toBeGreaterThan(-3)

    proc.port.onmessage({ data: 'reset' })
    feed(proc, silence, QUANTA_400MS)

    const r = lastReport(proc)
    expect(r.m).toBe(-Infinity)
    expect(r.i).toBe(-Infinity)
    expect(r.tp).toBe(-Infinity)
  })

  it('ignores unrelated port messages', () => {
    const proc = newProc()
    feed(proc, sine(1000, 0.9), QUANTA_400MS)
    const before = lastReport(proc).tp

    proc.port.onmessage({ data: 'something-else' })
    feed(proc, silence, 1)

    expect(lastReport(proc).tp).toBeCloseTo(before, 5)
  })
})
