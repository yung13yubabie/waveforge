import { describe, it, expect } from 'vitest'
import { LoudnessHistory, lufsToY } from '../../src/js/audio/loudness-history.js'

describe('LoudnessHistory ring buffer', () => {
  it('keeps samples in push order', () => {
    const h = new LoudnessHistory(8)
    h.push(-20); h.push(-18); h.push(-16)
    expect(h.length).toBe(3)
    expect(h.toArray()).toEqual([-20, -18, -16])
  })

  it('drops the oldest sample once at capacity', () => {
    const h = new LoudnessHistory(3)
    h.push(-30); h.push(-25); h.push(-20); h.push(-15)
    expect(h.length).toBe(3)
    expect(h.toArray()).toEqual([-25, -20, -15]) // -30 evicted
  })

  it('stores NaN for non-finite values (silence gaps)', () => {
    const h = new LoudnessHistory(4)
    h.push(-14); h.push(-Infinity); h.push(-12)
    const arr = h.toArray()
    expect(arr[0]).toBe(-14)
    expect(Number.isNaN(arr[1])).toBe(true)
    expect(arr[2]).toBe(-12)
  })

  it('clears back to empty', () => {
    const h = new LoudnessHistory(4)
    h.push(-14); h.push(-12)
    h.clear()
    expect(h.length).toBe(0)
    expect(h.toArray()).toEqual([])
  })

  it('wraps correctly over many pushes (head tracking)', () => {
    const h = new LoudnessHistory(3)
    for (let i = 0; i < 100; i++) h.push(i)
    expect(h.toArray()).toEqual([97, 98, 99])
  })
})

describe('lufsToY', () => {
  const H = 100
  it('maps the max value to the top (y = 0)', () => {
    expect(lufsToY(0, { min: -40, max: 0, height: H })).toBeCloseTo(0, 6)
  })
  it('maps the min value to the bottom (y = height)', () => {
    expect(lufsToY(-40, { min: -40, max: 0, height: H })).toBeCloseTo(H, 6)
  })
  it('maps a mid value to the middle', () => {
    expect(lufsToY(-20, { min: -40, max: 0, height: H })).toBeCloseTo(H / 2, 6)
  })
  it('clamps values outside the range', () => {
    expect(lufsToY(10, { min: -40, max: 0, height: H })).toBeCloseTo(0, 6)
    expect(lufsToY(-99, { min: -40, max: 0, height: H })).toBeCloseTo(H, 6)
  })
  it('returns null for non-finite input (gap)', () => {
    expect(lufsToY(-Infinity, { min: -40, max: 0, height: H })).toBeNull()
    expect(lufsToY(NaN, { min: -40, max: 0, height: H })).toBeNull()
  })
})
