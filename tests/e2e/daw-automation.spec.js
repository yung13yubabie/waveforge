/** Real OfflineAudioContext and main-wired UI tests, using synthetic PCM only. */
import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { encodeWAV } from '../../src/js/audio/wav.js'

const action = (page, name) => page.locator(`[data-daw="${name}"]`)
const field = async (page, name, value) => {
  await page.locator(`#daw-${name}`).fill(String(value))
  await page.locator(`#daw-${name}`).dispatchEvent('change')
}
const sourceFile = (value = .1) => ({ name: 'synthetic-automation.wav', mimeType: 'audio/wav',
  buffer: Buffer.from(encodeWAV([new Float32Array(96000).fill(value), new Float32Array(96000).fill(value)], 48000, 24)) })
async function start(page, value) {
  await page.goto('/'); await page.locator('#tab-editor').click()
  await page.locator('#daw-audio-files').setInputFiles(sourceFile(value))
  await expect(page.locator('.daw-clip')).toHaveCount(1)
  await page.locator('#daw-automation-details > summary').click()
}
async function download(page, name) {
  const pending = page.waitForEvent('download'); await action(page, name).click()
  return readFile(await (await pending).path())
}
function manifest(zip) {
  expect(zip.readUInt32LE(0)).toBe(0x04034b50)
  const offset = 30 + zip.readUInt16LE(26) + zip.readUInt16LE(28)
  return JSON.parse(zip.subarray(offset, offset + zip.readUInt32LE(18)).toString()).project
}
function sample(wav, seconds) {
  expect(wav.readUInt16LE(34)).toBe(24)
  const rate = wav.readUInt32LE(24), channels = wav.readUInt16LE(22)
  return wav.readIntLE(44 + Math.round(seconds * rate) * channels * 3, 3) / 8388608
}

test('numeric automation edits reach preview/WAV, survive split/trim and reopen bit-identically', async ({ page }, testInfo) => {
  const errors = [], uploads = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (['POST', 'PUT', 'PATCH'].includes(request.method())) uploads.push(request.url()) })
  await page.setViewportSize({ width: 390, height: 844 })
  await start(page)
  await action(page, 'automation-add').click()
  await field(page, 'automation-time', .5); await field(page, 'automation-value', 25)
  await action(page, 'automation-apply').click()
  await expect(page.locator('#daw-automation-value')).toHaveValue('25')
  // Exercise native pointer capture and restore in one undo before numeric assertions.
  const point = page.locator('#daw-automation-graph [data-automation-index="1"]')
  await point.scrollIntoViewIfNeeded()
  const dot = await point.boundingBox(), graph = await page.locator('#daw-automation-graph').boundingBox()
  await page.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2)
  await page.mouse.down()
  await page.mouse.move(graph.x + graph.width * .6, graph.y + graph.height * .5, { steps: 4 })
  await page.mouse.up()
  await expect(page.locator('#daw-automation-value')).not.toHaveValue('25')
  await action(page, 'undo').click()
  await expect(page.locator('#daw-automation-time')).toHaveValue('0.5')
  await expect(page.locator('#daw-automation-value')).toHaveValue('25')
  await page.getByText('細調音量與接縫', { exact: true }).click()
  await field(page, 'fade-in', .25); await action(page, 'fades').click()
  await page.locator('#daw-seek').evaluate(input => { input.value = '1'; input.dispatchEvent(new Event('input')) })
  await action(page, 'split').click()
  await field(page, 'trim-start', .125); await field(page, 'trim-end', .875); await action(page, 'trim').click()
  await expect(page.locator('.daw-clip')).toHaveCount(2)
  await action(page, 'undo').click(); await action(page, 'redo').click()
  await action(page, 'begin').click(); await action(page, 'play').click()
  await expect(action(page, 'play')).toHaveText('暫停')
  await action(page, 'play').click()
  const previewInfo = await page.locator('#daw-render-info').textContent()
  const wav = await download(page, 'export')
  expect(await page.locator('#daw-render-info').textContent()).toBe(previewInfo)
  for (const [at, expected] of [[.0625, 0], [.125, .040625], [.25, .0625], [.5, .025], [.75, .0375], [.9375, 0], [1, .05], [1.5, .075]]) {
    expect(sample(wav, at), `sample at ${at}s`).toBeCloseTo(expected, 5)
  }
  const zip = await download(page, 'save'), saved = manifest(zip)
  expect(saved.tracks[0].clips[0].volumeAutomation).toEqual([
    { timeSeconds: 0, value: .8125 }, { timeSeconds: .375, value: .25 }, { timeSeconds: .75, value: .4375 },
  ])
  expect(saved.tracks[0].clips[1].volumeAutomation).toEqual([{ timeSeconds: 0, value: .5 }, { timeSeconds: 1, value: 1 }])
  await page.locator('#daw-automation-details').evaluate(element => element.scrollIntoView({ block: 'start' }))
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false)
  await page.screenshot({ path: testInfo.outputPath('automation-mobile.png'), fullPage: false })
  await page.reload(); await page.locator('#tab-editor').click()
  await page.locator('#daw-project-file').setInputFiles({ name: 'automation.waveforge.zip', mimeType: 'application/zip', buffer: zip })
  await expect(page.locator('#daw-status')).toContainText('工程已還原')
  expect(manifest(await download(page, 'save'))).toEqual(saved)
  expect(await download(page, 'export')).toEqual(wav)
  expect(errors).toEqual([]); expect(uploads).toEqual([])
})

test('actual amplified output triggers the WAV guard and remains editable', async ({ page }) => {
  const downloads = []
  page.on('download', download => downloads.push(download.suggestedFilename()))
  await start(page, .75)
  await field(page, 'automation-value', 200); await action(page, 'automation-apply').click()
  await page.locator('#daw-automation-point').selectOption('1')
  await field(page, 'automation-value', 200); await action(page, 'automation-apply').click()
  await action(page, 'export').click()
  await expect(page.locator('#daw-status')).toContainText('停止 WAV 輸出')
  expect(downloads).toEqual([])
  await expect(page.locator('#daw-automation-value')).toHaveValue('200')
  await field(page, 'master-gain', -12)
  const safe = await download(page, 'export')
  expect(sample(safe, .5)).toBeCloseTo(1.5 * 10 ** (-12 / 20), 5)
})
