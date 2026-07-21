/**
 * Album per-track linear-phase EQ.
 *
 * The risk this specifically guards against: eqMagnitudeFromParams needs
 * `engine` only for its static band metadata (type/frequency/Q — identical
 * across every track), but the per-track GAINS must come from that track's
 * own frozen snapshot. Passing the live engine's current gains instead would
 * silently apply whatever track happens to be loaded in the main view to
 * every album track's FIR — and because render-chain.js zeroes the biquad
 * gain whenever linear-phase is active, that mistake would be invisible in
 * the biquad EQ (which isn't touched) and only show up in the FIR output.
 *
 * 執行：npx playwright install chromium && npm run test:e2e
 */
import { test, expect } from '@playwright/test'

const SR = 44100
const BAND_1K_INDEX = 5 // { freq: 1000, type: 'peaking' } in engine.js's EQ_BANDS
const BAND_COUNT = 10

function toneWav(hz, seconds = 0.3, sampleRate = SR) {
  const frames = Math.round(seconds * sampleRate)
  const dataBytes = frames * 2 * 2
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(2, 22); buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * hz * i) / sampleRate) * 0.3 * 0x7fff)
    buf.writeInt16LE(v, 44 + i * 4); buf.writeInt16LE(v, 44 + i * 4 + 2)
  }
  return buf
}

function gainsWith(bandIndex, db) {
  const g = new Array(BAND_COUNT).fill(0)
  g[bandIndex] = db
  return g
}

async function loadAnyFile(page) {
  await page.goto('/')
  await page.setInputFiles('#file-input', { name: 'x.wav', mimeType: 'audio/wav', buffer: toneWav(440) })
  await page.waitForFunction(() => document.getElementById('export-btn')?.disabled === false, { timeout: 20000 })
}

/** The EQ module card starts collapsed (.module-body is display:none until
 * .module-card gets .expanded) — #eq-linphase is unreachable without this. */
async function expandEQCard(page) {
  await page.click('#mod-eq .module-head')
  await expect(page.locator('#eq-linphase')).toBeVisible()
}

/** Render a synthetic track through window.__wf_renderAlbumTrack and return its RMS. */
function renderTrackRMS(page, { wavBytes, eqGains, liveEqGains }) {
  return page.evaluate(
    async ({ wavBytes, eqGains, liveEqGains }) => {
      // Point the live engine somewhere else first — the track render must
      // ignore this and use only its own snapshot.
      if (liveEqGains) {
        liveEqGains.forEach((g, i) => window.__wf.engine.setEQBand(i, g))
      }

      const file = new File([new Uint8Array(wavBytes)], 'tone.wav', { type: 'audio/wav' })
      const baseSnapshot = window.__wf.engine.serialize()
      const track = {
        title: 't', file, gainTrimDb: 0,
        snapshot: { ...baseSnapshot, params: { ...baseSnapshot.params, eqGains } },
      }

      const rendered = await window.__wf_renderAlbumTrack(track)
      const d = rendered.getChannelData(0)
      let sumSq = 0
      for (let i = 0; i < d.length; i++) sumSq += d[i] * d[i]
      return Math.sqrt(sumSq / d.length)
    },
    { wavBytes: Array.from(wavBytes), eqGains, liveEqGains }
  )
}

test.describe('album per-track linear-phase EQ', () => {
  test('a boosted track renders louder than a flat track at linphase-on', async ({ page }) => {
    await loadAnyFile(page)
    await expandEQCard(page)
    await page.check('#eq-linphase')
    const tone = toneWav(1000)

    const flatRMS = await renderTrackRMS(page, { wavBytes: tone, eqGains: gainsWith(BAND_1K_INDEX, 0) })
    const boostedRMS = await renderTrackRMS(page, { wavBytes: tone, eqGains: gainsWith(BAND_1K_INDEX, 12) })

    // +12dB at the tone's own frequency should be unmistakable, not a rounding blip.
    expect(boostedRMS).toBeGreaterThan(flatRMS * 1.5)
  })

  test('a track\'s render is unaffected by whatever gains the live engine currently shows', async ({ page }) => {
    await loadAnyFile(page)
    await expandEQCard(page)
    await page.check('#eq-linphase')
    const tone = toneWav(1000)
    const trackGains = gainsWith(BAND_1K_INDEX, 12)

    const withLiveFlat = await renderTrackRMS(page, {
      wavBytes: tone, eqGains: trackGains, liveEqGains: new Array(BAND_COUNT).fill(0),
    })
    const withLiveCut = await renderTrackRMS(page, {
      wavBytes: tone, eqGains: trackGains, liveEqGains: gainsWith(BAND_1K_INDEX, -12),
    })

    // Same track snapshot, two different (wrong) live-engine states in between
    // — the render must come out identical either way.
    expect(withLiveCut).toBeCloseTo(withLiveFlat, 3)
  })

  test('linphase-off still applies each track\'s own gains via the biquad path', async ({ page }) => {
    await loadAnyFile(page)
    await expandEQCard(page)
    await page.uncheck('#eq-linphase')
    const tone = toneWav(1000)

    const flatRMS = await renderTrackRMS(page, { wavBytes: tone, eqGains: gainsWith(BAND_1K_INDEX, 0) })
    const boostedRMS = await renderTrackRMS(page, { wavBytes: tone, eqGains: gainsWith(BAND_1K_INDEX, 12) })

    expect(boostedRMS).toBeGreaterThan(flatRMS * 1.5)
  })
})
