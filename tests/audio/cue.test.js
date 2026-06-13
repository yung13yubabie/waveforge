import { describe, it, expect } from 'vitest'
import { framesToMSF, generateCue } from '../../src/js/audio/cue.js'

describe('framesToMSF', () => {
  it('converts frames to MM:SS:FF (75 frames/sec)', () => {
    expect(framesToMSF(0)).toBe('00:00:00')
    expect(framesToMSF(75)).toBe('00:01:00')     // 1 second
    expect(framesToMSF(76)).toBe('00:01:01')
    expect(framesToMSF(150)).toBe('00:02:00')    // 2 second lead-in
    expect(framesToMSF(4500)).toBe('01:00:00')   // 1 minute
    expect(framesToMSF(74)).toBe('00:00:74')     // max frame value
  })
})

describe('generateCue', () => {
  const markers = [
    { index: 1, startFrame: 150, isrc: 'US-ABC-25-00001', title: 'Opener' },
    { index: 2, startFrame: 9000, isrc: '', title: 'Second' },
  ]

  it('emits FILE + per-track TRACK/INDEX lines', () => {
    const cue = generateCue({ imageFile: 'album.wav', markers })
    expect(cue).toContain('FILE "album.wav" WAVE')
    expect(cue).toContain('TRACK 01 AUDIO')
    expect(cue).toContain('INDEX 01 00:02:00')   // track 1 at frame 150
    expect(cue).toContain('TRACK 02 AUDIO')
    expect(cue).toContain('INDEX 01 02:00:00')   // frame 9000 = 2 min
  })

  it('strips dashes from ISRC to the 12-char CUE form', () => {
    const cue = generateCue({ imageFile: 'a.wav', markers })
    expect(cue).toContain('ISRC USABC2500001')
    // track 2 has no ISRC → no ISRC line in its block
    expect(cue.match(/ISRC/g).length).toBe(1)
  })

  it('includes album title, performer and CATALOG when provided', () => {
    const cue = generateCue({ imageFile: 'a.wav', markers, albumTitle: 'My EP', performer: 'Artist', upc: '0123456789012' })
    expect(cue).toContain('TITLE "My EP"')
    expect(cue).toContain('PERFORMER "Artist"')
    expect(cue).toContain('CATALOG 0123456789012')
  })

  it('omits optional metadata cleanly when absent', () => {
    const cue = generateCue({ imageFile: 'a.wav', markers: [{ index: 1, startFrame: 0 }] })
    expect(cue).not.toContain('CATALOG')
    expect(cue).not.toContain('PERFORMER')
    expect(cue).toContain('TRACK 01 AUDIO')
    expect(cue).toContain('INDEX 01 00:00:00')
  })

  it('sanitizes quotes/newlines in titles (no CUE injection)', () => {
    const cue = generateCue({ imageFile: 'a.wav', markers: [{ index: 1, startFrame: 0, title: 'Bad"\nTITLE "x' }] })
    expect(cue).not.toContain('Bad"')
    // only the legitimate structure, no injected second TITLE
    expect(cue.match(/TRACK/g).length).toBe(1)
  })
})
