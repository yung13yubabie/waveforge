/** Actual main wiring, real pitch Worker and native Web Audio. Synthetic PCM only. */
import { test, expect } from '@playwright/test'
import { encodeWAV } from '../../src/js/audio/wav.js'

function fixture({ name = 'pitch-synthetic.wav', duration = 3.2, frequency = 440, silent = false, gaps = false, stereo = false } = {}) {
  const sampleRate = 44100, length = Math.round(sampleRate * duration)
  const channels = Array.from({ length: stereo ? 2 : 1 }, (_, channel) => {
    const pcm = new Float32Array(length)
    for (let i = 0; i < length; i++) {
      const time = i / sampleRate
      if (silent || (gaps && time >= 1 && time < 1.8)) continue
      const hz = channel ? 220 : gaps && time >= 1.8 ? 220 : frequency
      pcm[i] = .16 * Math.sin(2 * Math.PI * hz * time)
    }
    return pcm
  })
  return { name, mimeType: 'audio/wav', buffer: Buffer.from(encodeWAV(channels, sampleRate, 24)) }
}
async function load(page, options) {
  await page.setInputFiles('#file-input', fixture(options))
  await expect(page.locator('#export-btn')).toBeEnabled()
  await expect(page.locator('#pitch-source')).toContainText(options?.name ?? 'pitch-synthetic.wav')
}
async function start(page, options) {
  await page.goto('/')
  await load(page, options)
  await page.locator('#tab-pitch').click()
  await expect(page.locator('#mode-pitch')).toBeVisible()
  await expect(page.locator('.header-actions')).toBeHidden()
  await expect(page.locator('.header > .upload-zone')).toBeVisible()
}
async function setField(page, id, value) {
  await page.locator(`#pitch-${id}`).fill(String(value))
}
async function inspectNativeAudio(page) {
  await page.addInitScript(() => {
    window.__pitchNativeAudit = { tones: [], sources: [] }
    const createOscillator = AudioContext.prototype.createOscillator
    AudioContext.prototype.createOscillator = function () {
      const node = createOscillator.call(this), context = this
      const record = { started: false, frequency: null, ended: false, stoppedEarly: false }
      window.__pitchNativeAudit.tones.push(record)
      const start = node.start.bind(node), stop = node.stop.bind(node)
      node.start = (...args) => { record.started = true; record.frequency = node.frequency.value; record.type = node.type; record.contextState = context.state; return start(...args) }
      node.stop = (...args) => { if (!args.length || args[0] <= context.currentTime) record.stoppedEarly = true; return stop(...args) }
      node.addEventListener('ended', () => { record.ended = true })
      return node
    }
    const createBufferSource = AudioContext.prototype.createBufferSource
    AudioContext.prototype.createBufferSource = function () {
      const node = createBufferSource.call(this)
      const start = node.start.bind(node), record = { started: false }
      window.__pitchNativeAudit.sources.push(record)
      node.start = (...args) => {
        record.started = true; record.args = args; record.duration = node.buffer?.duration; record.sampleRate = node.buffer?.sampleRate
        return start(...args)
      }
      return node
    }
  })
}

async function mobileViewportCapture(page, testInfo, name, anchor, visibleSelectors) {
  await page.evaluate(selector => {
    const panel = document.getElementById('mode-pitch')
    // Only the panel should scroll. Playwright's generic scrollIntoView can also
    // move the overflow-hidden body/app ancestors, invalidating a viewport shot.
    const resetOuter = () => {
      window.scrollTo(0, 0)
      for (const element of [document.documentElement, document.body, document.getElementById('app')]) {
        element.scrollTop = 0; element.scrollLeft = 0
      }
    }
    resetOuter(); panel.scrollLeft = 0; panel.scrollTop = 0
    if (selector) {
      const target = document.querySelector(selector)
      panel.scrollTop = target.getBoundingClientRect().top - panel.getBoundingClientRect().top - 12
    }
    resetOuter()
  }, anchor)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const geometry = await page.evaluate(() => {
    const app = document.getElementById('app').getBoundingClientRect()
    const panel = document.getElementById('mode-pitch')
    const box = panel.getBoundingClientRect()
    return { width: innerWidth, height: innerHeight, x: scrollX, y: scrollY,
      app: { x: app.x, y: app.y, width: app.width, height: app.height },
      panel: { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: panel.clientWidth, scrollWidth: panel.scrollWidth },
      documentWidth: document.documentElement.scrollWidth,
    }
  })
  expect(geometry).toMatchObject({ width: 390, height: 844, x: 0, y: 0, app: { x: 0, y: 0, width: 390, height: 844 } })
  expect(geometry.documentWidth).toBeLessThanOrEqual(390)
  expect(geometry.panel.right).toBeLessThanOrEqual(390)
  expect(geometry.panel.bottom).toBeLessThanOrEqual(844)
  expect(geometry.panel.scrollWidth).toBeLessThanOrEqual(geometry.panel.width)
  for (const selector of visibleSelectors) {
    const box = await page.locator(selector).boundingBox()
    expect(box, `${selector} is rendered`).not.toBeNull()
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
    expect(box.y).toBeGreaterThanOrEqual(geometry.panel.y)
    expect(box.y + box.height).toBeLessThanOrEqual(844)
  }
  const png = await page.screenshot({ path: testInfo.outputPath(name), fullPage: false, scale: 'css' })
  // IHDR dimensions verify the actual attached artifact, not just page settings.
  expect(png.readUInt32BE(16)).toBe(390)
  expect(png.readUInt32BE(20)).toBe(844)
}

test('real worker estimates synthetic notes, preserves unknown gaps, and explains reference distance without uploads', async ({ page }, testInfo) => {
  const errors = [], writes = [], remoteModels = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    if (['POST', 'PUT', 'PATCH'].includes(request.method())) writes.push(request.url())
    if (/huggingface|cdn-lfs|\.onnx(?:\?|$)/.test(request.url())) remoteModels.push(request.url())
  })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await start(page, { gaps: true })
  await expect(page.locator('#pitch-contour .pitch-estimate')).toHaveCount(0)
  await expect(page.locator('#pitch-waveform .pitch-wave-shape')).toHaveCount(1)
  await page.locator('#pitch-analyze').click()
  await expect(page.locator('#pitch-status')).toContainText('分析完成')
  await expect(page.locator('#pitch-contour .pitch-estimate')).toHaveCount(1)
  expect(await page.locator('#pitch-contour .pitch-unknown').count()).toBeGreaterThan(0)
  const commands = await page.locator('#pitch-contour .pitch-estimate').getAttribute('d')
  expect(commands.match(/M/g).length).toBeGreaterThan(1)
  await expect(page.locator('#pitch-point-readout')).toContainText('A4')
  await expect(page.locator('#pitch-point-readout')).toContainText('Hz')
  await page.locator('#pitch-target').selectOption('70')
  await expect(page.locator('#pitch-point-readout')).toContainText('低 100 音分')
  await page.locator('#pitch-point').evaluate(input => { input.value = '65'; input.dispatchEvent(new Event('input', { bubbles: true })) })
  await expect(page.locator('#pitch-point-readout')).toContainText('無明確音高')
  await expect(page.locator('#pitch-point-readout')).not.toContainText('Hz')
  await page.locator('#pitch-data summary').click()
  await expect(page.locator('#pitch-rows tr')).toHaveCount(12)
  await expect(page.locator('#pitch-page')).toContainText('61–72')
  await expect(page.locator('#pitch-summary')).toContainText('不是正確率')
  await page.screenshot({ path: testInfo.outputPath('pitch-real-worker-desktop.png'), fullPage: true })
  expect(writes).toEqual([]); expect(remoteModels).toEqual([]); expect(errors).toEqual([])
})

test('native sine reference and exact raw source playback are exclusive and stop on navigation', async ({ page }) => {
  await inspectNativeAudio(page)
  await start(page)
  expect(await page.evaluate(() => window.__pitchNativeAudit.tones)).toEqual([])
  await page.locator('#pitch-play-tone').click()
  await expect(page.locator('#pitch-preview-status')).toContainText('B · A4')
  expect(await page.evaluate(() => window.__pitchNativeAudit.tones.at(-1))).toMatchObject({ started: true, frequency: 440, type: 'sine', contextState: 'running' })
  await page.locator('#pitch-play-original').click()
  await expect(page.locator('#pitch-preview-status')).toContainText('A · 原音試聽')
  expect(await page.evaluate(() => window.__pitchNativeAudit.tones.at(-1).stoppedEarly)).toBe(true)
  const raw = await page.evaluate(() => window.__pitchNativeAudit.sources.filter(source => source.started).at(-1))
  expect(raw.args[1]).toBe(0); expect(raw.duration).toBeCloseTo(3.2, 3); expect(raw.sampleRate).toBe(44100)
  await page.locator('#pitch-play-tone').click()
  await expect(page.locator('#pitch-preview-status')).toContainText('B · A4')
  await page.getByRole('tab', { name: '母帶處理', exact: true }).click()
  await expect(page.locator('.header-actions')).toBeVisible()
  expect(await page.evaluate(() => window.__pitchNativeAudit.tones.at(-1).stoppedEarly)).toBe(true)
  await page.locator('#tab-pitch').click()
  await setField(page, 'start', .2); await setField(page, 'end', .4)
  await page.locator('#pitch-play-original').click()
  await expect(page.locator('#pitch-preview-status')).toContainText('原音片段已播完')
})

test('long source selection is bounded, invalid ranges do not analyze, and a later window keeps source time', async ({ page }) => {
  await start(page, { duration: 64 })
  await expect(page.locator('#pitch-end')).toHaveValue('60')
  await expect(page.locator('#pitch-status')).toContainText('前 60 秒')
  await page.locator('#pitch-analyze').click()
  await page.locator('#pitch-cancel').click()
  await expect(page.locator('#pitch-status')).toContainText('已取消分析')
  await expect(page.locator('#pitch-contour .pitch-estimate')).toHaveCount(0)
  await setField(page, 'end', 64)
  await expect(page.locator('#pitch-analyze')).toBeDisabled()
  await expect(page.locator('#pitch-range-error')).toContainText('最多 60 秒')
  await setField(page, 'start', 62)
  await page.locator('#pitch-analyze').click()
  await expect(page.locator('#pitch-status')).toContainText('分析完成')
  await expect(page.locator('#pitch-summary')).toContainText('62.000 秒–64.000 秒')
  await expect(page.locator('#pitch-point')).toHaveAttribute('aria-valuetext', /62\.\d+ 秒/)
  await setField(page, 'end', 62)
  await expect(page.locator('#pitch-range-error')).toContainText('終點')
  await expect(page.locator('#pitch-contour .pitch-estimate')).toHaveCount(0)
})

test('source replacement and session clear remove stale curves and silence is not invented as a note', async ({ page }) => {
  await start(page)
  await page.locator('#pitch-analyze').click()
  await expect(page.locator('#pitch-status')).toContainText('分析完成')
  await load(page, { name: 'synthetic-silence.wav', silent: true })
  await expect(page.locator('#pitch-contour .pitch-estimate')).toHaveCount(0)
  await page.locator('#pitch-analyze').click()
  await expect(page.locator('#pitch-status')).toContainText('未找到可靠音高')
  await expect(page.locator('#pitch-contour .pitch-estimate')).toHaveCount(0)
  await expect(page.locator('#pitch-point-readout')).toContainText('無明確音高')
  await page.getByRole('tab', { name: '母帶處理', exact: true }).click()
  await page.locator('#session-privacy summary').click()
  await page.locator('#clear-session-btn').click()
  await page.locator('#tab-pitch').click()
  await expect(page.locator('#pitch-source')).toHaveText('尚未載入音訊')
  await expect(page.locator('#pitch-waveform .pitch-wave-shape')).toHaveCount(0)
  await expect(page.locator('#pitch-rows tr')).toHaveCount(0)
  await expect(page.locator('#pitch-analyze')).toBeDisabled()
})

test('mobile keyboard controls inspect the real channel without sideways page overflow', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await start(page, { stereo: true })
  await page.locator('#pitch-channel').selectOption('1')
  await page.locator('#pitch-analyze').click()
  await expect(page.locator('#pitch-status')).toContainText('分析完成')
  await expect(page.locator('#pitch-point-readout')).toContainText('A3')
  await expect(page.locator('#pitch-summary')).toContainText('第 2 聲道')
  await page.locator('#pitch-point').scrollIntoViewIfNeeded()
  await page.locator('#pitch-point').focus(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight')
  await expect(page.locator('#pitch-point')).toHaveValue('1')
  await expect(page.locator('#pitch-point-readout')).toContainText('0.052 秒')
  await page.locator('#pitch-point-readout').scrollIntoViewIfNeeded()
  await expect(page.locator('#pitch-point-readout')).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await mobileViewportCapture(page, testInfo, 'pitch-mobile-top.png', null, ['#pitch-title', '#pitch-waveform'])
  await mobileViewportCapture(page, testInfo, 'pitch-mobile-reference.png', '#pitch-reference-title', ['#pitch-reference-title', '#pitch-play-original', '#pitch-play-tone'])
  await mobileViewportCapture(page, testInfo, 'pitch-mobile-chart.png', '#pitch-contour', ['#pitch-contour', '#pitch-point-readout'])
  const axis = await page.locator('#pitch-contour text').first().evaluate(text => {
    const matrix = text.getScreenCTM()
    return { renderedFontSize: parseFloat(getComputedStyle(text).fontSize) * Math.hypot(matrix.a, matrix.b), text: text.textContent }
  })
  expect(axis.renderedFontSize).toBeGreaterThanOrEqual(11)
  await expect(page.locator('#pitch-point-readout')).toContainText('A3')
})
