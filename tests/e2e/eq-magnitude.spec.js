/**
 * eqMagnitudeFromParams (src/js/audio/render-chain.js) — real Web Audio math.
 *
 * This function's entire job is to call BiquadFilterNode.getFrequencyResponse()
 * per band and multiply the results together. jsdom's Web Audio mock
 * (tests/setup.js) fills getFrequencyResponse with a flat 1.0 regardless of
 * gain/frequency/Q — a unit test against it could only ever see all-ones, so
 * any assertion about gain actually changing the response would be untestable
 * there and would have to be faked or dropped. This drives it in a real
 * browser instead, where getFrequencyResponse computes the actual transfer
 * function, matching this project's own stated convention (.ai/PHASE6_PLAN.md):
 * pure modules get unit tests, anything needing real Web Audio gets E2E.
 *
 * The function was previously dead code — zero callers anywhere in the app —
 * so this is also the first thing to ever exercise it at all.
 *
 * 執行：npx playwright install chromium && npm run test:e2e
 */
import { test, expect } from '@playwright/test'

const BAND_1K_INDEX = 5 // { freq: 1000, type: 'peaking' } in engine.js's EQ_BANDS
const SR = 48000
const FREQS = [1000]

function wavFixture({ seconds = 1, sampleRate = 44100, hz = 440 } = {}) {
  const frames = seconds * sampleRate
  const dataBytes = frames * 2 * 2
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(2, 22); buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * hz * i) / sampleRate) * 0.4 * 0x7fff)
    buf.writeInt16LE(v, 44 + i * 4); buf.writeInt16LE(v, 44 + i * 4 + 2)
  }
  return buf
}

async function loadEngine(page) {
  await page.goto('/')
  await page.setInputFiles('#file-input', { name: 'tone.wav', mimeType: 'audio/wav', buffer: wavFixture() })
  await page.waitForFunction(() => document.getElementById('export-btn')?.disabled === false, { timeout: 20000 })
  const bandCount = await page.evaluate(() => window.__wf.engine.eqBands.length)
  expect(bandCount).toBe(10)
}

/**
 * Call eqMagnitudeFromParams with every band flat except one, at the given
 * gain. `freqs` must become a real Float32Array inside the page — the real
 * BiquadFilterNode.getFrequencyResponse (unlike jsdom's untyped mock) throws
 * a TypeError on a plain array.
 */
function evalOneBandGain(page, bandIndex, gainDb, freqs = FREQS, sampleRate = SR) {
  return page.evaluate(
    ({ bandIndex, gainDb, freqs, sampleRate }) => {
      const gains = new Array(window.__wf.engine.eqBands.length).fill(0)
      gains[bandIndex] = gainDb
      return Array.from(
        window.__wf.eqMagnitudeFromParams(window.__wf.engine, gains, new Float32Array(freqs), sampleRate)
      )
    },
    { bandIndex, gainDb, freqs, sampleRate }
  )
}

test.describe('eqMagnitudeFromParams', () => {
  test('returns one magnitude value per requested frequency', async ({ page }) => {
    await loadEngine(page)
    const freqs = [100, 1000, 10000]
    const mag = await evalOneBandGain(page, BAND_1K_INDEX, 0, freqs)
    expect(mag.length).toBe(freqs.length)
  })

  test('an all-zero-gain EQ is unity gain at every frequency', async ({ page }) => {
    await loadEngine(page)
    const mag = await evalOneBandGain(page, BAND_1K_INDEX, 0, [50, 500, 1000, 5000, 15000])
    for (const m of mag) expect(m).toBeCloseTo(1.0, 2)
  })

  test('a positive gain on the 1kHz band raises magnitude at 1kHz', async ({ page }) => {
    await loadEngine(page)
    const flat = await evalOneBandGain(page, BAND_1K_INDEX, 0)
    const boosted = await evalOneBandGain(page, BAND_1K_INDEX, 6)
    expect(boosted[0]).toBeGreaterThan(flat[0])
  })

  test('a negative gain on the 1kHz band lowers magnitude at 1kHz', async ({ page }) => {
    await loadEngine(page)
    const flat = await evalOneBandGain(page, BAND_1K_INDEX, 0)
    const cut = await evalOneBandGain(page, BAND_1K_INDEX, -6)
    expect(cut[0]).toBeLessThan(flat[0])
  })

  test('a missing gains[i] defaults to 0dB, same as an explicit 0', async ({ page }) => {
    await loadEngine(page)
    const explicitZero = await evalOneBandGain(page, BAND_1K_INDEX, 0)

    const omitted = await page.evaluate(
      ({ freqs, sampleRate }) => {
        const shortGains = [] // shorter than eqBands.length — every index is `undefined`
        return Array.from(
          window.__wf.eqMagnitudeFromParams(window.__wf.engine, shortGains, new Float32Array(freqs), sampleRate)
        )
      },
      { freqs: FREQS, sampleRate: SR }
    )

    expect(omitted[0]).toBeCloseTo(explicitZero[0], 6)
  })

  test('boosting two bands compounds their magnitude at an overlapping frequency', async ({ page }) => {
    await loadEngine(page)
    const oneBoosted = await evalOneBandGain(page, BAND_1K_INDEX, 6)

    const twoBoosted = await page.evaluate(
      ({ bandIndex, freqs, sampleRate }) => {
        const gains = new Array(window.__wf.engine.eqBands.length).fill(0)
        gains[bandIndex] = 6
        gains[bandIndex + 1] = 6 // 2kHz band, adjacent enough to overlap at 1kHz
        return Array.from(
          window.__wf.eqMagnitudeFromParams(window.__wf.engine, gains, new Float32Array(freqs), sampleRate)
        )
      },
      { bandIndex: BAND_1K_INDEX, freqs: FREQS, sampleRate: SR }
    )

    // Bands multiply (mag[k] *= tmpMag[k]) — adding a second boosted band must
    // raise the response further, not leave it unchanged or lower it.
    expect(twoBoosted[0]).toBeGreaterThan(oneBoosted[0])
  })
})
