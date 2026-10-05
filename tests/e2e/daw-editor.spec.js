/** Production main wiring + real Web Audio only. Synthetic PCM, no model/audio upload. */
import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { encodeWAV } from '../../src/js/audio/wav.js'

function fixture(name = 'synthetic-44100.wav') {
  const sampleRate = 44100, length = sampleRate * 4
  const channels = [new Float32Array(length), new Float32Array(length)]
  for (let i = 0; i < length; i++) {
    channels[0][i] = .08 * Math.sin(2 * Math.PI * 440 * i / sampleRate)
    channels[1][i] = .06 * Math.sin(2 * Math.PI * 660 * i / sampleRate)
  }
  return { name, mimeType: 'audio/wav', buffer: Buffer.from(encodeWAV(channels, sampleRate, 24)) }
}
const action = (page, command) => page.locator(`[data-daw="${command}"]`)
async function field(page, id, value) {
  await page.locator(`#daw-${id}`).fill(String(value))
  await page.locator(`#daw-${id}`).dispatchEvent('change')
}
async function startEditor(page) {
  await page.goto('/')
  await page.locator('#tab-editor').click()
  await expect(page.locator('#mode-editor')).toBeVisible()
  await expect(page.locator('.header-actions')).toBeHidden()
  await page.locator('#daw-audio-files').setInputFiles([fixture(), fixture('synthetic-other.wav')])
  await expect(page.locator('#daw-summary')).toContainText('2 軌 · 2 片段')
  await expect(page.locator('.daw-clip')).toHaveCount(2)
}
async function download(page, command) {
  const ready = page.waitForEvent('download')
  await action(page, command).click()
  return ready
}
function manifest(zip) {
  // Our portable archive uses stored ZIP entries. Read the first manifest entry
  // for independent assertions; reopening still happens through the actual UI.
  expect(zip.readUInt32LE(0)).toBe(0x04034b50)
  expect(zip.readUInt16LE(8)).toBe(0)
  const nameBytes = zip.readUInt16LE(26), extraBytes = zip.readUInt16LE(28), size = zip.readUInt32LE(18)
  expect(zip.subarray(30, 30 + nameBytes).toString()).toBe('manifest.json')
  const offset = 30 + nameBytes + extraBytes
  return JSON.parse(zip.subarray(offset, offset + size).toString())
}

test('real editor import, edits, preview, WAV and portable archive roundtrip use main wiring', async ({ page }, testInfo) => {
  const errors = [], uploads = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (['POST', 'PUT', 'PATCH'].includes(request.method())) uploads.push(request.url()) })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await startEditor(page)
  await action(page, 'later').click()
  await expect(page.locator('#daw-clip-at')).toHaveValue('0.5')
  await field(page, 'trim-start', 1)
  await field(page, 'trim-end', 4)
  await action(page, 'trim').click()
  await page.locator('#daw-seek').evaluate(input => { input.value = '2'; input.dispatchEvent(new Event('input', { bubbles: true })) })
  await action(page, 'split').click()
  await expect(page.locator('.daw-clip')).toHaveCount(3)
  const selectedClipId = await page.locator('.daw-clip[aria-pressed="true"]').getAttribute('data-clip-id')
  await action(page, 'duplicate').click()
  await expect(page.locator('.daw-clip')).toHaveCount(4)
  await action(page, 'undo').click()
  await expect(page.locator('.daw-clip')).toHaveCount(3)
  await action(page, 'redo').click()
  await expect(page.locator('.daw-clip')).toHaveCount(4)
  await expect(page.locator('.daw-clip[aria-pressed="true"]')).toHaveAttribute('data-clip-id', selectedClipId)
  await expect(page.locator('#daw-clip-fields')).toBeEnabled()
  // Fades are intentionally progressive detail, not an always-visible field.
  // Use the same visible disclosure a person opens before editing the seam.
  await page.getByText('細調音量與接縫', { exact: true }).click()
  await expect(page.locator('#daw-fade-in')).toBeVisible()
  await expect(page.locator('#daw-fade-in')).toBeEnabled()
  await field(page, 'fade-in', .05); await field(page, 'fade-out', .05)
  await action(page, 'fades').click()
  const trackGain = page.locator('input[data-track-control="gainDb"]').first()
  await trackGain.fill('-3'); await trackGain.dispatchEvent('change')
  await field(page, 'master-gain', -2)
  await page.locator('#daw-sample-rate').selectOption('44100')
  await action(page, 'begin').click()
  await action(page, 'play').click()
  await expect(action(page, 'play')).toHaveText('暫停')
  await expect(page.locator('#daw-time')).not.toHaveText('00:00.000 / 00:04.000')
  await action(page, 'play').click()
  const previewRevision = await page.locator('#daw-render-info').textContent()
  const wavDownload = await download(page, 'export')
  const wav = await readFile(await wavDownload.path())
  expect(wav.readUInt32LE(24)).toBe(44100)
  expect(wav.readUInt16LE(22)).toBe(2)
  expect(wav.readUInt16LE(34)).toBe(24)
  expect(await page.locator('#daw-render-info').textContent()).toBe(previewRevision)
  // A second 24-bit render delivery is bit-identical to the already-previewed
  // cached mix; 16-bit intentionally has TPDF dither and is tested separately.
  const secondWav = await download(page, 'export')
  expect(await readFile(await secondWav.path())).toEqual(wav)
  const zipDownload = await download(page, 'save')
  const zip = await readFile(await zipDownload.path()), saved = manifest(zip)
  expect(saved.project.assets.map(asset => asset.sampleRate)).toEqual([44100, 44100])
  expect(saved.project.assets.map(asset => asset.channels)).toEqual([2, 2])
  expect(saved.project.tracks.reduce((sum, track) => sum + track.clips.length, 0)).toBe(4)
  expect(saved.project.masterGainDb).toBe(-2)
  expect(saved.project.tracks[0].gainDb).toBe(-3)
  expect(saved.project.tracks.flatMap(track => track.clips).find(clip => clip.id === selectedClipId)).toMatchObject({ fadeInSeconds: .05, fadeOutSeconds: .05 })
  await page.screenshot({ path: testInfo.outputPath('editor-desktop.png'), fullPage: true })
  page.once('dialog', dialog => dialog.accept())
  await action(page, 'clear').click()
  await expect(page.locator('#daw-summary')).toContainText('0 軌 · 0 片段')
  await page.locator('#daw-project-file').setInputFiles({ name: 'roundtrip.waveforge.zip', mimeType: 'application/zip', buffer: zip })
  await expect(page.locator('#daw-status')).toContainText('工程已還原')
  await expect(page.locator('.daw-clip')).toHaveCount(4)
  const restoredZipDownload = await download(page, 'save')
  expect(manifest(await readFile(await restoredZipDownload.path())).project).toEqual(saved.project)
  const restoredWavDownload = await download(page, 'export')
  expect(await readFile(await restoredWavDownload.path())).toEqual(wav)
  await action(page, 'master').click()
  await expect(page.locator('#mode-master')).toBeVisible()
  await expect(page.locator('#upload-text-wrap')).toContainText('未命名專案.wav')
  await expect(page.locator('#export-btn')).toBeEnabled()
  await page.locator('#tab-editor').click()
  await expect(page.locator('.daw-clip')).toHaveCount(4)
  expect(errors).toEqual([])
  expect(uploads).toEqual([])
})

test('mobile keyboard workflow, sticky transport and reduced motion remain usable', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await startEditor(page)
  const selected = page.locator('.daw-clip').first()
  await selected.click()
  await selected.press('ArrowRight')
  await expect(page.locator('#daw-clip-at')).toHaveValue('0.5')
  await page.locator('#daw-timeline').focus()
  await page.keyboard.press('Control+z')
  await expect(page.locator('#daw-clip-at')).toHaveValue('0')
  await page.locator('#daw-timeline').press('Space')
  await expect(action(page, 'play')).toHaveText('暫停')
  await action(page, 'stop').click()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)
  expect(overflow).toBe(false)
  for (const command of ['play', 'stop', 'import', 'undo']) {
    const box = await action(page, command).boundingBox()
    expect(box.height).toBeGreaterThanOrEqual(44)
  }
  const captureGeometry = () => page.evaluate(() => {
    const describe = selector => {
      const element = document.querySelector(selector), rect = element.getBoundingClientRect()
      return { selector, rect: rect.toJSON(), clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
        clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop,
        overflowX: getComputedStyle(element).overflowX, overflowY: getComputedStyle(element).overflowY }
    }
    const outsideEditorControls = [...document.querySelectorAll('#mode-editor button, #mode-editor input, #mode-editor select')]
      .filter(element => !element.closest('#daw-timeline')) // The timeline deliberately scrolls horizontally.
      .filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')
      .map(element => ({ id: element.id || element.dataset.daw || element.textContent, rect: element.getBoundingClientRect().toJSON() }))
      .filter(({ rect }) => rect.left < -1 || rect.right > innerWidth + 1)
    return { viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, windowScrollY: scrollY,
      containers: ['html', 'body', '#app', '#mode-editor', '.daw-inspector', '.daw-transport'].map(describe), outsideEditorControls }
  })
  // Mobile body is its own scroller (100dvh + overflow-y:auto). Resetting only
  // window/editor leaves it scrolled; fullPage then captures a long blank canvas.
  const beforeReset = await captureGeometry()
  await page.evaluate(() => {
    for (const element of [document.scrollingElement, document.documentElement, document.body,
      document.getElementById('app'), document.getElementById('mode-editor')]) {
      if (element) { element.scrollTop = 0; element.scrollLeft = 0 }
    }
    window.scrollTo(0, 0)
  })
  await expect(page.locator('#app > .header')).toBeInViewport()
  await expect(page.locator('#mode-editor h1')).toBeInViewport()
  const top = await captureGeometry()
  expect(top.viewport).toMatchObject({ width: 390, height: 844 })
  expect(top.outsideEditorControls).toEqual([])
  for (const selector of ['html', 'body', '#app', '#mode-editor']) {
    const geometry = top.containers.find(item => item.selector === selector)
    expect(geometry.rect.left, selector).toBeGreaterThanOrEqual(-1)
    expect(geometry.rect.right, selector).toBeLessThanOrEqual(391)
    expect(geometry.scrollTop, selector).toBe(0)
  }
  const header = await page.locator('#app > .header').boundingBox()
  expect(header.y).toBeGreaterThanOrEqual(0)
  expect(header.y + header.height).toBeLessThanOrEqual(844)
  const transport = await page.locator('.daw-transport').boundingBox()
  expect(transport.y).toBeGreaterThanOrEqual(0)
  expect(transport.y + transport.height).toBeLessThanOrEqual(845)
  // Viewport captures are exactly what the user sees; do not expand the capture
  // to nested scrollHeight or let fullPage's scroll extents masquerade as width.
  const topScreenshot = await page.screenshot({ path: testInfo.outputPath('editor-mobile-top.png'), fullPage: false, scale: 'css' })
  expect([topScreenshot.readUInt32BE(16), topScreenshot.readUInt32BE(20)]).toEqual([390, 844])
  await page.locator('.daw-inspector').evaluate(inspector => inspector.scrollIntoView({ block: 'start', inline: 'nearest' }))
  await expect(page.locator('#daw-selection-title')).toBeInViewport()
  await expect(page.locator('#daw-clip-name')).toBeInViewport()
  await expect(action(page, 'move')).toBeInViewport()
  const inspector = await captureGeometry()
  expect(inspector.viewport).toMatchObject({ width: 390, height: 844 })
  expect(inspector.outsideEditorControls).toEqual([])
  const inspectorScreenshot = await page.screenshot({ path: testInfo.outputPath('editor-mobile-inspector.png'), fullPage: false, scale: 'css' })
  expect([inspectorScreenshot.readUInt32BE(16), inspectorScreenshot.readUInt32BE(20)]).toEqual([390, 844])
  await testInfo.attach('editor-mobile-geometry.json', { body: JSON.stringify({ beforeReset, top, inspector }, null, 2), contentType: 'application/json' })
})

test('bad audio and declined clear preserve the current editor project', async ({ page }) => {
  await startEditor(page)
  await page.locator('#daw-audio-files').setInputFiles({ name: 'broken.wav', mimeType: 'audio/wav', buffer: Buffer.from('not a WAV') })
  await expect(page.locator('#daw-status')).toHaveAttribute('data-error', 'true')
  await expect(page.locator('.daw-clip')).toHaveCount(2)
  page.once('dialog', dialog => dialog.dismiss())
  await action(page, 'clear').click()
  await expect(page.locator('.daw-clip')).toHaveCount(2)
  await action(page, 'play').click()
  await expect(action(page, 'play')).toHaveText('暫停')
  await page.locator('#tab-lyrics').click()
  await page.locator('#tab-editor').click()
  await expect(action(page, 'play')).toHaveText('播放混音')
})
