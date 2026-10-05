import { test, expect } from '@playwright/test'
import { encodeWAV } from '../../src/js/audio/wav.js'
import { measureIntegratedLUFS, measurePeaks } from '../../src/js/audio/measure.js'
import { lateMajorChord, tonalBalance, TEST_RATES, interSampleSine } from '../fixtures/audio-trust/signals.js'

function file(name, buffer) {
  return { name, mimeType: 'audio/wav', buffer: Buffer.from(encodeWAV([buffer.getChannelData(0)], buffer.sampleRate, 24)) }
}
async function downloadBytes(download) {
  const chunks = []
  for await (const chunk of await download.createReadStream()) chunks.push(chunk)
  return Buffer.concat(chunks)
}
function pcm24(wav) {
  const channels = wav.readUInt16LE(22)
  const length = wav.readUInt32LE(40) / (3 * channels)
  return Array.from({ length: channels }, (_, channel) => Float32Array.from({ length }, (_, i) =>
    wav.readIntLE(44 + (i * channels + channel) * 3, 3) / 8388608))
}

for (const sampleRate of TEST_RATES) {
  test(`late-entry key analysis uses the full advertised range at ${sampleRate} Hz`, async ({ page }) => {
    await page.goto('/')
    await page.setInputFiles('#file-input', file(`晚進主旋律-${sampleRate}.wav`, lateMajorChord(sampleRate)))
    await expect(page.locator('#analyze-btn')).toBeEnabled()
    await page.click('#analyze-btn')
    await expect(page.locator('#val-key')).toHaveText('C 大調')
    await expect(page.locator('#conf-val-key')).toHaveAttribute('title', /非正確率保證/)
  })

  test(`reference match and album source loudness use ${sampleRate} Hz PCM correctly`, async ({ page }) => {
    await page.goto('/')
    const source = tonalBalance(sampleRate)
    await page.setInputFiles('#file-input', file(`來源-${sampleRate}.wav`, source))
    await expect(page.locator('#export-btn')).toBeEnabled()
    await page.setInputFiles('#ref-file-input', file('參考-48000.wav', tonalBalance(48000)))
    await expect(page.locator('#ref-match-status')).toContainText('已匹配')
    for (const index of [4, 5, 6, 7]) {
      expect(Math.abs(Number(await page.locator(`[data-param="eq-${index}"] .parameter-number`).inputValue()))).toBeLessThan(0.5)
    }
    await page.click('#album-add-btn')
    const measured = measureIntegratedLUFS([source.getChannelData(0)], source.sampleRate)
    expect(Number(await page.locator('.album-row .ac-lufs').first().textContent())).toBeCloseTo(measured, 1)
  })
}

test('true-peak final preview and downloaded PCM agree at the requested ceiling', async ({ page }, testInfo) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  const samples = interSampleSine(24000, 1)
  await page.setInputFiles('#file-input', { name: '合成ISP.wav', mimeType: 'audio/wav', buffer: Buffer.from(encodeWAV([samples, samples], 48000, 24)) })
  await expect(page.locator('#export-btn')).toBeEnabled()
  await page.locator('#mod-limiter .module-head').click()
  await page.check('#lim-truepeak')
  const exportEvent = page.waitForEvent('download'); await page.click('#export-btn')
  const exported = await downloadBytes(await exportEvent)
  await page.locator('.final-preview-panel summary').click()
  await page.click('#final-preview-btn')
  await expect(page.locator('#final-preview-status')).toContainText('預覽完成')
  const previewEvent = page.waitForEvent('download'); await page.click('#final-preview-download')
  const preview = await downloadBytes(await previewEvent)
  expect(preview.subarray(0, 44)).toEqual(exported.subarray(0, 44))
  const a = pcm24(preview), b = pcm24(exported)
  let residual = 0
  for (let ch = 0; ch < a.length; ch++) for (let i = 0; i < a[ch].length; i++) residual = Math.max(residual, Math.abs(a[ch][i] - b[ch][i]))
  expect(residual).toBeLessThanOrEqual(2 / 8388608)
  // One PCM24 quantization step can move a reconstructed peak by a tiny amount.
  expect(measurePeaks(b).truePeakDb).toBeLessThanOrEqual(-1 + 0.0001)
  await testInfo.attach('pcm-ceiling.json', { body: JSON.stringify({ residual, peaks: measurePeaks(b) }), contentType: 'application/json' })
  expect(errors).toEqual([])
})
