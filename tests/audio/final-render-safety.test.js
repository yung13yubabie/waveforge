import { beforeEach, describe, expect, it, vi } from 'vitest'
import { terminalImpulse } from '../fixtures/audio-trust/signals.js'

vi.mock('../../src/js/audio/render-chain.js', () => ({
  renderMasterChain: vi.fn(), buildFreqGrid: vi.fn(), eqMagnitudeFromParams: vi.fn(),
}))
vi.mock('../../src/js/audio/true-peak-limiter.js', async importOriginal => {
  const original = await importOriginal()
  return { truePeakLimit: vi.fn(original.truePeakLimit) }
})
import { renderMasterChain } from '../../src/js/audio/render-chain.js'
import { truePeakLimit } from '../../src/js/audio/true-peak-limiter.js'
import { renderFinalMaster } from '../../src/js/audio/final-render.js'

describe('final render fails closed when requested PCM ceiling cannot be verified', () => {
  let source
  beforeEach(() => {
    source = new AudioContext().createBuffer(1, 4096, 48000)
    source.copyToChannel(terminalImpulse(), 0)
    renderMasterChain.mockResolvedValue(source)
  })
  const options = () => ({ engine: {}, sampleRate: 48000, truePeak: true,
    snapshot: { params: { limCeiling: -1 }, bypassed: { eq: true, limiter: false } } })
  it('measures after limiting and returns explicit estimator metadata', async () => {
    const result = await renderFinalMaster({ ...options(), sourceBuffer: source })
    expect(result.report.truePeakDb).toBeLessThanOrEqual(-1 + 1e-6)
    expect(result.report.truePeakVerifiedPreEncode).toBe(true)
    expect(result.report.truePeakVerificationStage).toBe('pre-encode-float-pcm')
    expect(result.report.truePeakMethod).toBe('4x-windowed-sinc-12tap')
  })
  it('checks the final signal after watermark processing', async () => {
    const result = await renderFinalMaster({ ...options(), sourceBuffer: source, watermark: 'synthetic-QC' })
    expect(result.report.watermark).toBe(true)
    expect(result.report.truePeakDb).toBeLessThanOrEqual(-1 + 1e-6)
  })
  it('blocks an unsafe passthrough from a regressed limiter', async () => {
    truePeakLimit.mockImplementationOnce(channels => channels)
    await expect(renderFinalMaster({ ...options(), sourceBuffer: source })).rejects.toThrow(/校驗失敗/)
  })
  it('does not claim verification when the user bypasses the limiter', async () => {
    const config = options(); config.snapshot.bypassed.limiter = true
    const result = await renderFinalMaster({ ...config, sourceBuffer: source })
    expect(result.report.truePeakVerifiedPreEncode).toBe(false)
    expect(result.report.truePeakLimiter).toBe(false)
  })
})

// This negative case preserves the boundary of our claim: integer WAV dither
// happens AFTER the float-PCM ceiling check and can move it by a tiny amount.
import { encodeWAV } from '../../src/js/audio/wav.js'
import { measurePeaks } from '../../src/js/audio/measure.js'
it('records why seeded 16-bit dither requires post-encoding QC for a file-level guarantee', () => {
  const limited = truePeakLimit([terminalImpulse()], 48000, -1)
  expect(measurePeaks(limited).truePeakDb).toBeLessThan(-1)
  let draw = 0
  const random = vi.spyOn(Math, 'random').mockImplementation(() => draw++ % 2 === 0 ? 0.999999 : 0)
  try {
    const wav = new DataView(encodeWAV(limited, 48000, 16))
    const decoded = Float32Array.from({ length: limited[0].length }, (_, i) => wav.getInt16(44 + i * 2, true) / 32768)
    const peak = measurePeaks([decoded]).truePeakDb
    expect(peak).toBeGreaterThan(-1)
    expect(peak).toBeLessThan(-0.999)
  } finally { random.mockRestore() }
})
