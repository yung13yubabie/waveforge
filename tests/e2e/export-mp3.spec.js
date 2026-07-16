/**
 * Export round-trip — the browser must actually hand the user a file.
 *
 * Unit tests prove the encoders work in isolation. They cannot prove the
 * bundled app downloads anything: lamejs 1.2.1 encoded fine in its own tests
 * but threw "MPEGMode is not defined" once bundled, so every MP3 export failed
 * in the browser while the suite stayed green. This test drives the real UI.
 *
 * 執行：npx playwright install chromium && npm run test:e2e
 */
import { test, expect } from '@playwright/test'

/** A 1-second 16-bit stereo 44.1kHz WAV of a 440Hz tone. */
function wavFixture({ seconds = 1, sampleRate = 44100, hz = 440 } = {}) {
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
}

/** Click export and return the downloaded filename plus its first bytes. */
async function exportAndRead(page) {
  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
  await page.click('#export-btn')
  const download = await downloadPromise
  const stream = await download.createReadStream()
  const chunks = []
  for await (const c of stream) chunks.push(c)
  return { name: download.suggestedFilename(), bytes: Buffer.concat(chunks) }
}

test.describe('export round-trip', () => {
  test('downloads a real MP3 when MP3 is selected', async ({ page }) => {
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))

    await loadFixture(page)
    await page.selectOption('#export-format', 'mp3')

    const { name, bytes } = await exportAndRead(page)

    expect(name).toMatch(/\.mp3$/)
    expect(bytes.length).toBeGreaterThan(1000)
    // MP3 frame sync: 0xFF followed by 11 set sync bits.
    expect(bytes[0]).toBe(0xff)
    expect(bytes[1] & 0xe0).toBe(0xe0)
    expect(errors).toEqual([])
  })

  test('names the MP3 after the source file and bitrate', async ({ page }) => {
    await loadFixture(page)
    await page.selectOption('#export-format', 'mp3')
    await page.selectOption('#export-mp3-bitrate', '320')

    const { name } = await exportAndRead(page)

    expect(name).toBe('tone_master_320kbps.mp3')
  })

  test('does not report a failure status after an MP3 export', async ({ page }) => {
    await loadFixture(page)
    await page.selectOption('#export-format', 'mp3')
    await exportAndRead(page)

    await expect(page.locator('body')).not.toContainText('輸出失敗')
  })

  test('downloads a real WAV when WAV is selected', async ({ page }) => {
    await loadFixture(page)
    await page.selectOption('#export-format', 'wav')

    const { name, bytes } = await exportAndRead(page)

    expect(name).toBe('tone_master.wav')
    expect(bytes.subarray(0, 4).toString()).toBe('RIFF')
    expect(bytes.subarray(8, 12).toString()).toBe('WAVE')
  })

  test('disables 96kHz for MP3 because lamejs cannot encode it', async ({ page }) => {
    await loadFixture(page)
    await page.selectOption('#export-samplerate', '96000')
    await page.selectOption('#export-format', 'mp3')

    // Selecting MP3 must pull the rate back to something lamejs supports
    // rather than letting the export throw at the encoder.
    await expect(page.locator('#export-samplerate')).toHaveValue('44100')
    await expect(page.locator('#export-samplerate option[value="96000"]')).toBeDisabled()
  })
})
