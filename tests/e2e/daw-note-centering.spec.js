/** Real UI -> native YIN Worker -> native Signalsmith Worker -> Web Audio ->
 * downloaded WAV/ZIP. Generated media only; no successful DSP/decoder doubles.
 * Prepared for permitted browser CI. Discovery/syntax checks do not establish
 * browser success, listening quality, musical correctness or monophony. */
import { test, expect } from '@playwright/test'
import { generateNote } from '../../scripts/test-note-centering.mjs'
import { noise } from '../audio/pitch-shift-fixtures.js'
import { action, review, digest, noteFile, pcmFile, openDetails, openHelper, start, analyze,
  renderCandidate, download, archive, wav, pcmHashes, pitchMeasurements, audit, expectClean,
  attachEvidence, screenshot, observeNative, proof, audition } from './daw-note-centering-helpers.js'

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus || page.isClosed()) return
  // Keep partial real-boundary evidence when a regression prevents the final
  // assertions, including the actual viewport rather than a misleading crop.
  const native = await proof(page).catch(error => ({ unavailable: error.message }))
  await attachEvidence(testInfo, 'note-centering-failure.json', { status: testInfo.status, native })
  await screenshot(page, testInfo, 'note-centering-failure.png')
})

for (const sampleRate of [44100, 48000, 96000]) {
  test(`stable A3 centers native ${sampleRate} Hz stereo through real A/B, Accept, history and fresh ZIP recovery`, async ({ page }, testInfo) => {
    test.setTimeout(150_000)
    const observed = audit(page)
    await observeNative(page)
    const original = noteFile(sampleRate), sourceFrames = wav(original.buffer).frames
    await start(page, original)
    // The source retains its native rate even when the user's output rate differs.
    await openDetails(page, 'daw-output-settings')
    const mixRate = sampleRate === 48000 ? 44100 : 48000
    await page.locator('#daw-sample-rate').selectOption(String(mixRate))
    await page.locator('#daw-bit-depth').selectOption('24')
    const beforeZip = await download(page, 'save'), before = archive(beforeZip)
    const originalMix = await download(page, 'export'), originalClip = before.project.tracks[0].clips[0]
    expect(before.source(originalClip.assetId)).toEqual(original.buffer)

    await analyze(page)
    await expect(page.locator('#daw-note-center-result')).toContainText('目標 A3：整段降低')
    const proposed = await page.locator('#daw-note-center-result').innerText()
    const analyzed = await proof(page)
    expect(analyzed.analysisRequests).toHaveLength(2)
    expect(analyzed.analysisResults).toHaveLength(2)
    expect(analyzed.analysisRequests[0].hash).not.toBe(analyzed.analysisRequests[1].hash)
    for (const request of analyzed.analysisRequests) expect(request).toMatchObject({ sampleRate, start: 0, length: sourceFrames })
    for (const result of analyzed.analysisResults) {
      expect(result).toMatchObject({ engine: 'waveforge-monophonic-yin', sampleRate, start: 0, duration: 1.2 })
      expect(result.summary.medianMidi).toBeGreaterThan(57.30)
      expect(result.summary.medianMidi).toBeLessThan(57.45)
    }
    expect(analyzed.workers).toHaveLength(1)
    expect(analyzed.workers[0]).toMatchObject({ kind: 'analysis', native: true, terminated: true })
    expect(archive(await download(page, 'save')).project).toEqual(before.project)

    await renderCandidate(page)
    const b = await audition(page, 'replacement-preview', 'B：正在試聽')
    const a = await audition(page, 'replacement-original', 'A：正在試聽')
    const ordinary = await audition(page, 'play', '正在播放目前專案混音')
    expect(a.bytes).toEqual(originalMix)
    expect(ordinary.bytes).toEqual(originalMix)
    expect(await download(page, 'export')).toEqual(originalMix)
    expect(archive(await download(page, 'save')).project).toEqual(before.project)
    const candidateProof = await proof(page)
    expect(candidateProof.renderRequests).toHaveLength(1)
    expect(candidateProof.renderResults).toHaveLength(1)
    expect(candidateProof.delayedDeliveries).toEqual([])
    const input = candidateProof.renderRequests[0], generated = candidateProof.renderResults[0]
    expect(input).toMatchObject({ sampleRate, channels: 2, length: sourceFrames })
    expect(input.hashes).toEqual(analyzed.analysisRequests.map(request => request.hash))
    expect(input.options.semitones).toBeCloseTo(-.37, 1)
    expect(generated).toMatchObject({ sampleRate, channels: 2, length: sourceFrames,
      metadata: { engine: 'signalsmith-stretch-1.3.2', semitones: input.options.semitones,
        inputSamples: sourceFrames, outputSamples: sourceFrames, outputGain: 1, timeRatio: 1, bypassed: false } })
    const candidateSource = candidateProof.starts.find(source => source.kind === 'offline' && source.hashes.join() === generated.hashes.join())
    expect(candidateSource).toMatchObject({ native: true, sampleRate, channels: 2, length: sourceFrames, playbackRate: 1, detune: 0 })
    expect(b.metadata).toMatchObject({ sampleRate: mixRate, length: Math.ceil(originalClip.durationSeconds * mixRate), channels: 2, playbackRate: 1, detune: 0 })

    await action(page, 'replacement-confirm').click()
    await expect(review(page)).toBeHidden()
    const acceptedMix = await download(page, 'export'), acceptedZip = await download(page, 'save'), accepted = archive(acceptedZip)
    const acceptedClip = accepted.project.tracks[0].clips[0], acceptedAsset = accepted.project.assets.find(asset => asset.id === acceptedClip.assetId)
    const generatedFile = accepted.source(acceptedAsset.id)
    expect(acceptedMix).toEqual(b.bytes)
    expect(acceptedMix).not.toEqual(originalMix)
    expect(accepted.project.assets).toHaveLength(2)
    expect(acceptedClip).toEqual({ ...originalClip, assetId: acceptedAsset.id, offsetSeconds: 0, transpose: acceptedClip.transpose })
    expect(acceptedClip.transpose).toMatchObject({ version: 1, engine: 'signalsmith-stretch-1.3.2', sourceAssetId: originalClip.assetId,
      sourceOffsetSeconds: 0, sourceDurationSeconds: originalClip.durationSeconds, cropFirstFrame: 0, cropLastFrame: sourceFrames,
      formantSemitones: 0, formantCompensation: false })
    expect(acceptedClip.transpose.semitones + acceptedClip.transpose.cents / 100).toBe(input.options.semitones)
    expect(acceptedAsset).toMatchObject({ sampleRate, sourceSampleRate: sampleRate, channels: 2, length: sourceFrames, decodeBackend: 'generated-float32-wav' })
    expect(wav(generatedFile)).toMatchObject({ rate: sampleRate, frames: sourceFrames, channels: 2, tag: 3, bits: 32 })
    expect(pcmHashes(generatedFile)).toEqual(generated.hashes)
    expect(acceptedAsset.hash).toBe(digest(generatedFile))
    expect(accepted.source(originalClip.assetId)).toEqual(original.buffer)
    expect(wav(acceptedMix).seconds).toBe(wav(originalMix).seconds)
    for (const key of ['sampleRate', 'tempo', 'masterGainDb', 'name']) expect(accepted.project[key]).toEqual(before.project[key])

    // Independent normalized correlation checks real candidate playback, native
    // worker output and the downloaded accepted WAV. No per-sample quality claim.
    const measurements = { original: pitchMeasurements(originalMix), candidatePlayback: pitchMeasurements(b.bytes),
      generatedSource: pitchMeasurements(generatedFile), acceptedWav: pitchMeasurements(acceptedMix) }
    for (const source of measurements.original) {
      expect(source.frames.length).toBeGreaterThanOrEqual(8)
      expect(source.medianCents).toBeGreaterThan(35)
      expect(source.medianCents).toBeLessThan(39)
    }
    for (const outputs of [measurements.candidatePlayback, measurements.generatedSource, measurements.acceptedWav]) {
      for (const measured of outputs) {
        expect(measured.frames.length).toBeGreaterThanOrEqual(8)
        expect(measured.minimumCorrelation).toBeGreaterThan(.95)
        expect(Math.abs(measured.medianCents)).toBeLessThan(10)
        expect(Math.abs(measured.medianCents)).toBeLessThan(Math.abs(measurements.original[measured.channel].medianCents) / 2)
      }
    }
    const acceptedPlayback = await audition(page, 'play', '正在播放目前專案混音')
    expect(acceptedPlayback.bytes).toEqual(acceptedMix)
    // Each transition is exactly one click; no additional analysis or render.
    await action(page, 'undo').click()
    expect(archive(await download(page, 'save')).project).toEqual(before.project)
    expect(await download(page, 'export')).toEqual(originalMix)
    await action(page, 'redo').click()
    expect(archive(await download(page, 'save')).project).toEqual(accepted.project)
    expect(await download(page, 'export')).toEqual(acceptedMix)
    const settled = await proof(page)
    expect(settled.renderRequests).toHaveLength(1)
    expect(settled.analysisRequests).toHaveLength(2)
    expect(settled.workers.every(worker => worker.native && worker.terminated)).toBe(true)

    // Destroy runtime buffers/history and reopen solely from downloaded bytes.
    await page.reload(); await page.locator('#tab-editor').click()
    await expect(page.locator('.daw-clip')).toHaveCount(0)
    await page.locator('#daw-project-file').setInputFiles({ name: 'centered-note.waveforge.zip', mimeType: 'application/zip', buffer: acceptedZip })
    await expect(page.locator('#daw-status')).toContainText('工程已還原')
    await expect(action(page, 'undo')).toBeDisabled()
    expect(await download(page, 'export')).toEqual(acceptedMix)
    const reopened = archive(await download(page, 'save'))
    expect(reopened.project).toEqual(accepted.project)
    expect(reopened.source(acceptedAsset.id)).toEqual(generatedFile)
    expect(reopened.source(originalClip.assetId)).toEqual(original.buffer)
    await page.locator('.daw-clip').click(); await openDetails(page, 'daw-transpose-details')
    await expect(action(page, 'transpose-original')).toBeEnabled()
    await action(page, 'transpose-original').click()
    expect(archive(await download(page, 'save')).project.tracks[0].clips[0]).toEqual(originalClip)
    expect(await download(page, 'export')).toEqual(originalMix)
    await action(page, 'undo').click()
    expect(archive(await download(page, 'save')).project).toEqual(accepted.project)
    expect(await download(page, 'export')).toEqual(acceptedMix)
    const restored = await proof(page)
    expect(restored.workers).toEqual([])
    expect(restored.starts.some(source => source.kind === 'offline' && source.native && source.sampleRate === sampleRate && source.hashes.join() === generated.hashes.join())).toBe(true)
    expectClean(observed)
    await attachEvidence(testInfo, `note-centering-${sampleRate}-native-roundtrip.json`, {
      method: 'Native YIN and Signalsmith workers, native Web Audio, independent normalized correlation in predetermined windows',
      caveat: 'Synthetic pitch evidence only; no listening, singing-accuracy or musical-intent claim',
      proposed, before: before.project, accepted: accepted.project, native: settled, restored,
      playback: { a: a.metadata, b: b.metadata, ordinary: ordinary.metadata, accepted: acceptedPlayback.metadata },
      sha256: { originalSource: digest(original.buffer), originalZip: digest(beforeZip), generatedSource: digest(generatedFile), acceptedWav: digest(acceptedMix), acceptedZip: digest(acceptedZip) },
      measurements, network: observed,
    })
  })
}

test('native analysis keeps near-target notes and refuses noise/disagreeing stereo; reference is a real stoppable 220 Hz oscillator', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  const observed = audit(page), scenarios = []
  await observeNative(page)
  await start(page, noteFile(48000, { detuneCents: 3 }))
  const before = archive(await download(page, 'save')), originalMix = await download(page, 'export')
  await analyze(page)
  await expect(page.locator('#daw-note-center-result')).toContainText('已很接近，建議保留目前聲音')
  await expect(action(page, 'note-center-render')).toBeDisabled()
  await expect(action(page, 'note-center-reference')).toBeEnabled()
  await action(page, 'note-center-reference').click()
  await expect(page.locator('#daw-status')).toContainText('正在播放目標參考音 A3')
  await expect(action(page, 'stop')).toBeEnabled()
  await action(page, 'stop').click()
  await expect.poll(() => page.evaluate(() => window.__noteCenterProof.oscillators[0]?.ended)).toBe(1)
  const stopped = (await proof(page)).oscillators[0]
  expect(stopped.native).toBe(true)
  expect(stopped.starts).toHaveLength(1)
  expect(stopped.starts[0]).toMatchObject({ frequencyHz: 220, type: 'sine' })
  expect(stopped.stops[0].at - stopped.starts[0].at).toBeCloseTo(.81, 5)
  expect(stopped.stops.at(-1).at).toBeNull()
  expect(stopped.disconnects).toBeGreaterThanOrEqual(1)

  // Also establish natural completion and cleanup, independent of Stop.
  await action(page, 'note-center-reference').click()
  await expect.poll(() => page.evaluate(() => window.__noteCenterProof.oscillators[1]?.ended), { timeout: 4000 }).toBe(1)
  await expect(action(page, 'stop')).toBeDisabled()
  const natural = (await proof(page)).oscillators[1]
  expect(natural.starts[0]).toMatchObject({ frequencyHz: 220, type: 'sine' })
  expect(natural.disconnects).toBeGreaterThanOrEqual(1)
  expect(await download(page, 'export')).toEqual(originalMix)
  expect(archive(await download(page, 'save')).project).toEqual(before.project)
  const nearProof = await proof(page)
  expect(nearProof.analysisRequests).toHaveLength(2)
  expect(nearProof.renderRequests).toEqual([])
  expect(nearProof.starts.filter(source => source.kind === 'realtime')).toEqual([])
  scenarios.push({ kind: 'near-target', result: await page.locator('#daw-note-center-result').innerText(), native: nearProof })

  const refusals = [
    { kind: 'deterministic-noise', file: pcmFile([noise(48000, 1.2), noise(48000, 1.2, .15, 43)], 48000, 'synthetic-noise.wav'), message: '沒有足夠可靠的週期音高' },
    { kind: 'stereo-disagreement', file: pcmFile([generateNote(), generateNote({ targetMidi: 58 })], 48000, 'synthetic-disagreeing-notes.wav'), message: '左右聲道的音高中心不一致' },
  ]
  for (const refusal of refusals) {
    await start(page, refusal.file)
    const saved = archive(await download(page, 'save')), original = await download(page, 'export')
    await analyze(page)
    await expect(page.locator('#daw-note-center-result')).toContainText(refusal.message)
    await expect(action(page, 'note-center-render')).toBeDisabled()
    await expect(action(page, 'note-center-reference')).toBeDisabled()
    await expect(review(page)).toBeHidden()
    const native = await proof(page)
    expect(native.analysisRequests).toHaveLength(2)
    expect(native.analysisResults).toHaveLength(2)
    expect(native.renderRequests).toEqual([])
    expect(native.workers.every(worker => worker.native && worker.terminated)).toBe(true)
    const retained = archive(await download(page, 'save'))
    expect(retained.project).toEqual(saved.project)
    expect(retained.source(saved.project.assets[0].id)).toEqual(refusal.file.buffer)
    expect(await download(page, 'export')).toEqual(original)
    scenarios.push({ kind: refusal.kind, result: await page.locator('#daw-note-center-result').innerText(), native })
  }
  expectClean(observed)
  await attachEvidence(testInfo, 'note-centering-refusals-and-reference.json', { scenarios, network: observed })
})

test('cancelling native analysis rejects a delayed real result and permits a clean new analysis', async ({ page }, testInfo) => {
  test.setTimeout(100_000)
  const observed = audit(page)
  await observeNative(page); await start(page)
  const before = archive(await download(page, 'save')).project, originalMix = await download(page, 'export')
  await page.evaluate(() => { window.__noteCenterDeliveryGate.kind = 'analysis' })
  await action(page, 'note-center-analyze').click()
  await expect.poll(() => page.evaluate(() => window.__noteCenterDeliveryGate.held.length), { timeout: 40_000 }).toBe(1)
  await expect(page.locator('#mode-editor')).toHaveAttribute('aria-busy', 'true')
  await action(page, 'cancel').click()
  await expect(page.locator('#mode-editor')).toHaveAttribute('aria-busy', 'false')
  await page.evaluate(() => window.__noteCenterDeliveryGate.release())
  await expect(page.locator('#daw-note-center-result')).toHaveText('尚未分析')
  await expect(action(page, 'note-center-render')).toBeDisabled()
  await expect(review(page)).toBeHidden()
  expect(archive(await download(page, 'save')).project).toEqual(before)
  expect(await download(page, 'export')).toEqual(originalMix)
  const canceled = await proof(page)
  expect(canceled.analysisRequests).toHaveLength(1)
  expect(canceled.analysisResults).toHaveLength(1)
  expect(canceled.delayedDeliveries).toEqual([{ kind: 'analysis', workerId: 1, afterTermination: true }])
  expect(canceled.renderRequests).toEqual([])
  await analyze(page); await renderCandidate(page)
  const retried = await proof(page)
  expect(retried.analysisRequests).toHaveLength(3)
  expect(retried.analysisResults).toHaveLength(3)
  expect(retried.renderRequests).toHaveLength(1)
  expect(retried.renderResults).toHaveLength(1)
  expect(retried.renderRequests[0].hashes).toEqual(retried.analysisRequests.slice(-2).map(request => request.hash))
  await action(page, 'replacement-cancel').click()
  await expect(review(page)).toBeHidden()
  expect(archive(await download(page, 'save')).project).toEqual(before)
  expect(await download(page, 'export')).toEqual(originalMix)
  expectClean(observed)
  await attachEvidence(testInfo, 'note-centering-cancel-delayed-analysis.json', {
    faultInjection: 'An actual native analysis result was withheld at the installed application callback and delivered unchanged after worker termination; the retry used normal native delivery',
    canceled, retried, network: observed,
  })
})

test('navigation rejects a delayed real render result and fresh analysis cannot revive its stale candidate', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  const observed = audit(page)
  await observeNative(page); await start(page)
  const before = archive(await download(page, 'save')).project, originalMix = await download(page, 'export')
  await analyze(page)
  await page.evaluate(() => { window.__noteCenterDeliveryGate.kind = 'render' })
  await action(page, 'note-center-render').click()
  await expect.poll(() => page.evaluate(() => window.__noteCenterDeliveryGate.held.length), { timeout: 60_000 }).toBe(1)
  await expect(page.locator('#mode-editor')).toHaveAttribute('aria-busy', 'true')
  await page.locator('#tab-lyrics').click()
  await page.evaluate(() => window.__noteCenterDeliveryGate.release())
  await page.locator('#tab-editor').click(); await openHelper(page)
  await expect(page.locator('#mode-editor')).toHaveAttribute('aria-busy', 'false')
  await expect(page.locator('#daw-note-center-result')).toHaveText('尚未分析')
  await expect(action(page, 'note-center-render')).toBeDisabled()
  await expect(review(page)).toBeHidden()
  await expect(action(page, 'replacement-confirm')).toBeHidden()
  expect(archive(await download(page, 'save')).project).toEqual(before)
  expect(await download(page, 'export')).toEqual(originalMix)
  const navigated = await proof(page)
  expect(navigated.delayedDeliveries).toEqual([{ kind: 'render', workerId: 2, afterTermination: true }])
  expect(navigated.renderRequests).toHaveLength(1)
  expect(navigated.renderResults).toHaveLength(1)
  await analyze(page)
  // Deliberately choose another valid reference so the new candidate is distinct.
  await page.locator('#daw-note-center-target').selectOption('58')
  await expect(page.locator('#daw-note-center-result')).toContainText('目標 A♯3：整段提高')
  await renderCandidate(page)
  const retried = await proof(page)
  expect(retried.analysisRequests).toHaveLength(4)
  expect(retried.renderRequests).toHaveLength(2)
  expect(retried.renderResults).toHaveLength(2)
  expect(retried.renderRequests[1].options.semitones).toBeCloseTo(.63, 1)
  expect(retried.renderResults[1].hashes).not.toEqual(retried.renderResults[0].hashes)
  await action(page, 'replacement-confirm').click()
  const accepted = archive(await download(page, 'save')), clip = accepted.project.tracks[0].clips[0]
  expect(pcmHashes(accepted.source(clip.assetId))).toEqual(retried.renderResults[1].hashes)
  expect(accepted.project.assets).toHaveLength(2)
  await action(page, 'undo').click()
  expect(archive(await download(page, 'save')).project).toEqual(before)
  expect(await download(page, 'export')).toEqual(originalMix)
  expectClean(observed)
  await attachEvidence(testInfo, 'note-centering-navigation-delayed-render.json', {
    faultInjection: 'An actual Signalsmith worker result was withheld at the installed application callback and delivered unchanged after navigation and termination; the A-sharp retry used normal native delivery',
    navigated, retried, accepted: accepted.project, network: observed,
  })
})

async function layoutEvidence(page, controls) {
  const dimensions = await page.evaluate(() => ({ viewport: innerWidth,
    documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth,
    appWidth: document.getElementById('app').scrollWidth, documentScrollLeft: document.documentElement.scrollLeft,
    bodyScrollLeft: document.body.scrollLeft, appScrollLeft: document.getElementById('app').scrollLeft }))
  for (const key of ['documentWidth', 'bodyWidth', 'appWidth']) expect(dimensions[key]).toBeLessThanOrEqual(dimensions.viewport + 1)
  for (const key of ['documentScrollLeft', 'bodyScrollLeft', 'appScrollLeft']) expect(dimensions[key]).toBe(0)
  const transport = await page.locator('.daw-transport').boundingBox(), boxes = []
  await expect(page.locator('.daw-transport')).toBeInViewport()
  for (const control of controls) {
    await expect(control).toBeInViewport()
    const box = await control.boundingBox()
    expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44)
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(dimensions.viewport)
    expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(transport.y)
    expect(await control.evaluate(element => {
      const box = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
    })).toBe(true)
    boxes.push({ text: await control.innerText(), ...box })
  }
  return { ...dimensions, transport, controls: boxes }
}

for (const width of [1440, 390]) {
  test(`single-note helper stays collapsed and its proposal and candidate remain reachable at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(100_000)
    const observed = audit(page)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await observeNative(page); await start(page, noteFile(), { expand: false })
    await expect(page.locator('#daw-transpose-details')).not.toHaveAttribute('open', '')
    await expect(page.locator('#daw-note-center-details')).not.toHaveAttribute('open', '')
    await expect(action(page, 'note-center-analyze')).toBeHidden()
    const collapsed = await layoutEvidence(page, [])
    await screenshot(page, testInfo, `note-center-collapsed-${width}.png`)

    await openDetails(page, 'daw-transpose-details')
    await expect(page.locator('#daw-note-center-details')).not.toHaveAttribute('open', '')
    const summary = page.locator('#daw-note-center-details > summary')
    await summary.focus(); await page.keyboard.press('Enter')
    await page.keyboard.press('Tab'); await expect(action(page, 'note-center-analyze')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(action(page, 'note-center-render')).toBeEnabled({ timeout: 40_000 })
    await expect(page.locator('#daw-note-center-result')).toContainText('目標 A3')
    // Only vertical user-style scrolling. Never reset scrollLeft to conceal overflow.
    await page.locator('#daw-note-center-details').evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }))
    const proposal = await layoutEvidence(page, [summary, action(page, 'note-center-analyze'), page.locator('#daw-note-center-target'), action(page, 'note-center-reference'), action(page, 'note-center-render')])
    await screenshot(page, testInfo, `note-center-proposal-${width}.png`)

    await renderCandidate(page)
    await expect(page.locator('#daw-replacement-details')).not.toHaveAttribute('open', '')
    await review(page).evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }))
    const commands = ['replacement-original', 'replacement-preview', 'replacement-confirm', 'replacement-cancel']
    const candidate = await layoutEvidence(page, commands.map(command => action(page, command)))
    await screenshot(page, testInfo, `note-center-candidate-${width}.png`)
    const original = await audition(page, 'replacement-original', 'A：正在試聽')
    const processed = await audition(page, 'replacement-preview', 'B：正在試聽')
    expect(processed.bytes).not.toEqual(original.bytes)
    await action(page, 'replacement-cancel').focus(); await page.keyboard.press('Enter')
    await expect(review(page)).toBeHidden()
    await expect(action(page, 'transpose-render')).toBeFocused()
    expect((await proof(page)).renderRequests).toHaveLength(1)
    expectClean(observed)
    await attachEvidence(testInfo, `note-center-layout-${width}.json`, { viewport: page.viewportSize(), collapsed, proposal, candidate, native: await proof(page), network: observed })
  })
}
