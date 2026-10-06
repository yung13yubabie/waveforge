/** Real browser/native OfflineAudioContext coverage. Prepared for CI; do not
 * replace this with jsdom mocks when reporting playback/sample verification. */
import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { encodeWAV } from '../../src/js/audio/wav.js'

const action = (page, name) => page.locator(`[data-daw="${name}"]`)
const field = async (page, name, value) => {
  await page.locator(`#daw-${name}`).fill(String(value))
  await page.locator(`#daw-${name}`).dispatchEvent('change')
}
function toneFile(name, frequency, sampleRate, seconds) {
  const samples = new Float32Array(Math.round(sampleRate * seconds))
  for (let i = 0; i < samples.length; i++) samples[i] = .2 * Math.sin(2 * Math.PI * frequency * i / sampleRate)
  return { name, mimeType: 'audio/wav', buffer: Buffer.from(encodeWAV([samples, samples], sampleRate, 24)) }
}
const oldFile = () => toneFile('original-220Hz-48k.wav', 220, 48000, 2)
const newFile = () => toneFile('replacement-660Hz-44k.wav', 660, 44100, 3)
async function replaceFile(page, file) {
  const chooser = page.waitForEvent('filechooser')
  await action(page, 'replace').click()
  await (await chooser).setFiles(file)
}
async function download(page, command) {
  const pending = page.waitForEvent('download'); await action(page, command).click()
  return readFile(await (await pending).path())
}
function zipProject(zip) {
  expect(zip.readUInt32LE(0)).toBe(0x04034b50)
  const offset = 30 + zip.readUInt16LE(26) + zip.readUInt16LE(28)
  return JSON.parse(zip.subarray(offset, offset + zip.readUInt32LE(18)).toString()).project
}
function wavSample(wav, frame) {
  expect(wav.readUInt16LE(34)).toBe(24)
  return wav.readIntLE(44 + frame * wav.readUInt16LE(22) * 3, 3) / 8388608
}
function magnitude(wav, frequency) {
  const rate = wav.readUInt32LE(24); let re = 0, im = 0
  for (let i = .5 * rate; i < 1.5 * rate; i++) {
    const value = wavSample(wav, i)
    re += value * Math.cos(2 * Math.PI * frequency * i / rate)
    im += value * Math.sin(2 * Math.PI * frequency * i / rate)
  }
  return Math.hypot(re, im)
}
async function start(page) {
  await page.goto('/'); await page.locator('#tab-editor').click()
  await page.locator('#daw-audio-files').setInputFiles(oldFile())
  await expect(page.locator('.daw-clip')).toHaveCount(1)
  await page.locator('#daw-replacement-details > summary').click()
}

test('local replacement previews retain accepted output, native source rates and undo/ZIP/WAV parity', async ({ page }, testInfo) => {
  const errors = [], uploads = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (['POST', 'PUT', 'PATCH'].includes(request.method())) uploads.push(request.url()) })
  // Capture only actual realtime playback buffers, not offline rendering nodes.
  await page.addInitScript(() => {
    const create = AudioContext.prototype.createBufferSource
    AudioContext.prototype.createBufferSource = function () {
      const source = create.call(this), start = source.start
      source.start = function (...args) {
        const indices = [0, 1000, 12001, 24037, 30053, 35047, 48059, 60071, 71999]
        window.__replacementPlayback = { rate: source.buffer.sampleRate, length: source.buffer.length, args,
          samples: indices.map(index => [index, source.buffer.getChannelData(0)[index]]) }
        return start.apply(source, args)
      }
      return source
    }
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await start(page)
  await page.locator('.daw-grid-settings > summary').click()
  await page.locator('#daw-snap').uncheck()
  await page.locator('.daw-grid-settings > summary').click(); await field(page, 'clip-at', .25); await action(page, 'move').click()
  await field(page, 'trim-end', 1.75); await action(page, 'trim').click()
  await page.locator('#daw-fades-details > summary').click()
  await field(page, 'clip-gain', -3); await field(page, 'fade-in', .125); await field(page, 'fade-out', .125); await action(page, 'fades').click()
  await page.locator('#daw-automation-details > summary').click(); await action(page, 'automation-add').click()
  await field(page, 'automation-value', 50); await action(page, 'automation-apply').click()
  const beforeZip = await download(page, 'save'), before = zipProject(beforeZip)
  const originalWav = await download(page, 'export')
  await field(page, 'replacement-offset', .5); await replaceFile(page, newFile())
  await expect(page.locator('#daw-replacement-review')).toBeVisible()
  await expect(page.locator('#daw-replacement-summary')).toContainText('44.1 kHz')
  await expect(page.locator('#daw-replacement-summary')).toContainText('00:00.500–00:02.000')
  await action(page, 'replacement-preview').click()
  await expect(page.locator('#daw-status')).toContainText('B：正在試聽')
  const candidatePlayback = await page.evaluate(() => window.__replacementPlayback)
  await action(page, 'stop').click()
  // Ordinary Play must still render the accepted project after a B audition.
  await action(page, 'begin').click(); await action(page, 'play').click()
  await expect(page.locator('#daw-status')).toContainText('正在播放目前專案混音')
  const acceptedPlayback = await page.evaluate(() => window.__replacementPlayback)
  await action(page, 'stop').click()
  for (const [index, sample] of acceptedPlayback.samples) expect(wavSample(originalWav, index)).toBeCloseTo(sample, 6)
  expect(await download(page, 'export')).toEqual(originalWav)
  expect(zipProject(await download(page, 'save'))).toEqual(before)
  await action(page, 'replacement-original').click()
  await expect(page.locator('#daw-status')).toContainText('A：正在試聽')
  const originalPlayback = await page.evaluate(() => window.__replacementPlayback)
  await action(page, 'stop').click()
  for (const [index, sample] of originalPlayback.samples) expect(wavSample(originalWav, index)).toBeCloseTo(sample, 6)
  await action(page, 'replacement-confirm').click()
  await expect(page.locator('#daw-replacement-review')).toBeHidden()
  await expect(page.locator('#daw-current-source')).toContainText('replacement-660Hz-44k.wav')
  const replacementWav = await download(page, 'export'), afterZip = await download(page, 'save'), after = zipProject(afterZip)
  expect(after.tracks[0].clips[0]).toEqual({ ...before.tracks[0].clips[0], assetId: after.assets[1].id, offsetSeconds: .5 })
  expect(after.assets.map(asset => asset.sampleRate)).toEqual([48000, 44100])
  expect(replacementWav.length).toBe(originalWav.length)
  expect(candidatePlayback.length).toBe(84000)
  expect(candidatePlayback.args.slice(1)).toEqual([.25, 1.5])
  for (const [index, sample] of candidatePlayback.samples) expect(wavSample(replacementWav, index)).toBeCloseTo(sample, 6)
  expect(magnitude(replacementWav, 660)).toBeGreaterThan(100 * magnitude(replacementWav, 220))
  expect(magnitude(originalWav, 220)).toBeGreaterThan(100 * magnitude(originalWav, 660))
  await action(page, 'undo').click(); expect(await download(page, 'export')).toEqual(originalWav)
  await action(page, 'redo').click(); expect(await download(page, 'export')).toEqual(replacementWav)
  page.once('dialog', dialog => dialog.accept())
  await page.locator('#daw-project-file').setInputFiles({ name: 'replacement.waveforge.zip', mimeType: 'application/zip', buffer: afterZip })
  await expect(page.locator('#daw-status')).toContainText('工程已還原')
  expect(await download(page, 'export')).toEqual(replacementWav)
  expect(zipProject(await download(page, 'save'))).toEqual(after)
  expect(uploads).toEqual([]); expect(errors).toEqual([])
  await testInfo.attach('replacement-native-sample-evidence.json', { body: JSON.stringify({ before, after, candidatePlayback, originalPlayback, acceptedPlayback, original660: magnitude(originalWav, 660), original220: magnitude(originalWav, 220), replaced660: magnitude(replacementWav, 660), replaced220: magnitude(replacementWav, 220) }, null, 2), contentType: 'application/json' })
})

test('short takes, invalid offsets, cancellation, edits, selection and navigation cannot replace the wrong clip', async ({ page }) => {
  await start(page)
  const before = zipProject(await download(page, 'save'))
  await replaceFile(page, toneFile('too-short.wav', 660, 44100, .5))
  await expect(page.locator('#daw-status')).toContainText('長度不足')
  expect(zipProject(await download(page, 'save'))).toEqual(before)
  await replaceFile(page, newFile()); await expect(page.locator('#daw-replacement-review')).toBeVisible()
  await field(page, 'replacement-offset', 1.1)
  await expect(action(page, 'replacement-confirm')).toBeDisabled()
  await field(page, 'replacement-offset', 1)
  await expect(action(page, 'replacement-confirm')).toBeEnabled()
  await action(page, 'replacement-cancel').click()
  expect(zipProject(await download(page, 'save'))).toEqual(before)
  await field(page, 'replacement-offset', 0)
  await replaceFile(page, newFile()); await expect(page.locator('#daw-replacement-review')).toBeVisible()
  await action(page, 'later').click(); await expect(page.locator('#daw-replacement-review')).toBeHidden()
  await action(page, 'undo').click()
  await replaceFile(page, newFile()); await expect(page.locator('#daw-replacement-review')).toBeVisible()
  await page.locator('#tab-lyrics').click(); await page.locator('#tab-editor').click()
  await expect(page.locator('#daw-replacement-review')).toBeHidden()
  expect(zipProject(await download(page, 'save'))).toEqual(before)
  await page.locator('#daw-audio-files').setInputFiles(oldFile())
  await expect(page.locator('.daw-clip')).toHaveCount(2)
  await replaceFile(page, newFile()); await expect(page.locator('#daw-replacement-review')).toBeVisible()
  await page.locator('.daw-clip').first().click()
  await expect(page.locator('#daw-replacement-review')).toBeHidden()
  expect(zipProject(await download(page, 'save')).assets).toHaveLength(2)
})


for (const width of [1440, 390]) {
  test(`compact replacement review stays contextual and keyboard reachable at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('/'); await page.locator('#tab-editor').click()
    await expect(page.locator('#daw-clip-fields')).toBeHidden()
    await expect(action(page, 'replace')).toBeHidden()
    await expect(page.locator('#daw-timeline')).toBeInViewport()
    await expect(page.locator('#daw-help')).not.toHaveAttribute('open', '')
    await expect(page.locator('#daw-zip-warning')).toContainText('完整新舊原音')
    await page.locator('#daw-audio-files').setInputFiles(oldFile())
    await expect(page.locator('.daw-clip')).toHaveCount(1)
    await expect(page.locator('#daw-replacement-details')).not.toHaveAttribute('open', '')
    await expect(action(page, 'replace')).toBeHidden()
    await page.locator('#daw-replacement-details > summary').click()
    await replaceFile(page, newFile())
    await expect(page.locator('#daw-replacement-review')).toBeVisible()
    await expect(page.locator('#daw-replacement-wave path')).toHaveCount(1)
    await expect(page.locator('#daw-replacement-privacy')).toContainText('不上傳')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    for (const command of ['replace', 'replacement-original', 'replacement-preview', 'replacement-confirm', 'replacement-cancel']) {
      const control = action(page, command)
      await control.scrollIntoViewIfNeeded()
      await expect(control).toBeInViewport()
      const box = await control.boundingBox()
      expect(box.height).toBeGreaterThanOrEqual(44)
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(width)
    }
    await page.locator('#daw-replacement-details').screenshot({ path: testInfo.outputPath(`replacement-review-${width}.png`) })
    await expect(page.locator('.daw-transport')).toBeInViewport()
    await action(page, 'replacement-cancel').focus(); await page.keyboard.press('Enter')
    await expect(page.locator('#daw-replacement-review')).toBeHidden()
    await expect(action(page, 'replace')).toBeFocused()
    await expect(action(page, 'replacement-confirm')).toBeHidden()
    await replaceFile(page, newFile())
    await expect(page.locator('#daw-replacement-review')).toBeVisible()
    await action(page, 'replacement-confirm').focus(); await page.keyboard.press('Enter')
    await expect(page.locator('#daw-replacement-review')).toBeHidden()
    await expect(action(page, 'replace')).toBeFocused()
    await expect(page.locator('#daw-current-source')).toContainText('replacement-660Hz-44k.wav')
    await action(page, 'delete').click()
    await expect(page.locator('#daw-clip-fields')).toBeHidden()
    await expect(action(page, 'replace')).toBeHidden()
    await expect(page.locator('#daw-timeline')).toBeFocused()
    await action(page, 'undo').click(); await page.locator('.daw-clip').click()
    await expect(page.locator('#daw-current-source')).toContainText('replacement-660Hz-44k.wav')
    await expect(page.locator('#daw-replacement-review')).toBeHidden()
    expect(errors).toEqual([])
  })
}
