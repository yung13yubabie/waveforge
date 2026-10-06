/** Development-module DSP assertions with actual OfflineAudioContext; no mocks. */
import { test, expect } from '@playwright/test'

test('automation commands multiply fades in actual samples, preserving edits, split and trim', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const { createProject, registerAudioBuffer, applyCommand, getClipEnvelope, getClipVolumeAutomation, envelopeValueAt } = await import('/src/js/daw/project.js')
    const { renderProject } = await import('/src/js/daw/render.js')
    const original = new AudioBuffer({ length: 36000, sampleRate: 48000, numberOfChannels: 2 })
    for (let channel = 0; channel < 2; channel++) original.getChannelData(channel).fill(.125)
    const buffers = new Map()
    let project = registerAudioBuffer(createProject(), buffers, original, { id: 'source' }).project
    project = applyCommand(project, { type: 'track.add', track: { id: 'track' } })
    project = applyCommand(project, { type: 'clip.add', trackId: 'track', clip: { id: 'clip', assetId: 'source', atSeconds: .125, offsetSeconds: .0625, durationSeconds: .5, fadeInSeconds: .25, fadeOutSeconds: .125 } })
    for (const point of [{ timeSeconds: .125, value: 2 }, { timeSeconds: .375, value: .25 }]) {
      project = applyCommand(project, { type: 'clip.automation.add', trackId: 'track', clipId: 'clip', point })
    }
    const base = await renderProject(project, buffers)
    const errorAgainstRecipe = (output, metadata) => {
      let error = 0
      for (let i = 0; i < output.length; i++) {
        const seconds = i / output.sampleRate
        let expected = 0
        for (const clip of metadata.tracks[0].clips) {
          const local = seconds - clip.atSeconds
          if (local >= 0 && local < clip.durationSeconds) expected += .125 * envelopeValueAt(getClipEnvelope(clip), local) * envelopeValueAt(getClipVolumeAutomation(clip), local)
        }
        for (let channel = 0; channel < 2; channel++) error = Math.max(error, Math.abs(output.getChannelData(channel)[i] - expected))
      }
      return error
    }
    const split = applyCommand(project, { type: 'clip.split', trackId: 'track', clipId: 'clip', atSeconds: .3125, newId: 'right' })
    const splitMix = await renderProject(split, buffers)
    const trimmed = applyCommand(project, { type: 'clip.trim', trackId: 'track', clipId: 'clip', startSeconds: .1875, endSeconds: .5625 })
    const trimMix = await renderProject(trimmed, buffers)
    const edited = applyCommand(project, { type: 'clip.automation.update', trackId: 'track', clipId: 'clip', index: 1, patch: { timeSeconds: .1875, value: .5 } })
    const editedMix = await renderProject(edited, buffers)
    let splitError = 0, trimError = 0
    for (let i = 0; i < base.buffer.length; i++) splitError = Math.max(splitError, Math.abs(base.buffer.getChannelData(0)[i] - splitMix.buffer.getChannelData(0)[i]))
    for (let i = .1875 * 48000; i < trimMix.buffer.length; i++) trimError = Math.max(trimError, Math.abs(base.buffer.getChannelData(0)[i] - trimMix.buffer.getChannelData(0)[i]))
    return { baseError: errorAgainstRecipe(base.buffer, project), editedError: errorAgainstRecipe(editedMix.buffer, edited), splitError, trimError,
      beforeAtQuarter: base.buffer.getChannelData(0)[12000], afterAtQuarter: editedMix.buffer.getChannelData(0)[12000],
      originalUnchanged: buffers.get('source') === original && original.getChannelData(0).every(value => value === .125) }
  })
  expect(result.baseError).toBeLessThan(1e-5)
  expect(result.editedError).toBeLessThan(1e-5)
  expect(result.splitError).toBeLessThan(1e-5)
  expect(result.trimError).toBeLessThan(1e-5)
  expect(result.beforeAtQuarter).toBeCloseTo(.125, 5)
  expect(result.afterAtQuarter).toBeCloseTo(1 / 24, 5)
  expect(result.originalUnchanged).toBe(true)
})

