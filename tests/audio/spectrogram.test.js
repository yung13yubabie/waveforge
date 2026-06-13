import { describe, it, expect } from 'vitest'
import { magnitudeToColor, buildRowToBin } from '../../src/js/audio/spectrogram.js'

describe('magnitudeToColor', () => {
  const opt = { floor: -90, ceil: -10 }
  it('maps the floor (and below) to near-black', () => {
    const c = magnitudeToColor(-90, opt)
    expect(c.r + c.g + c.b).toBeLessThan(30)
    const below = magnitudeToColor(-200, opt)
    expect(below.r + below.g + below.b).toBeLessThan(30)
  })
  it('maps the ceiling (and above) to a hot/bright colour', () => {
    const c = magnitudeToColor(-10, opt)
    expect(c.r + c.g + c.b).toBeGreaterThan(300)
    const above = magnitudeToColor(0, opt)
    expect(above.r + above.g + above.b).toBeGreaterThan(300)
  })
  it('is brighter for louder magnitudes (monotonic luminance)', () => {
    const lum = db => { const c = magnitudeToColor(db, opt); return c.r + c.g + c.b }
    expect(lum(-30)).toBeGreaterThan(lum(-60))
    expect(lum(-60)).toBeGreaterThan(lum(-85))
  })
  it('returns integer channels in 0..255', () => {
    for (const db of [-90, -75, -50, -25, -10, 0]) {
      const c = magnitudeToColor(db, opt)
      for (const v of [c.r, c.g, c.b]) {
        expect(Number.isInteger(v)).toBe(true)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(255)
      }
    }
  })
  it('treats non-finite dB as silence (floor colour)', () => {
    const c = magnitudeToColor(-Infinity, opt)
    expect(c.r + c.g + c.b).toBeLessThan(30)
  })
})

describe('buildRowToBin', () => {
  const numBins = 1024, binHz = 48000 / 2048, height = 200
  const map = buildRowToBin(numBins, binHz, height, 20, 20000)

  it('has one bin index per canvas row', () => {
    expect(map.length).toBe(height)
  })
  it('puts high frequencies at the top (row 0) and low at the bottom', () => {
    expect(map[0]).toBeGreaterThan(map[height - 1]) // top bin > bottom bin
  })
  it('keeps every index within the valid bin range', () => {
    for (const b of map) {
      expect(b).toBeGreaterThanOrEqual(0)
      expect(b).toBeLessThan(numBins)
    }
  })
  it('is monotonically non-increasing from top to bottom (log axis)', () => {
    for (let i = 1; i < map.length; i++) expect(map[i]).toBeLessThanOrEqual(map[i - 1])
  })
})
