import { readFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'

test('Chinese file exports at 96 kHz with honest report and final preview', async ({ page }, testInfo) => {
  const errors = []; page.on('pageerror', err => errors.push(err.message))
  await page.goto('/')
  await page.setInputFiles('#file-input', { name: '中文人聲.wav', mimeType: 'audio/wav', buffer: readFileSync('tests/fixtures/test-tone.wav') })
  await expect(page.locator('#export-btn')).toBeEnabled()
  await page.selectOption('#export-samplerate', '96000')
  const download = page.waitForEvent('download')
  await page.click('#export-btn')
  const stream = await (await download).createReadStream()
  const chunks = []; for await (const c of stream) chunks.push(c)
  expect(Buffer.concat(chunks).readUInt32LE(24)).toBe(96000)
  await expect(page.locator('#status-text')).toContainText('96kHz')
  await page.locator('.final-preview-panel summary').click()
  await page.click('#final-preview-btn')
  await expect(page.locator('#final-preview-status')).toContainText('預覽完成', { timeout: 30000 })
  await expect(page.locator('#final-preview-audio')).toHaveAttribute('src', /^blob:/)
  await expect(page.locator('#original-preview-audio')).toHaveAttribute('src', /^blob:/)
  const previewDownload = page.waitForEvent('download')
  await page.click('#final-preview-download')
  const previewStream = await (await previewDownload).createReadStream()
  const previewChunks = []; for await (const c of previewStream) previewChunks.push(c)
  const preview = Buffer.concat(previewChunks), exported = Buffer.concat(chunks)
  expect(preview.length).toBe(exported.length)
  expect(preview.subarray(0, 44)).toEqual(exported.subarray(0, 44))
  let peakResidual = 0, square = 0, count = 0
  for (let i = 44; i < preview.length; i += 3) {
    const d = (preview.readIntLE(i, 3) - exported.readIntLE(i, 3)) / 8388608
    peakResidual = Math.max(peakResidual, Math.abs(d)); square += d * d; count++
  }
  // Native browser DSP can differ by the last PCM bit between renders.
  // Keep header exact; independently bound every sample and the total energy.
  expect(peakResidual).toBeLessThanOrEqual(2 / 8388608)
  expect(Math.sqrt(square / count)).toBeLessThan(1 / 8388608)
  await testInfo.attach('preview-residual.json', { body: JSON.stringify({ peakResidual, rmsResidual: Math.sqrt(square / count) }), contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath('final-preview.png'), fullPage: true })
  expect(errors).toEqual([])
})


test('imports Chinese-named stems, previews live edits and bounces a real file', async ({ page }, testInfo) => {
  const errors = []; page.on('pageerror', err => errors.push(err.message))
  await page.goto('/')
  await page.locator('[data-mode="stems"]').click()
  await page.setInputFiles('#stems-local-files', ['人聲', '鼓組', '貝斯', '其他'].map(name => ({
    name: `${name}.wav`, mimeType: 'audio/wav', buffer: readFileSync('tests/fixtures/test-tone-8s.wav'),
  })))
  await expect(page.locator('#stems-preview-btn')).toBeEnabled()
  const card = page.locator('.stem-proc-card').first()
  expect((await card.boundingBox()).height).toBeGreaterThan(330)
  await page.click('#stems-preview-btn')
  await expect(page.locator('#bounce-status')).toContainText(/試聽|超峰值/)
  await page.getByRole('slider', { name: '人聲 低頻 EQ', exact: true }).fill('6')
  await page.getByRole('checkbox', { name: '人聲 EQ', exact: true }).check()
  await expect(page.locator('#eq-val-vocals-lowGain')).toHaveText('+6 dB')
  await page.click('#stems-preview-btn')
  await expect(page.locator('#bounce-status')).toContainText('已停止')
  await page.screenshot({ path: testInfo.outputPath('stem-preview.png'), fullPage: true })
  await page.check('#normalize-bounce')
  await page.click('#bounce-btn')
  await expect(page.locator('#export-btn')).toBeEnabled({ timeout: 20000 })
  await expect(page.locator('#status-text')).toContainText('stems-bounce.wav')
  const download = page.waitForEvent('download')
  await page.click('#export-btn')
  const stream = await (await download).createReadStream()
  const chunks = []; for await (const c of stream) chunks.push(c)
  const data = Buffer.concat(chunks)
  expect(data.subarray(0,4).toString()).toBe('RIFF')
  expect(data.readUInt32LE(40)).toBeGreaterThan(100000)
  expect(errors).toEqual([])
})
