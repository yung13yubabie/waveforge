import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDawPanel } from '../../src/js/daw/panel.js'
import { applyCommand } from '../../src/js/daw/project.js'
import { getClipGainRegionSegments } from '../../src/js/daw/gain-regions.js'
import { renderProject } from '../../src/js/daw/render.js'
import { exportProjectArchive, importProjectArchive } from '../../src/js/daw/archive.js'
vi.mock('../../src/js/audio/sha256.js', () => ({ sha256Hex: vi.fn(async () => 'a'.repeat(64)) }))
vi.mock('../../src/js/daw/render.js', () => ({ renderProject: vi.fn(), getPendingNativeRenderBytes: () => 0 }))
vi.mock('../../src/js/daw/archive.js', () => ({ exportProjectArchive: vi.fn(async () => new Blob(['zip'])), importProjectArchive: vi.fn(), archiveFileName: () => 'project.zip', ARCHIVE_LIMITS: { archiveBytes: 256 * 1024 * 1024, manifestBytes: 1024 * 1024 } }))
const html = readFileSync('index.html', 'utf8'), el = id => document.getElementById(`daw-${id}`), action = id => document.querySelector(`[data-daw="${id}"]`)
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const click = async id => {
  action(id).click(); await tick()
  if (id === 'export') { await new Promise(resolve => setTimeout(resolve, 0)); await tick() }
}
const change = async (id, value, type = 'input') => { el(id).value = String(value); el(id).dispatchEvent(new Event(type, { bubbles: true })); await tick() }
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
const file = { name: 'voice.wav', size: 8, arrayBuffer: async () => new ArrayBuffer(8) }
const snapshot = () => ({ version: 1, token: 'lyrics:1', ready: true, blocker: null, precision: 'sentence', sessionRevision: 1,
  source: { name: 'song.wav', hash: 'f'.repeat(64), duration: 4 }, line: { id: 'line-1', text: '這是一句歌詞', start: .5, end: 3.5, sung: true, confirmed: true, timingOrigin: 'manual' } })
let panel, audio, ctx, lyric, publish, unsubscribe, download
async function setup(options = {}) {
  document.body.replaceChildren(new DOMParser().parseFromString(html, 'text/html').getElementById('app'))
  document.getElementById('mode-editor').hidden = false
  ctx = new AudioContext(); vi.spyOn(ctx, 'createBufferSource')
  audio = ctx.createBuffer(1, 4 * 48000, 48000); audio.getChannelData(0).fill(.125)
  lyric = snapshot(); unsubscribe = vi.fn(); download = vi.fn()
  panel = initDawPanel({ decodeAsset: async () => audio, downloadFile: download, confirmAction: () => true, AudioContextClass: function () { return ctx },
    getLyricSelection: () => structuredClone(lyric), subscribeLyricSelection: listener => { publish = listener; return unsubscribe }, ...options })
  await panel.importFiles([file]); return panel
}
const clip = () => panel.getProject().tracks[0].clips[0]
async function range(start = .5, end = 1.5, gain = 0) {
  await change('region-start', start); await change('region-end', end); await change('region-gain', gain)
}
async function prepare(start = .5, end = 1.5, gain = 0) {
  await click('region-designate'); await range(start, end, gain); await panel.prepareGainRegions()
}
beforeEach(() => { vi.clearAllMocks(); renderProject.mockImplementation(async project => ({ buffer: audio, revision: project.revision, peak: .125, peaks: { samplePeakDb: -18, truePeakDb: -18 } })) })
afterEach(() => { panel?.destroy(); document.body.replaceChildren(); vi.restoreAllMocks() })

function regionGainAt(clip, localSeconds) {
  const segment = getClipGainRegionSegments(clip).find(segment => localSeconds >= segment.startSeconds && localSeconds < segment.endSeconds)
  if (!segment) throw new Error('Probe must lie within the clip')
  return segment.startGain + (segment.endGain - segment.startGain) * (localSeconds - segment.startSeconds) / (segment.endSeconds - segment.startSeconds)
}
function intendedGain(time, start, end, fadeIn, fadeOut, gain = 0) {
  if (time < start || time >= end) return 1
  const strength = Math.min(1, fadeIn ? (time - start) / fadeIn : 1, fadeOut ? (end - time) / fadeOut : 1)
  return 1 - (1 - gain) * strength
}

describe('reversible vocal region UI', () => {
  it('requires explicit vocal designation and clock alignment, with sentence-only and mixed-track disclosures', async () => {
    await setup()
    expect(el('region-details').open).toBe(false); expect(el('region-lyrics').open).toBe(false)
    expect(el('region-warning').textContent).toContain('伴奏也會一起降低')
    expect(el('region-help').textContent).toContain('歌詞提供整句時間')
    expect(action('region-prepare').disabled).toBe(true)
    expect(() => panel.prepareGainRegions()).toThrow('請先指定')
  })
  it('normalizes control characters only in the copied label and keeps HTML-looking lyrics literal', async () => {
    await setup()
    const text = '<img src=x onerror="globalThis.__regionXss=1">第一\t句' + '歌'.repeat(130)
    lyric.line.text = text
    const originalLyrics = structuredClone(lyric)
    publish(); await click('region-designate'); await change('region-offset', 0); await click('region-use-lyric')
    const expected = text.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120)
    expect(el('region-label').value).toBe(expected)
    expect(el('region-lyric').textContent).toContain(text)
    expect(el('region-lyric').querySelector('img')).toBeNull()
    await panel.prepareGainRegions(); await click('replacement-confirm')
    expect(clip().gainRegions[0].label).toBe(expected)
    expect(lyric).toEqual(originalLyrics)
    expect(document.querySelector('#mode-editor [onerror]')).toBeNull()
    expect(globalThis.__regionXss).toBeUndefined()
  })
  it('never treats an empty alignment as zero, then maps an explicitly entered offset without subtitle offsets', async () => {
    await setup(); await click('region-designate')
    await click('region-use-lyric')
    expect(el('status').textContent).toContain('明確填入'); expect(el('replacement-review').hidden).toBe(true)
    await change('region-offset', 0); await click('region-use-lyric')
    expect(el('region-start').value).toBe('0.5'); expect(el('region-end').value).toBe('3.5')
    await panel.prepareGainRegions(); expect(el('replacement-review').dataset.kind).toBe('gain-regions')
    expect(el('replacement-summary').textContent).toContain('尚未接受')
  })
  it('stages real metadata, previews full mixes, saves/exports the original before Accept and preserves all other tracks', async () => {
    await setup(); await panel.importFiles([{ ...file, name: 'accompaniment.wav' }]); document.querySelector('.daw-clip').click()
    const before = panel.getProject(), pcm = audio.getChannelData(0).slice()
    await prepare(.5, 1.5, 25)
    expect(panel.getProject()).toEqual(before)
    await click('replacement-preview')
    const staged = renderProject.mock.calls.at(-1)[0]
    expect(staged.tracks[0].clips[0].gainRegions[0]).toMatchObject({ startSeconds: .5, endSeconds: 1.5, gain: .25, fadeInSeconds: .01, fadeOutSeconds: .01 })
    expect(staged.tracks[1]).toEqual(before.tracks[1]); expect(staged.assets).toEqual(before.assets)
    expect(ctx.createBufferSource).toHaveBeenCalledOnce()
    await click('stop'); await click('replacement-original'); expect(renderProject.mock.calls.at(-1)[0]).toEqual(before)
    await click('stop'); await click('save'); expect(exportProjectArchive.mock.calls.at(-1)[0]).toEqual(before)
    await click('export'); expect(panel.getProject()).toEqual(before)
    action('replacement-confirm').focus(); await click('replacement-confirm')
    expect(clip().gainRegions[0].gain).toBe(.25); expect(document.activeElement).toBe(action('region-prepare'))
    expect(panel.getProject().tracks[1]).toEqual(before.tracks[1]); expect(audio.getChannelData(0)).toEqual(pcm)
    await click('save'); expect(exportProjectArchive.mock.calls.at(-1)[0]).toEqual(panel.getProject())
    await click('undo'); expect(panel.getProject()).toEqual(before)
    await click('redo'); expect(clip().gainRegions[0].gain).toBe(.25)
    expect(document.querySelectorAll('.daw-region-cue')).toHaveLength(1)
  })
  it('accepts one lyric span across clips atomically and undoes the entire change once', async () => {
    await setup(); el('seek').value = '2'; el('seek').dispatchEvent(new Event('input')); await click('split')
    const before = panel.getProject()
    await click('region-designate'); await change('region-offset', 0); await click('region-use-lyric')
    await panel.prepareGainRegions(); await click('replacement-preview')
    const draft = renderProject.mock.calls.at(-1)[0]
    expect(draft.tracks[0].clips.map(clip => clip.gainRegions[0])).toMatchObject([
      { startSeconds: .5, endSeconds: 2 }, { startSeconds: 0, endSeconds: 1.5 },
    ])
    expect(el('replacement-summary').textContent).toContain('2 片段')
    await click('stop'); await click('replacement-confirm'); expect(panel.getProject().tracks[0].clips.every(clip => clip.gainRegions.length === 1)).toBe(true)
    await click('undo'); expect(panel.getProject()).toEqual(before)
  })
  it('keeps a continuous mute through an internal clip split instead of restarting either edge fade', async () => {
    await setup(); el('seek').value = '1'; el('seek').dispatchEvent(new Event('input')); await click('split')
    const before = panel.getProject()
    await click('region-designate'); await range(.25, 1.75)
    await change('region-fade-in', 100); await change('region-fade-out', 100)
    await panel.prepareGainRegions(); await click('replacement-confirm')
    const clips = panel.getProject().tracks[0].clips
    expect(regionGainAt(clips[0], .95)).toBe(0)
    expect(regionGainAt(clips[1], .05)).toBe(0)
    for (const clip of clips) {
      for (let local = .003; local < clip.durationSeconds; local += .0137) {
        expect(regionGainAt(clip, local)).toBeCloseTo(intendedGain(clip.atSeconds + local, .25, 1.75, .1, .1), 11)
      }
    }
    expect(clips[0].gainRegions[0].fadeOutSeconds).toBe(0)
    expect(clips[1].gainRegions[0].fadeInSeconds).toBe(0)
    await click('undo'); expect(panel.getProject()).toEqual(before)
  })
  it('preserves one timeline fade across a gap, including a fade partially consumed before the next clip', async () => {
    await setup(); el('seek').value = '1'; el('seek').dispatchEvent(new Event('input')); await click('split')
    document.querySelectorAll('.daw-clip')[1].click(); el('snap').checked = false
    await change('clip-at', 1.5, 'change'); await click('move')
    await click('region-designate'); await range(.25, 2.5)
    await change('region-fade-in', 1500); await change('region-fade-out', 250)
    await panel.prepareGainRegions(); expect(el('replacement-summary').textContent).toContain('1 段空白')
    await click('replacement-confirm')
    const clips = panel.getProject().tracks[0].clips
    expect(regionGainAt(clips[1], .01)).toBeCloseTo(intendedGain(1.51, .25, 2.5, 1.5, .25), 12)
    expect(clips[1].gainRegions[0].attenuationEnvelope[0].value).toBeCloseTo(1.25 / 1.5, 12)
    for (const clip of clips) {
      for (let local = .003; local < clip.durationSeconds; local += .0137) {
        expect(regionGainAt(clip, local)).toBeCloseTo(intendedGain(clip.atSeconds + local, .25, 2.5, 1.5, .25), 11)
      }
    }
  })
  it('uses the same global shape on overlapping clips and preserves the cropped shape through gain-only edits', async () => {
    await setup(); await click('duplicate'); document.querySelectorAll('.daw-clip')[1].click(); el('snap').checked = false
    await change('clip-at', .5, 'change'); await click('move')
    await click('region-designate'); await range(.25, 1.75)
    await change('region-fade-in', 500); await change('region-fade-out', 500)
    await panel.prepareGainRegions(); await click('replacement-confirm')
    const before = panel.getProject(), clips = before.tracks[0].clips, cropped = clips[1].gainRegions[0]
    expect(regionGainAt(clips[0], .6)).toBeCloseTo(regionGainAt(clips[1], .1), 12)
    expect(cropped.attenuationEnvelope[0].value).toBeCloseTo(.5, 12)
    for (const clip of clips) {
      for (let local = .003; local < clip.durationSeconds; local += .0137) {
        expect(regionGainAt(clip, local)).toBeCloseTo(intendedGain(clip.atSeconds + local, .25, 1.75, .5, .5), 11)
      }
    }
    await change('region-select', cropped.id, 'change'); await change('region-gain', 40)
    await panel.prepareGainRegions(); expect(el('replacement-summary').textContent).toContain('1 片段')
    await click('replacement-confirm')
    const after = panel.getProject().tracks[0].clips
    expect(after[0]).toEqual(clips[0]); expect(after[1].gainRegions[0].attenuationEnvelope).toEqual(cropped.attenuationEnvelope)
    for (let local = .003; local < after[1].durationSeconds; local += .0137) {
      expect(regionGainAt(after[1], local)).toBeCloseTo(intendedGain(after[1].atSeconds + local, .25, 1.75, .5, .5, .4), 11)
    }
  })
  it('shows uncovered ranges and never adds a region to an unrelated track', async () => {
    await setup(); await click('duplicate'); const controls = document.querySelectorAll('.daw-clip'); controls[1].click()
    el('snap').checked = false; await change('clip-at', 5, 'change'); await click('move')
    await prepare(3, 6)
    expect(el('replacement-summary').textContent).toContain('1 段空白不處理（00:04.000–00:05.000）')
    await click('replacement-confirm')
    expect(panel.getProject().tracks[0].clips.map(clip => clip.gainRegions[0])).toMatchObject([{ startSeconds: 3, endSeconds: 4 }, { startSeconds: 0, endSeconds: 1 }])
  })
  it.each(['settings', 'lyrics', 'source', 'selection', 'project', 'navigation', 'clear', 'cancel'])('discards a ready lyric candidate after %s and cannot accept it', async interruption => {
    await setup(); await panel.importFiles([{ ...file, name: 'other.wav' }]); document.querySelector('.daw-clip').click()
    await click('region-designate'); await change('region-offset', 0); await click('region-use-lyric'); await panel.prepareGainRegions()
    if (interruption === 'settings') await change('region-gain', 50)
    else if (interruption === 'lyrics') { lyric.line.text = '更新歌詞'; lyric.token = 'lyrics:2'; publish() }
    else if (interruption === 'source') { lyric.source.hash = 'b'.repeat(64); lyric.token = 'lyrics:2'; publish() }
    else if (interruption === 'selection') document.querySelectorAll('.daw-clip')[1].click()
    else if (interruption === 'project') await change('tempo', 130, 'change')
    else if (interruption === 'navigation') document.dispatchEvent(new CustomEvent('wf:mode-change', { detail: { mode: 'lyrics' } }))
    else if (interruption === 'clear') panel.clear()
    else await click('replacement-cancel')
    const after = panel.getProject()
    expect(el('replacement-review').hidden).toBe(true)
    expect(() => panel.confirmReplacement()).toThrow()
    expect(panel.getProject()).toEqual(after)
    expect(after.tracks.every(track => track.clips.every(clip => !clip.gainRegions))).toBe(true)
  })
  it('rechecks uncommitted fields and silent lyric changes at Accept', async () => {
    await setup(); await prepare(); const before = panel.getProject()
    el('region-start').value = '0.75'; expect(() => panel.confirmReplacement()).toThrow()
    expect(panel.getProject()).toEqual(before)
    await click('region-use-lyric'); await change('region-offset', 0); await click('region-use-lyric'); await panel.prepareGainRegions()
    lyric.sessionRevision++; expect(() => panel.confirmReplacement()).toThrow()
    expect(panel.getProject()).toEqual(before)
  })
  it('rejects asynchronous B completion after a lyric change and never starts a player', async () => {
    await setup(); await click('region-designate'); await change('region-offset', 0); await click('region-use-lyric'); await panel.prepareGainRegions()
    const pending = deferred(); renderProject.mockReturnValueOnce(pending.promise)
    action('replacement-preview').click(); await tick()
    lyric.token = 'changed'; publish()
    pending.resolve({ buffer: audio, peak: .125, peaks: { truePeakDb: -18 } }); await tick()
    expect(ctx.createBufferSource).not.toHaveBeenCalled(); expect(el('replacement-review').hidden).toBe(true)
    expect(clip().gainRegions).toBeUndefined()
  })
  it('cannot revive audio when Cancel interrupts beforePlayback', async () => {
    const pending = deferred(); await setup({ beforePlayback: () => pending.promise }); await prepare()
    action('replacement-preview').click(); await tick(); await click('replacement-cancel')
    pending.resolve(); await tick()
    expect(renderProject).not.toHaveBeenCalled(); expect(ctx.createBufferSource).not.toHaveBeenCalled()
    expect(clip().gainRegions).toBeUndefined()
  })
  it('edits, removes and resets saved regions without requiring lyrics, and preserves an exact cropped envelope on gain-only edits', async () => {
    await setup(); await prepare(.5, 2, 0); await click('replacement-confirm')
    await change('trim-start', .505, 'change'); await change('trim-end', 4, 'change'); await click('trim')
    const cropped = clip(), saved = panel.getProject(), savedId = cropped.gainRegions[0].id
    expect(cropped.gainRegions[0].attenuationEnvelope).toBeDefined()
    lyric = { version: 1, ready: false, blocker: '請重新連結歌詞原音檔' }; publish()
    importProjectArchive.mockResolvedValueOnce({ project: saved, files: new Map([[saved.assets[0].id, file]]), buffers: new Map([[saved.assets[0].id, audio]]) })
    await panel.openArchive(new Blob(['zip'])); document.querySelector('.daw-clip').click()
    expect(el('region-offset').value).toBe(''); expect(action('region-designate').disabled).toBe(false)
    expect(el('region-title').textContent).toContain('1'); expect(document.querySelectorAll('.daw-region-cue')).toHaveLength(1)
    await change('region-select', savedId, 'change'); expect(action('region-prepare').disabled).toBe(false)
    await change('region-gain', 40); await panel.prepareGainRegions(); await click('replacement-confirm')
    expect(clip().gainRegions[0]).toEqual({ ...cropped.gainRegions[0], gain: .4 })
    await click('undo'); expect(clip()).toEqual(cropped); await click('redo')
    await click('region-remove'); expect(clip().gainRegions).toBeUndefined(); await click('undo')
    await click('region-reset'); expect(clip().gainRegions).toBeUndefined(); await click('undo'); expect(clip().gainRegions).toHaveLength(1)
  })
  it('keeps the whole project unchanged if a later intersecting clip reaches its region limit', async () => {
    await setup(); await click('duplicate')
    let saved = panel.getProject(); const [first, second] = saved.tracks[0].clips, trackId = saved.tracks[0].id
    saved = applyCommand(saved, { type: 'clip.gainRegion.addMany', trackId, clipId: second.id, regions: Array.from({ length: 64 }, (_, i) => ({ id: `r-${i}`, startSeconds: 0, endSeconds: 1, gain: .5 })) })
    importProjectArchive.mockResolvedValueOnce({ project: saved, files: new Map(), buffers: new Map([[saved.assets[0].id, audio]]) })
    await panel.openArchive(new Blob(['zip'])); document.querySelector('.daw-clip').click()
    await click('region-designate'); await range(3, 5)
    expect(() => panel.prepareGainRegions()).toThrow('64'); expect(panel.getProject()).toEqual(saved)
    expect(clip().id).toBe(first.id); expect(clip().gainRegions).toBeUndefined(); expect(action('undo').disabled).toBe(true)
  })
  it('rejects blank, inverted and out-of-range controls, then permits corrected input and unsubscribe on destroy', async () => {
    await setup(); await click('region-designate'); const before = panel.getProject()
    for (const [start, end, gain] of [['', 1, 0], [2, 1, 0], [.5, 1, 101], [.5, 1, -1], [8, 9, 0]]) {
      await range(start, end, gain); expect(() => panel.prepareGainRegions()).toThrow(); expect(panel.getProject()).toEqual(before)
    }
    await range(.5, .501); await panel.prepareGainRegions(); await click('replacement-confirm')
    expect(clip().gainRegions[0].fadeInSeconds).toBeCloseTo(.0005, 12)
    panel.destroy(); expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
