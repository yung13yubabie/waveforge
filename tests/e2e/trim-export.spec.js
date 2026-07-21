/**
 * Trim round-trip — dragging a region on the waveform must actually shorten
 * the exported file, and clearing the region must restore full length.
 *
 * Unit tests (tests/audio/trim.test.js) prove trimBuffer's math in isolation.
 * They cannot prove a real drag on the WaveSurfer regions plugin produces a
 * region, that the region reaches the export handler, or that the UI resets
 * correctly — only driving the actual browser can.
 *
 * 執行：npx playwright install chromium && npm run test:e2e
 */
import { test, expect } from '@playwright/test'

const DURATION_SEC = 4

/** A N-second 16-bit stereo 44.1kHz WAV of a 440Hz tone. */
function wavFixture({ seconds = DURATION_SEC, sampleRate = 44100, hz = 440 } = {}) {
  const frames = seconds * sampleRate
  const dataBytes = frames * 2 * 2
  const buf = Buffer.alloc(44 + dataBytes)

  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(2, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 4, 28)
  buf.writeUInt16LE(4, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataBytes, 40)

  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * hz * i) / sampleRate) * 0.4 * 0x7fff)
    buf.writeInt16LE(v, 44 + i * 4)
    buf.writeInt16LE(v, 44 + i * 4 + 2)
  }
  return buf
}

async function loadFixture(page) {
  await page.goto('/')
  await page.setInputFiles('#file-input', {
    name: 'tone.wav',
    mimeType: 'audio/wav',
    buffer: wavFixture(),
  })
  await expect(page.locator('#export-btn')).toBeEnabled({ timeout: 20_000 })
  await expect(page.locator('#trim-toggle')).toBeEnabled()
}

async function exportAndRead(page) {
  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
  await page.click('#export-btn')
  const download = await downloadPromise
  const stream = await download.createReadStream()
  const chunks = []
  for await (const c of stream) chunks.push(c)
  return Buffer.concat(chunks)
}

/**
 * WAV duration in seconds, reading channel count / rate / bit depth from the
 * header rather than assuming them — the export UI defaults to 24-bit, and a
 * hardcoded 16-bit divisor previously made a correct 2s export look like 3s.
 */
function wavDurationSec(bytes) {
  const channels = bytes.readUInt16LE(22)
  const sampleRate = bytes.readUInt32LE(24)
  const bitsPerSample = bytes.readUInt16LE(34)
  const dataBytes = bytes.readUInt32LE(40)
  return dataBytes / (sampleRate * channels * (bitsPerSample / 8))
}

/**
 * Drag a selection across the given fraction of the waveform's width.
 *
 * Must use WaveSurfer's own wrapper rect, not #waveform-main's: the
 * container is stretched taller by its flex layout (230px) than the
 * WaveSurfer canvas it holds (80px), so a drag aimed at the container's
 * midpoint lands in empty space below the canvas and never reaches the
 * regions plugin's pointerdown listener.
 */
async function dragTrimRegion(page, fromFrac, toFrac) {
  await page.click('#trim-toggle')
  const box = await page.evaluate(() => window.__wf.ws.getWrapper().getBoundingClientRect().toJSON())
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width * fromFrac, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * toFrac, y, { steps: 10 })
  await page.mouse.up()
}

test.describe('trim round-trip', () => {
  test('dragging a region shows the selected range', async ({ page }) => {
    await loadFixture(page)
    await dragTrimRegion(page, 0.25, 0.75)

    await expect(page.locator('#trim-range')).toBeVisible()
    await expect(page.locator('#trim-range')).not.toBeEmpty()
    await expect(page.locator('#trim-clear')).toBeEnabled()
  })

  test('exports only the selected range, not the full track', async ({ page }) => {
    await loadFixture(page)
    await dragTrimRegion(page, 0.25, 0.75)
    await page.selectOption('#export-format', 'wav')

    const bytes = await exportAndRead(page)
    const exportedSec = wavDurationSec(bytes)

    // A 25%-75% drag on a 4s source should land near 2s; allow slack for
    // pixel-to-time rounding and the region's own drag imprecision.
    expect(exportedSec).toBeGreaterThan(1.0)
    expect(exportedSec).toBeLessThan(3.0)
  })

  test('clearing the trim region restores full-length export', async ({ page }) => {
    await loadFixture(page)
    await dragTrimRegion(page, 0.25, 0.75)
    await page.click('#trim-clear')

    await expect(page.locator('#trim-range')).toBeHidden()
    await page.selectOption('#export-format', 'wav')

    const bytes = await exportAndRead(page)
    expect(wavDurationSec(bytes)).toBeCloseTo(DURATION_SEC, 1)
  })

  test('loading a new file drops any prior trim selection', async ({ page }) => {
    await loadFixture(page)
    await dragTrimRegion(page, 0.25, 0.75)
    await expect(page.locator('#trim-range')).toBeVisible()

    await page.setInputFiles('#file-input', {
      name: 'tone2.wav',
      mimeType: 'audio/wav',
      buffer: wavFixture(),
    })
    await expect(page.locator('#export-btn')).toBeEnabled({ timeout: 20_000 })

    await expect(page.locator('#trim-range')).toBeHidden()
  })
})
