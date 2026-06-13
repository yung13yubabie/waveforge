import { describe, it, expect } from 'vitest'
import { scopePoint, scopePoints } from '../../src/js/audio/goniometer.js'

// Goniometer maps stereo L/R to a 45°-rotated Lissajous:
//   mono (L=R)        → vertical line   (x ≈ 0)
//   anti-phase (L=-R) → horizontal line (y ≈ 0)
//   left only         → upper-LEFT  (x < 0, y > 0)
//   right only        → upper-RIGHT (x > 0, y > 0)

describe('scopePoint', () => {
  it('maps in-phase mono to the vertical axis (x ≈ 0)', () => {
    const p = scopePoint(0.7, 0.7)
    expect(Math.abs(p.x)).toBeLessThan(1e-9)
    expect(p.y).toBeGreaterThan(0)
  })

  it('maps anti-phase to the horizontal axis (y ≈ 0)', () => {
    const p = scopePoint(0.8, -0.8)
    expect(Math.abs(p.y)).toBeLessThan(1e-9)
    expect(p.x).not.toBe(0)
  })

  it('puts left-only signal on the upper-left diagonal', () => {
    const p = scopePoint(1, 0)
    expect(p.x).toBeLessThan(0)   // left
    expect(p.y).toBeGreaterThan(0) // up
  })

  it('puts right-only signal on the upper-right diagonal', () => {
    const p = scopePoint(0, 1)
    expect(p.x).toBeGreaterThan(0) // right
    expect(p.y).toBeGreaterThan(0) // up
  })

  it('places a full-scale single channel at radius ≈ 1 on its diagonal', () => {
    const p = scopePoint(1, 0)
    const dist = Math.hypot(p.x, p.y)
    expect(dist).toBeCloseTo(1, 6)
  })

  it('maps silence to the origin', () => {
    const p = scopePoint(0, 0)
    expect(p.x).toBe(0)
    expect(p.y).toBe(0)
  })
})

describe('scopePoints', () => {
  it('decimates a frame to at most maxPoints', () => {
    const n = 4096
    const l = new Float32Array(n), r = new Float32Array(n)
    for (let i = 0; i < n; i++) { l[i] = Math.sin(i); r[i] = Math.cos(i) }
    const pts = scopePoints(l, r, 512)
    expect(pts.length).toBeLessThanOrEqual(512)
    expect(pts.length).toBeGreaterThan(0)
  })

  it('returns one point per sample when frame is shorter than maxPoints', () => {
    const l = Float32Array.from([0.1, 0.2, 0.3])
    const r = Float32Array.from([0.1, 0.2, 0.3])
    const pts = scopePoints(l, r, 1024)
    expect(pts.length).toBe(3)
    pts.forEach(p => expect(Math.abs(p.x)).toBeLessThan(1e-9)) // mono → vertical
  })

  it('uses the shorter of the two channel lengths', () => {
    const l = new Float32Array(100)
    const r = new Float32Array(50)
    const pts = scopePoints(l, r, 1024)
    expect(pts.length).toBe(50)
  })
})
