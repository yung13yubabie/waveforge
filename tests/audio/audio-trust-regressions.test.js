import { describe, expect, it } from 'vitest'
import { detectKey } from '../../src/js/audio/analyze.js'
import { measurePeaks, buildExportReport, measureIntegratedLUFS } from '../../src/js/audio/measure.js'
import { truePeakLimit } from '../../src/js/audio/true-peak-limiter.js'
import { assertTruePeakCeiling } from '../../src/js/audio/true-peak.js'
import { averageSpectrum, computeMatchCurve } from '../../src/js/audio/match-eq.js'
import { TEST_RATES, lateMajorChord, terminalImpulse, interSampleSine, tonalBalance, bufferLike } from '../fixtures/audio-trust/signals.js'

describe('key analysis actually samples its declared range', () => {
  it.each(TEST_RATES)('detects a late-entry C-major chord at %i Hz', sampleRate => {
    const result = detectKey(lateMajorChord(sampleRate))
    expect(result.key).toBe('C')
    expect(result.scale).toBe('大調')
    expect(result.analysis.endSeconds).toBe(30)
    expect(result.analysis.windowCount).toBe(8)
  })
  it.each(TEST_RATES)('keeps silence uncertain at %i Hz', sampleRate => {
    const result = detectKey(bufferLike(new Float32Array(sampleRate * 5), sampleRate))
    expect(result.key).toBeNull()
    expect(result.confidence).toBe(0)
  })
  it('bounds work and reports the actual short-file range', () => {
    const result = detectKey(lateMajorChord(48000, { duration: 2, silence: 0.2 }))
    expect(result.analysis.endSeconds).toBe(2)
    expect(result.analysis.windowCount).toBeLessThanOrEqual(8)
  })
})

describe('finite-buffer peak safety', () => {
  it('never reports less than the last sample and warns before limiting', () => {
    const signal = terminalImpulse()
    const report = buildExportReport([signal], 48000, { ceilingDb: -1 })
    // Independent lower bound: the reconstruction contains the original sample.
    expect(report.truePeakDb).toBeGreaterThanOrEqual(20 * Math.log10(signal.at(-1)))
    expect(report.warnings.some(w => w.includes('True Peak'))).toBe(true)
  })
  it.each(Array.from({ length: 12 }, (_, i) => i))('flushes a transient %i samples from EOF', fromEnd => {
    const signal = terminalImpulse(4096, 0.999, fromEnd)
    const padded = new Float32Array(signal.length + 32); padded.set(signal)
    expect(measurePeaks([signal]).truePeakDb).toBeCloseTo(measurePeaks([padded]).truePeakDb, 9)
  })
  for (const sampleRate of TEST_RATES) {
    it.each([0.999, -0.999, 1.4])(`limits EOF sample at ${sampleRate} Hz, amplitude %s`, amplitude => {
      const signal = terminalImpulse(4096, amplitude)
      const result = truePeakLimit([signal], sampleRate, -1)
      expect(Math.abs(result[0].at(-1))).toBeLessThanOrEqual(10 ** (-1 / 20) * (1 + 1e-7))
      expect(measurePeaks(result).truePeakDb).toBeLessThanOrEqual(-1 + 1e-6)
      expect(result[0].length).toBe(signal.length)
      expect(signal.at(-1)).toBeCloseTo(amplitude, 6)
    })
    it.each([1, 1.4, 2])(`closes measured ISP overshoot at ${sampleRate} Hz, amplitude %s`, amplitude => {
      const signal = interSampleSine(8000, amplitude)
      const result = truePeakLimit([signal, signal], sampleRate, -1)
      expect(measurePeaks(result).truePeakDb).toBeLessThanOrEqual(-1 + 1e-6)
      expect(result[0]).toEqual(result[1])
      expect(() => assertTruePeakCeiling(result, -1)).not.toThrow()
    })
  }
  it('rejects non-finite samples and mismatched channels', () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(() => measurePeaks([new Float32Array([value])])).toThrow(/非有限/)
      expect(() => truePeakLimit([new Float32Array([value])], 48000, -1)).toThrow(/非有限/)
    }
    expect(() => truePeakLimit([new Float32Array(2), new Float32Array(3)], 48000, -1)).toThrow(/長度/)
  })
  it('does not turn a failed ceiling check into a successful export', () => {
    expect(() => assertTruePeakCeiling([terminalImpulse()], -1)).toThrow(/校驗失敗/)
  })
  it('handles silence and empty input without gain or NaN', () => {
    expect(truePeakLimit([new Float32Array(0)], 48000, -1)[0].length).toBe(0)
    expect(measurePeaks(truePeakLimit([new Float32Array(5)], 48000, -1)).truePeakDb).toBe(-Infinity)
  })
})

describe('native-rate reference analysis oracle', () => {
  const bands = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
  const reference = tonalBalance(48000)
  it.each(TEST_RATES)('same tonal balance at %i Hz does not need major EQ changes', sampleRate => {
    const source = tonalBalance(sampleRate)
    const curve = computeMatchCurve(averageSpectrum([source.getChannelData(0)], source.sampleRate, bands),
      averageSpectrum([reference.getChannelData(0)], reference.sampleRate, bands))
    // Fixed-size FFT bins differ slightly between rates; tolerate <0.5 dB,
    // rather than the wrong-rate regression's roughly 10–12 dB false correction.
    for (const band of [4, 5, 6, 7]) expect(Math.abs(curve[band])).toBeLessThan(0.5)
    expect(Math.abs(measureIntegratedLUFS([source.getChannelData(0)], source.sampleRate) -
      measureIntegratedLUFS([reference.getChannelData(0)], reference.sampleRate))).toBeLessThan(0.08)
  })
})

it('describes range and actual sampled time even for silence or a too-short file', () => {
  for (const length of [100, 48000 * 30]) {
    const result = detectKey(bufferLike(new Float32Array(length), 48000))
    expect(result.analysis.endSeconds).toBe(length / 48000)
    expect(result.analysis.sampledSeconds).toBe(result.analysis.windowCount * result.analysis.windowDurationSeconds)
    expect(result.analysis.sampledSeconds).toBeLessThanOrEqual(result.analysis.endSeconds)
    expect(result.key).toBeNull()
  }
})

it.each(Array.from({ length: 12 }, (_, i) => i))('handles a %i-sample clip without hiding endpoint energy', length => {
  const signal = new Float32Array(length)
  if (length) signal[length - 1] = 0.999
  const result = truePeakLimit([signal], 48000, -1)
  expect(result[0].length).toBe(length)
  expect(() => assertTruePeakCeiling(result, -1)).not.toThrow()
})

it('uses one linked gain for different stereo waveforms', () => {
  const loud = interSampleSine(1024, 1.4)
  const quiet = Float32Array.from({ length: 1024 }, (_, i) => 0.1 + 0.03 * Math.sin(i * 0.17))
  const [left, right] = truePeakLimit([loud, quiet], 48000, -1)
  for (let i = 0; i < loud.length; i++) expect(left[i] / loud[i]).toBeCloseTo(right[i] / quiet[i], 6)
})
