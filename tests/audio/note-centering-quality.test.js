// @vitest-environment node
// Real DSP integration on generated PCM. These numeric guards are deliberately
// scoped to these fixtures; they do not establish human-singing/listening quality.
import { describe, expect, it } from 'vitest'
import { planNoteCentering, combineNoteCenteringPlans } from '../../src/js/daw/note-centering.js'
import { acceptedFixtures, assessNoteCentering, generateNote, refusalFixtures } from '../../scripts/test-note-centering.mjs'

const assess = fixture => assessNoteCentering(fixture, planNoteCentering, combineNoteCenteringPlans)

describe('actual stable-note planner + YIN + Signalsmith synthetic audio', () => {
  for (const fixture of acceptedFixtures()) {
    it(`improves median F0 and preserves samples/rate: ${fixture.name}`, async () => {
      const result = await assess(fixture)
      expect(result.planAccepted, result.reason).toBe(true)
      expect(result.exactSampleCounts).toBe(true)
      expect(result.unchangedSampleRate).toBe(true)
      expect(result.inputUnchanged).toBe(true)
      expect(result.finiteOutput).toBe(true)
      expect(result.wasmMemoryBytes).toBeLessThan(8 * 1024 * 1024)
      if (fixture.channels.length === 2) expect(result.outputChannelsDifferent).toBe(true)
      for (const { yin, independentCorrelation: independent } of result.measurements) {
        expect(yin.outputVoicedFraction).toBeGreaterThan(0.95)
        expect(yin.outputMedianErrorCents).not.toBeNull()
        expect(Math.abs(yin.outputMedianErrorCents)).toBeLessThan(10)
        expect(Math.abs(yin.outputMedianErrorCents)).toBeLessThan(Math.abs(yin.inputMedianErrorCents) / 2)
        // Different estimator avoids validating a shift solely with the same
        // YIN function that chose its amount. The reference selects the octave.
        expect(independent.outputErrorCents.count).toBeGreaterThanOrEqual(5)
        expect(Math.abs(independent.outputErrorCents.median)).toBeLessThan(10)
        expect(Math.abs(independent.outputErrorCents.median)).toBeLessThan(Math.abs(independent.inputErrorCents.median) / 2)
        expect(independent.minimumOutputCorrelation).toBeGreaterThan(0.95)
        expect(yin.interiorShapeRmsErrorCents).toBeLessThan(5)
        if (fixture.name.startsWith('vibrato-')) {
          // A constant shift must retain the source contour rather than flatten
          // it into one pitch; compare the central 80% spread, not waveforms.
          expect(yin.interiorInputP90P10Cents).toBeGreaterThan(35)
          expect(yin.interiorOutputP90P10Cents / yin.interiorInputP90P10Cents).toBeGreaterThan(0.8)
          expect(yin.interiorOutputP90P10Cents / yin.interiorInputP90P10Cents).toBeLessThan(1.2)
        }
      }
    })
  }
})

describe('refusal gates use actual analyzed PCM', () => {
  for (const fixture of refusalFixtures()) {
    it(`refuses ${fixture.name} without rendering`, async () => {
      const result = await assess(fixture)
      expect(result.planAccepted).toBe(false)
      expect(result.reason).toBeTruthy()
      expect(result.measurements).toBeUndefined()
    })
  }
  it('refuses a narrow glide by temporal drift even when its spread is under 70c', async () => {
    const result = await assess({ name: 'narrow-glide', channels: [generateNote({ glideCents: 60 })] })
    expect(result.reason).toBe('pitch-drift')
    expect(result.diagnostics.spreadCents).toBeLessThan(70)
    expect(Math.abs(result.diagnostics.driftCents)).toBeGreaterThan(25)
  })
  it('refuses independently stable but different stereo pitches within renderer limits', async () => {
    const result = await assess({ name: 'stereo-disagreement', channels: [generateNote(), generateNote({ targetMidi: 58 })] })
    expect(result.planAccepted).toBe(false)
    expect(result.reason).toBe('stereo-pitch-disagreement')
    expect(result.measurements).toBeUndefined()
  })
  it('centers the mean of 19c-apart stereo channels without implying both hit the target', async () => {
    const result = await assess({ name: 'stereo-small-detune', channels: [generateNote(),
      generateNote({ detuneCents: 56, phase: 0.8, modulationDepth: 0.25, modulationHz: 3, harmonics: [0.6, 1, 0.25, 0.1] })] })
    expect(result.planAccepted).toBe(true)
    expect(result.diagnostics.centerDifferenceCents).toBeGreaterThan(18)
    expect(result.exactSampleCounts).toBe(true)
    for (const { independentCorrelation: measured } of result.measurements) {
      expect(Math.abs(measured.outputErrorCents.median)).toBeLessThan(15)
      expect(Math.abs(measured.outputErrorCents.median)).toBeLessThan(Math.abs(measured.inputErrorCents.median) / 2)
      expect(measured.pairedShiftErrorCents.p95Abs).toBeLessThan(5)
    }
    expect(Math.abs(result.measurements[1].independentCorrelation.outputErrorCents.median)).toBeGreaterThan(10)
  })
  it('refuses 21c-apart stereo channels just outside the consensus gate', async () => {
    const result = await assess({ name: 'stereo-consensus-boundary', channels: [generateNote(), generateNote({ detuneCents: 58 })] })
    expect(result.planAccepted).toBe(false)
    expect(result.reason).toBe('stereo-pitch-disagreement')
    expect(result.measurements).toBeUndefined()
  })
  it('refuses silent or noisy right channel instead of assuming left-channel isolation', async () => {
    for (const right of [new Float32Array(57600), refusalFixtures().find(fixture => fixture.name === 'deterministic-noise').channels[0]]) {
      const result = await assess({ name: 'stereo-unreliable', channels: [generateNote(), right] })
      expect(result.planAccepted).toBe(false)
      expect(result.reason).toBe('no-reliable-pitch')
      expect(result.measurements).toBeUndefined()
    }
  })
  it('retains the periodic-mixture counterexample instead of claiming monophony detection', async () => {
    const result = await assess({ name: 'ambiguous-periodic-mixture', targetMidi: 45,
      channels: [generateNote({ targetMidi: 45, harmonics: [1, 1, 1] })] })
    expect(result.planAccepted).toBe(true)
    // 110/220/330 Hz can be separate voices or harmonics of one source; no F0
    // threshold distinguishes those identical PCM interpretations.
    expect(result.diagnostics.reliableFraction).toBeGreaterThan(0.95)
  })
})
