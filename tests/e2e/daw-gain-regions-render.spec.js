/** Native OfflineAudioContext checks, with independent per-sample expectations.
 * Synthetic sources only. Assertions run once per result, never per sample. */
import { test, expect } from '@playwright/test'
import { writeFile } from 'node:fs/promises'

async function prepare(page) {
  await page.goto('/')
  await page.evaluate(async () => {
    window.gainRegionTest = {
      ...await import('/src/js/daw/project.js'),
      ...await import('/src/js/daw/render.js'),
    }
  })
}

for (const rate of [44100, 48000, 96000]) for (const shape of ['steps', 'overlapping-ramps']) {
  test(`native ${rate} Hz gain regions preserve accompaniment and existing envelopes: ${shape}`, async ({ page }, testInfo) => {
    await prepare(page)
    const result = await page.evaluate(async ({ rate, shape }) => {
      const { createProject, registerAudioBuffer, applyCommand, renderProject } = window.gainRegionTest
      const buffers = new Map()
      let project = createProject({ sampleRate: rate })
      for (const [id, values] of [['vocal', [.125, -.0625]], ['backing', [.03125, -.015625]]]) {
        const buffer = new AudioBuffer({ length: rate, sampleRate: rate, numberOfChannels: 2 })
        values.forEach((value, channel) => buffer.getChannelData(channel).fill(value))
        project = registerAudioBuffer(project, buffers, buffer, { id, name: `synthetic-${id}.wav` }).project
        project = applyCommand(project, { type: 'track.add', track: { id } })
        project = applyCommand(project, { type: 'clip.add', trackId: id, clip: { id: `${id}-clip`, assetId: id,
          ...(id === 'vocal' && shape === 'overlapping-ramps' ? { fadeInSeconds: .1, fadeOutSeconds: .1,
            volumeAutomation: [{ timeSeconds: 0, value: .5 }, { timeSeconds: .5, value: 1.5 }, { timeSeconds: 1, value: 1 }] } : {}) } })
      }
      const backingBefore = JSON.stringify(project.tracks[1])
      const regions = shape === 'steps'
        ? [{ id: 'mute', startSeconds: .25, endSeconds: .5, gain: 0, fadeInSeconds: 0, fadeOutSeconds: 0 },
          { id: 'quiet', startSeconds: .5, endSeconds: .75, gain: .25, fadeInSeconds: 0, fadeOutSeconds: 0 }]
        : [{ id: 'falling', startSeconds: .1, endSeconds: .9, gain: .2, fadeInSeconds: .4, fadeOutSeconds: .2 },
          { id: 'rising', startSeconds: .2, endSeconds: .8, gain: .4, fadeInSeconds: .1, fadeOutSeconds: .45 }]
      project = applyCommand(project, { type: 'clip.gainRegion.addMany', trackId: 'vocal', clipId: 'vocal-clip', regions })
      const rendered = (await renderProject(project, buffers)).buffer
      // Independent definition of the user's region, not the compiled segment
      // helper used by the renderer. The ramps cross at .38, between input knots.
      const regionGain = (region, t) => {
        if (t < region.startSeconds || t >= region.endSeconds) return 1
        const into = t - region.startSeconds, remaining = region.endSeconds - t
        const strength = Math.min(1, region.fadeInSeconds ? into / region.fadeInSeconds : 1,
          region.fadeOutSeconds ? remaining / region.fadeOutSeconds : 1)
        return 1 - (1 - region.gain) * strength
      }
      let maxError = 0, sourceChanged = false
      const points = []
      for (let channel = 0; channel < 2; channel++) {
        const voice = channel ? -.0625 : .125, backing = channel ? -.015625 : .03125
        const data = rendered.getChannelData(channel)
        for (let frame = 0; frame < rate; frame++) {
          const t = frame / rate
          const mask = Math.min(...regions.map(region => regionGain(region, t)))
          const fade = shape === 'steps' ? 1 : Math.min(1, t / .1, (1 - t) / .1)
          const automation = shape === 'steps' ? 1 : t <= .5 ? .5 + 2 * t : 2 - t
          const expected = backing + voice * fade * automation * mask
          maxError = Math.max(maxError, Math.abs(data[frame] - expected))
          sourceChanged ||= buffers.get('vocal').getChannelData(channel)[frame] !== voice ||
            buffers.get('backing').getChannelData(channel)[frame] !== backing
        }
        points.push(...[.249, .25, .379, .38, .381, .499, .5, .749, .75].map(time => ({ channel, time, sample: data[Math.round(time * rate)] })))
      }
      return { rate: rendered.sampleRate, frames: rendered.length, channels: rendered.numberOfChannels,
        maxError, sourceChanged, backingMetadataUnchanged: JSON.stringify(project.tracks[1]) === backingBefore, points }
    }, { rate, shape })
    expect(result.rate).toBe(rate); expect(result.frames).toBe(rate); expect(result.channels).toBe(2)
    expect(result.maxError).toBeLessThan(0.000002)
    expect(result.sourceChanged).toBe(false); expect(result.backingMetadataUnchanged).toBe(true)
    const path = testInfo.outputPath(`native-gain-regions-${rate}-${shape}.json`)
    await writeFile(path, JSON.stringify(result, null, 2))
    await testInfo.attach('native-gain-regions.json', { path, contentType: 'application/json' })
  })
}

for (const rate of [44100, 48000, 96000]) {
  test(`native ${rate} Hz split and trim retain partially consumed region fades without changing backing`, async ({ page }) => {
    await prepare(page)
    const result = await page.evaluate(async rate => {
      const { createProject, registerAudioBuffer, applyCommand, renderProject } = window.gainRegionTest
      const buffers = new Map()
      let project = createProject({ sampleRate: rate })
      for (const [id, value] of [['vocal', .125], ['backing', .03125]]) {
        const buffer = new AudioBuffer({ length: rate, sampleRate: rate, numberOfChannels: 2 })
        buffer.getChannelData(0).fill(value); buffer.getChannelData(1).fill(-value)
        project = registerAudioBuffer(project, buffers, buffer, { id }).project
        project = applyCommand(project, { type: 'track.add', track: { id } })
        project = applyCommand(project, { type: 'clip.add', trackId: id, clip: { id: `${id}-clip`, assetId: id } })
      }
      project = applyCommand(project, { type: 'clip.gainRegion.add', trackId: 'vocal', clipId: 'vocal-clip',
        region: { id: 'phrase', startSeconds: .1, endSeconds: .9, gain: 0, fadeInSeconds: .4, fadeOutSeconds: .2 } })
      const base = (await renderProject(project, buffers)).buffer
      const split = applyCommand(project, { type: 'clip.split', trackId: 'vocal', clipId: 'vocal-clip', atSeconds: .4, newId: 'vocal-right' })
      const splitBuffer = (await renderProject(split, buffers)).buffer
      const trimmed = applyCommand(project, { type: 'clip.trim', trackId: 'vocal', clipId: 'vocal-clip', startSeconds: .2, endSeconds: .8 })
      const trimBuffer = (await renderProject(trimmed, buffers)).buffer
      let splitError = 0, trimError = 0
      for (let channel = 0; channel < 2; channel++) for (let frame = 0; frame < rate; frame++) {
        const original = base.getChannelData(channel)[frame]
        splitError = Math.max(splitError, Math.abs(splitBuffer.getChannelData(channel)[frame] - original))
        const expected = frame >= .2 * rate && frame < .8 * rate ? original : channel ? -.03125 : .03125
        trimError = Math.max(trimError, Math.abs(trimBuffer.getChannelData(channel)[frame] - expected))
      }
      return { frames: [base.length, splitBuffer.length, trimBuffer.length], splitError, trimError,
        backingUnchanged: JSON.stringify(project.tracks[1]) === JSON.stringify(split.tracks[1]) && JSON.stringify(project.tracks[1]) === JSON.stringify(trimmed.tracks[1]) }
    }, rate)
    expect(result.frames).toEqual([rate, rate, rate])
    expect(result.splitError).toBeLessThan(0.000002); expect(result.trimError).toBeLessThan(0.000002)
    expect(result.backingUnchanged).toBe(true)
  })
}
