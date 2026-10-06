/** Actual UI → native Web Audio → A/B → accepted ZIP/WAV.
 * All media are generated synthetic constants. Observers forward native calls;
 * no successful decoder, renderer, playback or lyric session is mocked. */
import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { encodeWAV } from '../../src/js/audio/wav.js'
import { createProject } from '../../src/js/daw/project.js'
import { exportProjectArchive } from '../../src/js/daw/archive.js'

const action = (page, name) => page.locator(`[data-daw="${name}"]`)
const clip = (page, id = 'vocal-left') => page.locator(`.daw-clip[data-clip-id="${id}"]`)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
async function field(page, name, value) {
  await page.locator(`#daw-${name}`).fill(String(value))
  await page.locator(`#daw-${name}`).dispatchEvent('change')
}
async function open(page, id) {
  if (!await page.locator(`#${id}`).evaluate(element => element.open)) await page.locator(`#${id} > summary`).click()
}
async function download(page, command) {
  const pending = page.waitForEvent('download'); await action(page, command).click()
  const result = await pending; expect(await result.failure()).toBeNull()
  return readFile(await result.path())
}
function archive(bytes) {
  const entries = new Map()
  let offset = 0
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    expect(bytes.readUInt16LE(offset + 8)).toBe(0)
    const size = bytes.readUInt32LE(offset + 18), names = bytes.readUInt16LE(offset + 26)
    const start = offset + 30 + names + bytes.readUInt16LE(offset + 28)
    entries.set(bytes.subarray(offset + 30, offset + 30 + names).toString(), bytes.subarray(start, start + size))
    offset = start + size
  }
  const manifest = JSON.parse(entries.get('manifest.json').toString())
  return { project: manifest.project, source: id => entries.get(manifest.media.find(item => item.assetId === id).path) }
}
async function fixture() {
  const rate = 48000, files = new Map(), assets = []
  for (const [id, seconds, values] of [['vocal', 2, [.125, -.0625]], ['backing', 3, [.03125, -.015625]]]) {
    const bytes = Buffer.from(encodeWAV(values.map(value => new Float32Array(rate * seconds).fill(value)), rate, 24))
    assets.push({ id, name: `${id}.wav`, hash: digest(bytes), sampleRate: rate, channels: 2, length: rate * seconds, duration: seconds })
    files.set(id, new File([bytes], `${id}.wav`, { type: 'audio/wav', lastModified: 1 }))
  }
  const part = (id, assetId, atSeconds, offsetSeconds, durationSeconds) => ({ id, assetId, name: id, atSeconds, offsetSeconds, durationSeconds, gainDb: 0, fadeInSeconds: 0, fadeOutSeconds: 0 })
  const track = (id, clips) => ({ id, name: id === 'voice-track' ? '獨立人聲' : '伴奏', clips, gainDb: 0, pan: 0, mute: false, solo: false })
  const project = createProject({ id: 'region-browser-proof', sampleRate: rate, assets, tracks: [
    track('voice-track', [part('vocal-left', 'vocal', .25, 0, 1), part('vocal-right', 'vocal', 1.25, 1, 1)]),
    track('backing-track', [part('backing-full', 'backing', 0, 0, 3)]),
  ] })
  return { project, files, bytes: Buffer.from(await (await exportProjectArchive(project, files)).arrayBuffer()) }
}
async function observePlayback(page) {
  await page.addInitScript(() => {
    const create = AudioContext.prototype.createBufferSource
    AudioContext.prototype.createBufferSource = function (...args) {
      const source = create.apply(this, args), nativeStart = source.start
      source.start = function (...startArgs) {
        window.__regionPlayback = { buffer: source.buffer, args: startArgs }
        return nativeStart.apply(source, startArgs)
      }
      return source
    }
  })
}
async function playback(page) {
  return page.evaluate(async () => {
    const { buffer, args } = window.__regionPlayback
    const hashes = await Promise.all(Array.from({ length: buffer.numberOfChannels }, async (_, channel) => {
      const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer.getChannelData(channel)))
      return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
    }))
    const frames = [0, 23999, 36000, 38400, 48000, 59999, 60000, 60001, 72000, 81600, 84000, 96000, 108000, 120000]
    return { rate: buffer.sampleRate, length: buffer.length, args, hashes,
      samples: frames.map(frame => [frame, ...Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel)[frame])]) }
  })
}
function wavSamples(bytes) {
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF'); expect(bytes.readUInt16LE(34)).toBe(24)
  const channels = bytes.readUInt16LE(22), rate = bytes.readUInt32LE(24), frames = bytes.readUInt32LE(40) / (channels * 3)
  return { rate, frames, sample: (frame, channel) => bytes.readIntLE(44 + (frame * channels + channel) * 3, 3) / 8388608 }
}
function gainAt(time) {
  if (time < .75 || time >= 1.75) return 1
  if (time < .85) return 1 - (time - .75) / .1
  if (time > 1.65) return (time - 1.65) / .1
  return 0
}
function compareMute(bytes) {
  const wav = wavSamples(bytes)
  let worst = 0, cutWorst = 0
  for (let frame = 0; frame < wav.frames; frame++) {
    const time = frame / wav.rate, gain = time >= .25 && time < 2.25 ? gainAt(time) : 0
    for (let channel = 0; channel < 2; channel++) {
      const expected = [.03125, -.015625][channel] + [.125, -.0625][channel] * gain
      const error = Math.abs(wav.sample(frame, channel) - expected)
      worst = Math.max(worst, error)
      if (Math.abs(time - 1.25) < .05) cutWorst = Math.max(cutWorst, error)
    }
  }
  expect(wav.frames).toBe(144000); expect(worst).toBeLessThan(2e-6); expect(cutWorst).toBeLessThan(2e-6)
  return { worst, cutWorst, frames: wav.frames, rate: wav.rate }
}
async function load(page, bytes) {
  await page.locator('#tab-editor').click()
  await page.locator('#daw-project-file').setInputFiles({ name: 'synthetic-stems.waveforge.zip', mimeType: 'application/zip', buffer: bytes })
  await expect(page.locator('#daw-status')).toContainText('工程已還原')
  await clip(page).click()
}
async function lyricSetup(page) {
  await page.goto('/')
  await page.locator('#file-input').setInputFiles('tests/fixtures/test-tone-8s.wav')
  await expect(page.locator('#export-btn')).toBeEnabled()
  await page.locator('#tab-lyrics').click()
  await expect(page.locator('#lyrics-source')).toContainText('來源已連結')
  await page.locator('#lyrics-raw').fill('保留原文 <em>hello</em>')
  await page.locator('[data-command="lyrics.apply"]').click()
  await page.locator('#lyrics-start-value').fill('.5'); await page.locator('#lyrics-start-value').press('Tab')
  await page.locator('#lyrics-end-value').fill('1.5'); await page.locator('#lyrics-end-value').press('Tab')
  await page.locator('[data-command="lyrics.confirm"]').click()
}
async function prepare(page, fromLyrics = false) {
  await open(page, 'daw-region-details')
  await action(page, 'region-designate').click()
  if (fromLyrics) {
    await open(page, 'daw-region-lyrics')
    await expect(page.locator('#daw-region-offset')).toHaveValue('')
    await action(page, 'region-use-lyric').click()
    await expect(page.locator('#daw-status')).toContainText('明確填入')
    await field(page, 'region-offset', .25); await action(page, 'region-use-lyric').click()
    await expect(page.locator('#daw-region-start')).toHaveValue('0.75')
    await expect(page.locator('#daw-region-end')).toHaveValue('1.75')
    await expect(page.locator('#daw-region-label')).toHaveValue('保留原文 <em>hello</em>')
    await expect(page.locator('#daw-region-lyric em')).toHaveCount(0)
  } else {
    await field(page, 'region-start', .75); await field(page, 'region-end', 1.75)
  }
  await open(page, 'daw-region-edges')
  await field(page, 'region-fade-in', 100); await field(page, 'region-fade-out', 100)
  await action(page, 'region-prepare').click()
  await expect(page.locator('#daw-replacement-review')).toBeVisible()
  await expect(page.locator('#daw-replacement-summary')).toContainText('2 片段')
}

test('accepted lyric times mute only the designated vocal across cuts with real A/B, atomic undo, ZIP reopen and original recovery', async ({ page }, testInfo) => {
  const errors = [], uploads = [], models = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    if (['POST', 'PUT', 'PATCH'].includes(request.method())) uploads.push(request.url())
    if (/huggingface|\.onnx(?:\?|$)/.test(request.url())) models.push(request.url())
  })
  await observePlayback(page)
  const source = await fixture()
  await lyricSetup(page); await load(page, source.bytes)
  const original = await download(page, 'export'), before = archive(await download(page, 'save'))
  await prepare(page, true)
  await action(page, 'replacement-preview').click(); await expect(page.locator('#daw-status')).toContainText('B：正在試聽')
  const candidate = await playback(page); await action(page, 'stop').click()
  expect(candidate.args.slice(1)).toEqual([.75, 1])
  expect(await download(page, 'export')).toEqual(original)
  expect(archive(await download(page, 'save')).project).toEqual(before.project)
  await action(page, 'replacement-original').click(); await expect(page.locator('#daw-status')).toContainText('A：正在試聽')
  const unchanged = await playback(page); await action(page, 'stop').click()
  const originalSamples = wavSamples(original)
  for (const [frame, left, right] of unchanged.samples) for (const [channel, value] of [left, right].entries()) expect(originalSamples.sample(frame, channel)).toBeCloseTo(value, 6)
  await action(page, 'replacement-confirm').click()
  await expect(page.locator('#daw-status')).toContainText('已接受人聲區間')
  const acceptedWav = await download(page, 'export'), acceptedZip = await download(page, 'save'), accepted = archive(acceptedZip)
  const measurements = compareMute(acceptedWav), acceptedSamples = wavSamples(acceptedWav)
  for (const [frame, left, right] of candidate.samples) for (const [channel, value] of [left, right].entries()) expect(acceptedSamples.sample(frame, channel)).toBeCloseTo(value, 6)
  expect(accepted.project.revision).toBe(before.project.revision + 1)
  expect(accepted.project.tracks[1]).toEqual(before.project.tracks[1])
  expect(accepted.project.tracks[0].clips.map(item => item.gainRegions.length)).toEqual([1, 1])
  for (const id of ['vocal', 'backing']) expect(accepted.source(id)).toEqual(before.source(id))
  await action(page, 'undo').click(); expect(await download(page, 'export')).toEqual(original)
  await action(page, 'redo').click(); expect(await download(page, 'export')).toEqual(acceptedWav)
  await page.locator('#tab-lyrics').click(); await open(page, 'lyrics-original')
  await expect(page.locator('#lyrics-raw')).toHaveValue('保留原文 <em>hello</em>')
  // A fresh document has no connected lyric audio. Saved regions remain editable.
  await page.reload(); await load(page, acceptedZip)
  await open(page, 'daw-region-details')
  await expect(page.locator('#daw-region-offset')).toHaveValue('')
  await expect(action(page, 'region-use-lyric')).toBeDisabled()
  expect(await download(page, 'export')).toEqual(acceptedWav)
  await page.locator('#daw-region-select').selectOption(accepted.project.tracks[0].clips[0].gainRegions[0].id)
  await field(page, 'region-gain', 50); await action(page, 'region-prepare').click()
  await action(page, 'replacement-confirm').click()
  const changed = archive(await download(page, 'save')).project
  expect(changed.tracks[0].clips[0].gainRegions[0].gain).toBe(.5)
  expect(changed.tracks[0].clips[0].gainRegions[0].attenuationEnvelope).toEqual(accepted.project.tracks[0].clips[0].gainRegions[0].attenuationEnvelope)
  await action(page, 'undo').click(); expect(await download(page, 'export')).toEqual(acceptedWav)
  await action(page, 'region-remove').click()
  await clip(page, 'vocal-right').click(); await action(page, 'region-reset').click()
  expect(await download(page, 'export')).toEqual(original)
  expect(errors).toEqual([]); expect(uploads).toEqual([]); expect(models).toEqual([])
  const path = testInfo.outputPath('vocal-region-native-evidence.json')
  await writeFile(path, JSON.stringify({ measurements, candidate, unchanged, before: before.project, accepted: accepted.project,
    hashes: { original: digest(original), accepted: digest(acceptedWav), vocal: digest(accepted.source('vocal')), backing: digest(accepted.source('backing')) } }, null, 2))
  await testInfo.attach('vocal-region-native-evidence.json', { path, contentType: 'application/json' })
})

test('changed settings, lyric drafts, cancellation and source replacement cannot commit stale vocal regions', async ({ page }) => {
  const source = await fixture()
  await lyricSetup(page); await load(page, source.bytes)
  const before = archive(await download(page, 'save')).project
  await prepare(page, true); await field(page, 'region-offset', .5)
  await expect(page.locator('#daw-replacement-review')).toBeHidden()
  await expect(page.locator('#daw-region-start')).toHaveValue('')
  await field(page, 'region-offset', .25); await action(page, 'region-use-lyric').click(); await action(page, 'region-prepare').click()
  await action(page, 'replacement-cancel').click()
  expect(archive(await download(page, 'save')).project).toEqual(before)
  await action(page, 'region-prepare').click(); await field(page, 'region-gain', 20)
  await expect(page.locator('#daw-replacement-review')).toBeHidden()
  await action(page, 'region-prepare').click()
  await page.locator('#tab-lyrics').click(); await open(page, 'lyrics-original')
  await page.locator('#lyrics-raw').fill('尚未套用的文字')
  await page.locator('#tab-editor').click()
  await expect(page.locator('#daw-replacement-review')).toBeHidden()
  await expect(page.locator('#daw-region-offset')).toHaveValue('')
  await expect(action(page, 'region-use-lyric')).toBeDisabled()
  expect(archive(await download(page, 'save')).project).toEqual(before)
  // A new master source is independent of the DAW originals and cannot mutate them.
  await page.locator('#tab-lyrics').click()
  await page.locator('#file-input').setInputFiles('tests/fixtures/test-tone.wav')
  await expect(page.locator('#lyrics-source')).toContainText('0.500 秒')
  await page.locator('#tab-editor').click()
  expect(archive(await download(page, 'save')).project).toEqual(before)
})

for (const width of [1440, 390]) test(`vocal regions stay contextual with reachable A/B and recovery at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 844 }); await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/'); await load(page, (await fixture()).bytes)
  await expect(page.locator('#daw-region-details')).not.toHaveAttribute('open', '')
  await expect(action(page, 'region-designate')).toBeHidden()
  await page.screenshot({ path: testInfo.outputPath(`vocal-region-default-${width}.png`) })
  await prepare(page)
  await page.locator('#daw-region-edges > summary').click()
  await action(page, 'replacement-preview').click(); await expect(page.locator('#daw-status')).toContainText('B：正在試聽')
  await action(page, 'stop').click()
  await action(page, 'replacement-original').click(); await expect(page.locator('#daw-status')).toContainText('A：正在試聽')
  await action(page, 'stop').click()
  await action(page, 'replacement-confirm').scrollIntoViewIfNeeded()
  for (const name of ['replacement-original', 'replacement-preview', 'replacement-confirm', 'replacement-cancel']) {
    const control = action(page, name), box = await control.boundingBox(), transport = await page.locator('.daw-transport').boundingBox()
    expect(box.height).toBeGreaterThanOrEqual(44); expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(width); expect(box.y + box.height).toBeLessThanOrEqual(transport.y + 1)
    expect(await control.evaluate(element => { const box = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)) })).toBe(true)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath(`vocal-region-review-${width}.png`) })
  await action(page, 'replacement-confirm').focus(); await page.keyboard.press('Enter')
  const accepted = archive(await download(page, 'save')).project
  await page.locator('#daw-region-select').selectOption(accepted.tracks[0].clips[0].gainRegions[0].id)
  await expect(action(page, 'region-remove')).toBeEnabled(); await action(page, 'region-remove').scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath(`vocal-region-recovery-${width}.png`) })
})
