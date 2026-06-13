import { describe, it, expect } from 'vitest'
import { assembleAlbum, FRAME_SAMPLES } from '../../src/js/audio/album-assembly.js'

function ramp(n, v = 0.5) { const a = new Float32Array(n); a.fill(v); return a }

describe('assembleAlbum', () => {
  it('empty album → empty output', () => {
    const r = assembleAlbum([])
    expect(r.totalSamples).toBe(0)
    expect(r.markers).toEqual([])
  })

  it('every track starts on a CD frame boundary (588-sample multiple)', () => {
    const r = assembleAlbum([
      { left: ramp(1000), right: ramp(1000), gapBeforeSec: 2 },
      { left: ramp(2000), right: ramp(2000), gapBeforeSec: 0 },
      { left: ramp(589),  right: ramp(589),  gapBeforeSec: 1 },
    ])
    for (const m of r.markers) {
      expect((m.startFrame * FRAME_SAMPLES) % FRAME_SAMPLES).toBe(0)  // trivially true
      expect(Number.isInteger(m.startFrame)).toBe(true)
    }
    // total length is a whole number of frames
    expect(r.totalSamples % FRAME_SAMPLES).toBe(0)
  })

  it('2s lead-in gap before track 1 = 150 frames at 44.1k', () => {
    const r = assembleAlbum([{ left: ramp(588), right: ramp(588), gapBeforeSec: 2 }])
    expect(r.markers[0].startFrame).toBe(150)   // 2 * 75
    expect(r.markers[0].startSec).toBeCloseTo(2, 6)
  })

  it('pads a partial-frame track up to a whole frame', () => {
    // 589 samples → 2 frames (1176 samples)
    const r = assembleAlbum([{ left: ramp(589), right: ramp(589), gapBeforeSec: 0 }])
    expect(r.markers[0].lengthFrames).toBe(2)
    expect(r.totalSamples).toBe(2 * FRAME_SAMPLES)
  })

  it('places each track audio at its frame offset and silences the gaps', () => {
    const t1 = ramp(588, 0.5)
    const t2 = ramp(588, 0.9)
    const r = assembleAlbum([
      { left: t1, right: t1, gapBeforeSec: 0 },
      { left: t2, right: t2, gapBeforeSec: 1 },   // 75-frame gap
    ])
    // track 1 at frame 0
    expect(r.left[0]).toBeCloseTo(0.5, 6)
    // gap region (frames 1..75 → samples 588..588+75*588) is silence
    const gapStart = 1 * FRAME_SAMPLES
    expect(r.left[gapStart + 10]).toBe(0)
    // track 2 at frame 76 (1 track frame + 75 gap frames)
    expect(r.markers[1].startFrame).toBe(76)
    expect(r.left[76 * FRAME_SAMPLES]).toBeCloseTo(0.9, 6)
  })

  it('gapless (gap 0) tracks abut on frame boundaries', () => {
    const r = assembleAlbum([
      { left: ramp(1176), right: ramp(1176), gapBeforeSec: 0 },  // 2 frames
      { left: ramp(588),  right: ramp(588),  gapBeforeSec: 0 },  // 1 frame
    ])
    expect(r.markers[0].startFrame).toBe(0)
    expect(r.markers[1].startFrame).toBe(2)   // right after track 1's 2 frames
    expect(r.totalFrames).toBe(3)
  })

  it('carries ISRC and title through to markers', () => {
    const r = assembleAlbum([
      { left: ramp(588), right: ramp(588), isrc: 'US-ABC-25-00001', title: 'Opener' },
    ])
    expect(r.markers[0].isrc).toBe('US-ABC-25-00001')
    expect(r.markers[0].title).toBe('Opener')
    expect(r.markers[0].index).toBe(1)
  })
})
