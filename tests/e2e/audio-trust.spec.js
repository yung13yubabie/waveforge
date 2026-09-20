import { test, expect } from '@playwright/test'
import { encodeWAV } from '../../src/js/audio/wav.js'

test('96 kHz source retains above-24-kHz audio before 96 kHz export', async ({ page }) => {
  const samples = Float32Array.from({ length: 9600 }, (_, i) => 0.2 * Math.sin(2 * Math.PI * 30000 * i / 96000))
  await page.goto('/')
  await page.setInputFiles('#file-input', { name: '高解析來源.wav', mimeType: 'audio/wav', buffer: Buffer.from(encodeWAV([samples, samples], 96000)) })
  await expect(page.locator('#export-btn')).toBeEnabled()
  const result = await page.evaluate(() => {
    const { buffer } = window.__wf.engine
    const x = buffer.getChannelData(0)
    return { rate: buffer.sampleRate, rms: Math.sqrt(x.reduce((sum, sample) => sum + sample * sample, 0) / x.length) }
  })
  expect(result.rate).toBe(96000)
  expect(result.rms).toBeCloseTo(0.2 / Math.sqrt(2), 5)
})

test('MBC dry and wet unity impulses align at every export rate', async ({ page }, testInfo) => {
  await page.goto('/')
  const rows = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/js/audio/engine.js')
    const { renderMasterChain } = await import('/src/js/audio/render-chain.js')
    const rows = []
    for (const sr of [44100, 48000, 96000]) {
      const source = new AudioBuffer({ numberOfChannels: 2, length: 8192, sampleRate: sr })
      source.getChannelData(0)[1024] = 0.25
      const peaks = []
      for (const mix of [0, 25, 50, 75, 100]) {
        const e = new AudioEngine()
        for (const key in e.bypassed) e.bypassed[key] = key !== 'comp'
        e.params.mbcMix = mix; e.params.mbcRatio = [1, 1, 1]; e.params.compKnee = 0
        const out = await renderMasterChain({ engine: e, sourceBuffer: source, params: e.serialize().params, bypassed: e.bypassed, sampleRate: sr })
        const x = out.getChannelData(0)
        let index = 0
        for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > Math.abs(x[index])) index = i
        peaks.push({ mix, index, value: x[index] })
      }
      rows.push({ sr, peaks })
    }
    return rows
  })
  await testInfo.attach('mbc-latency.json', { body: JSON.stringify(rows), contentType: 'application/json' })
  for (const row of rows) {
    expect(new Set(row.peaks.map(p => p.index)).size, JSON.stringify(row)).toBe(1)
    for (const peak of row.peaks) expect(peak.value).toBeCloseTo(0.25 * (1 - peak.mix / 100) + row.peaks[4].value * peak.mix / 100, 5)
  }
})

test('monitor volume leaves export PCM unchanged', async ({ page }) => {
  await page.goto('/')
  const residual = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/js/audio/engine.js')
    const { renderMasterChain } = await import('/src/js/audio/render-chain.js')
    const e = new AudioEngine()
    for (const key in e.bypassed) e.bypassed[key] = true
    const source = new AudioBuffer({ numberOfChannels: 2, length: 2048, sampleRate: 48000 })
    source.getChannelData(0)[16] = 0.5
    const values = []
    for (const gain of [1, 0.5, 0.1]) {
      e.setMonitorGain(gain)
      const out = await renderMasterChain({ engine: e, sourceBuffer: source, params: e.serialize().params, bypassed: e.bypassed, sampleRate: 48000 })
      values.push(out.getChannelData(0)[16])
    }
    return values
  })
  expect(residual).toEqual([0.5, 0.5, 0.5])
})

test('all-bypassed master is an identity, including limiter input and time', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/js/audio/engine.js')
    const { renderMasterChain } = await import('/src/js/audio/render-chain.js')
    const e = new AudioEngine(); e.params.masterVol = 1; e.params.limInput = 12
    for (const key in e.bypassed) e.bypassed[key] = true
    const source = new AudioBuffer({ numberOfChannels: 2, length: 4096, sampleRate: 48000 })
    source.getChannelData(0)[32] = 0.5; source.getChannelData(1)[32] = -0.25
    const out = await renderMasterChain({ engine: e, sourceBuffer: source, params: e.params, bypassed: e.bypassed, sampleRate: 48000 })
    let peak = 0
    for (let c = 0; c < 2; c++) for (let i = 0; i < source.length; i++) peak = Math.max(peak, Math.abs(source.getChannelData(c)[i] - out.getChannelData(c)[i]))
    return peak
  })
  expect(result).toBeLessThan(1e-6)
})

test('neutral stem DSP preserves impulse timing and samples', async ({ page }) => {
  await page.goto('/')
  const residual = await page.evaluate(async () => {
    const { processStem } = await import('/src/js/audio/stem-mix.js')
    const b = new AudioBuffer({ length: 4096, numberOfChannels: 2, sampleRate: 48000 })
    b.getChannelData(0)[32] = 0.8; b.getChannelData(1)[32] = -0.4
    const out = await processStem(b, { lowGain: 0, midGain: 0, highGain: 0, thresh: -24, ratio: 4, eqEnabled: false, compEnabled: false }, 1)
    let error = 0
    for (let c = 0; c < 2; c++) for (let i = 0; i < b.length; i++) error = Math.max(error, Math.abs(out.getChannelData(c)[i] - b.getChannelData(c)[i]))
    return error
  })
  expect(residual).toBeLessThan(1e-6)
})
