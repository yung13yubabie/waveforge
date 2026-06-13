// Tests for the offline export-report measurements (src/js/audio/measure.js).
import { describe, it, expect } from 'vitest'
import { measureIntegratedLUFS, measurePeaks, buildExportReport, correlation } from '../../src/js/audio/measure.js'

const SR = 48000

function sine(freq, amp, dur, phase = 0) {
  const n = Math.round(SR * dur)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * freq * i / SR + phase)
  return x
}

describe('measureIntegratedLUFS', () => {
  it('returns -Infinity for silence', () => {
    expect(measureIntegratedLUFS([new Float32Array(SR)], SR)).toBe(-Infinity)
  })

  it('returns -Infinity for an empty buffer', () => {
    expect(measureIntegratedLUFS([new Float32Array(0)], SR)).toBe(-Infinity)
  })

  it('measures a 1kHz tone in a sane LUFS range', () => {
    const x = sine(1000, 0.5, 2)
    const lufs = measureIntegratedLUFS([x, x], SR)
    expect(Number.isFinite(lufs)).toBe(true)
    expect(lufs).toBeGreaterThan(-20)
    expect(lufs).toBeLessThan(0)
  })

  it('is monotonic: louder signal → higher LUFS', () => {
    const quiet = sine(1000, 0.1, 2)
    const loud  = sine(1000, 0.6, 2)
    expect(measureIntegratedLUFS([loud, loud], SR))
      .toBeGreaterThan(measureIntegratedLUFS([quiet, quiet], SR))
  })

  it('a +6 dB amplitude increase raises LUFS by ~6 LU', () => {
    const a = sine(1000, 0.25, 2)
    const b = sine(1000, 0.5, 2)   // +6 dB
    const d = measureIntegratedLUFS([b, b], SR) - measureIntegratedLUFS([a, a], SR)
    expect(d).toBeGreaterThan(5)
    expect(d).toBeLessThan(7)
  })
})

describe('measurePeaks', () => {
  it('detects inter-sample peaks above the sample peak', () => {
    // fs/4 @45°: sample peak ≈ -3 dB, true peak ≈ 0 dB
    const x = sine(12000, 1.0, 0.2, Math.PI / 4)
    const { samplePeakDb, truePeakDb } = measurePeaks([x])
    expect(samplePeakDb).toBeLessThan(-2)
    expect(truePeakDb).toBeGreaterThan(samplePeakDb + 1.5)
    expect(truePeakDb).toBeGreaterThan(-1)
  })

  it('flags clipping when a sample hits full scale', () => {
    const x = new Float32Array([0, 0.5, 1.0, -1.0, 0.2])
    expect(measurePeaks([x]).clipped).toBe(true)
  })

  it('does not flag clipping for a -6 dB signal', () => {
    const x = sine(1000, 0.5, 0.1)
    expect(measurePeaks([x]).clipped).toBe(false)
  })

  it('silence → -Infinity peaks, no clip', () => {
    const r = measurePeaks([new Float32Array(256)])
    expect(r.samplePeakDb).toBe(-Infinity)
    expect(r.clipped).toBe(false)
  })
})

describe('correlation (stereo phase meter)', () => {
  it('identical channels (mono) → +1', () => {
    const x = sine(1000, 0.5, 0.05)
    expect(correlation(x, x)).toBeCloseTo(1, 6)
  })

  it('inverted channel (anti-phase) → −1', () => {
    const x = sine(1000, 0.5, 0.05)
    const inv = x.map(v => -v)
    expect(correlation(x, inv)).toBeCloseTo(-1, 6)
  })

  it('independent tones (decorrelated) → near 0', () => {
    const l = sine(1000, 0.5, 0.2)
    const r = sine(7777, 0.5, 0.2)   // unrelated frequency
    expect(Math.abs(correlation(l, r))).toBeLessThan(0.2)
  })

  it('silence → 0 (no divide-by-zero)', () => {
    expect(correlation(new Float32Array(128), new Float32Array(128))).toBe(0)
  })

  it('clamps to the [-1, 1] range', () => {
    const x = sine(1000, 1.0, 0.05)
    const c = correlation(x, x)
    expect(c).toBeLessThanOrEqual(1)
    expect(c).toBeGreaterThanOrEqual(-1)
  })
})

describe('buildExportReport', () => {
  it('reports on-target loudness within ±1 LU', () => {
    // tune amplitude so a 1kHz tone lands near -14 LUFS
    const x = sine(1000, 0.5, 2)
    const measured = measureIntegratedLUFS([x, x], SR)
    const report = buildExportReport([x, x], SR, { targetLUFS: Math.round(measured), ceilingDb: -1 })
    expect(report.lufsNote).toContain('達標')
  })

  it('warns when loudness is off target', () => {
    const x = sine(1000, 0.05, 2)  // very quiet
    const report = buildExportReport([x, x], SR, { targetLUFS: -14, ceilingDb: -1 })
    expect(report.lufsNote).toContain('低於目標')
  })

  it('warns on clipping and true-peak ceiling breach', () => {
    // full-scale inter-sample-peak signal → clips AND exceeds a -1 ceiling
    const x = sine(12000, 1.0, 0.3, Math.PI / 4)
    const report = buildExportReport([x, x], SR, { targetLUFS: null, ceilingDb: -1 })
    expect(report.warnings.length).toBeGreaterThan(0)
    expect(report.warnings.some(w => w.includes('True Peak'))).toBe(true)
  })

  it('clean signal under ceiling produces no warnings', () => {
    const x = sine(1000, 0.4, 1)
    const report = buildExportReport([x, x], SR, { targetLUFS: null, ceilingDb: -1 })
    expect(report.warnings).toEqual([])
  })
})
