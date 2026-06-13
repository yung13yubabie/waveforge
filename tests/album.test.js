import { describe, it, expect, beforeEach } from 'vitest'
import { Album, loudnessTrim } from '../src/js/album.js'

describe('Album', () => {
  let album
  beforeEach(() => { album = new Album() })

  it('starts empty', () => {
    expect(album.length).toBe(0)
    expect(album.tracks).toEqual([])
  })

  it('add() assigns a unique id and fills defaults', () => {
    const t = album.add({ title: 'Song A', lufs: -12 })
    expect(t.id).toBeGreaterThan(0)
    expect(t.title).toBe('Song A')
    expect(t.lufs).toBe(-12)
    expect(t.gainTrimDb).toBe(0)
    expect(t.gapBeforeSec).toBe(2)
    expect(t.isrc).toBe('')
    expect(album.length).toBe(1)
  })

  it('add() gives each track a distinct id', () => {
    const a = album.add({ title: 'A' })
    const b = album.add({ title: 'B' })
    expect(a.id).not.toBe(b.id)
  })

  it('remove() deletes by id and reports success', () => {
    const a = album.add({ title: 'A' })
    album.add({ title: 'B' })
    expect(album.remove(a.id)).toBe(true)
    expect(album.length).toBe(1)
    expect(album.tracks[0].title).toBe('B')
    expect(album.remove(9999)).toBe(false)
  })

  it('move() reorders up and down', () => {
    const a = album.add({ title: 'A' })
    const b = album.add({ title: 'B' })
    const c = album.add({ title: 'C' })
    expect(album.move(c.id, -1)).toBe(true)        // C up → A, C, B
    expect(album.tracks.map(t => t.title)).toEqual(['A', 'C', 'B'])
    expect(album.move(a.id, 1)).toBe(true)         // A down → C, A, B
    expect(album.tracks.map(t => t.title)).toEqual(['C', 'A', 'B'])
  })

  it('move() respects boundaries (no wrap)', () => {
    const a = album.add({ title: 'A' })
    const b = album.add({ title: 'B' })
    expect(album.move(a.id, -1)).toBe(false)       // already first
    expect(album.move(b.id, 1)).toBe(false)        // already last
    expect(album.tracks.map(t => t.title)).toEqual(['A', 'B'])
  })

  it('update() patches fields', () => {
    const a = album.add({ title: 'A' })
    expect(album.update(a.id, { gainTrimDb: -2.5, gapBeforeSec: 4, isrc: 'US-ABC-25-00001' })).toBe(true)
    const t = album.get(a.id)
    expect(t.gainTrimDb).toBe(-2.5)
    expect(t.gapBeforeSec).toBe(4)
    expect(t.isrc).toBe('US-ABC-25-00001')
    expect(album.update(9999, { gainTrimDb: 1 })).toBe(false)
  })

  it('get() returns the track or null', () => {
    const a = album.add({ title: 'A' })
    expect(album.get(a.id).title).toBe('A')
    expect(album.get(9999)).toBeNull()
  })

  it('preserves insertion order and the per-track snapshot reference', () => {
    const snapA = { version: 1, params: { masterVol: 0.5 } }
    const a = album.add({ title: 'A', snapshot: snapA })
    album.add({ title: 'B' })
    expect(album.tracks[0].snapshot).toBe(snapA)
  })

  it('clear() empties the album', () => {
    album.add({ title: 'A' }); album.add({ title: 'B' })
    album.clear()
    expect(album.length).toBe(0)
  })
})

describe('loudnessTrim', () => {
  it('returns the delta toward target (quiet track → positive boost)', () => {
    expect(loudnessTrim(-18, -14)).toBe(4)   // -18 → -14 needs +4
  })
  it('returns negative for a track louder than target', () => {
    expect(loudnessTrim(-10, -14)).toBe(-4)
  })
  it('on-target → ~0', () => {
    expect(loudnessTrim(-14, -14)).toBe(0)
  })
  it('clamps to ±maxDb', () => {
    expect(loudnessTrim(-40, -14, 12)).toBe(12)
    expect(loudnessTrim(0, -14, 12)).toBe(-12)
  })
  it('silent (-Infinity) or invalid → 0 (cannot align silence)', () => {
    expect(loudnessTrim(-Infinity, -14)).toBe(0)
    expect(loudnessTrim(NaN, -14)).toBe(0)
    expect(loudnessTrim(-14, NaN)).toBe(0)
  })
  it('rounds to 0.1 dB', () => {
    expect(loudnessTrim(-14.37, -14)).toBeCloseTo(0.4, 6)
  })
})
