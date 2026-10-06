import { describe, expect, it } from 'vitest'
import { createTapTempo, estimateTapTempo, TAP_TEMPO_LIMITS } from '../../src/js/daw/tap-tempo.js'

const timestamps = (intervals, start = 1000) => intervals.reduce((times, interval) => [...times, times.at(-1) + interval], [start])

describe('bounded tap tempo timing', () => {
  it('requires five taps/four intervals and never invents a candidate from fewer', () => {
    const tapper = createTapTempo()
    for (const time of [0, 500, 1000, 1500]) expect(tapper.tap(time)).toMatchObject({ status: 'collecting', bpm: null })
    expect(tapper.tap(2000)).toEqual({ status: 'ready', bpm: 120, spreadMs: 0, tapCount: 5, intervalCount: 4 })
  })

  it.each([20, 60, 87.5, 120, 237.6, 300])('estimates %s BPM with fractional monotonic timestamps', bpm => {
    const result = estimateTapTempo(timestamps(Array(12).fill(60000 / bpm)))
    expect(result.status).toBe('ready'); expect(result.bpm).toBeCloseTo(bpm, 1)
  })

  it('tolerates small human jitter and exposes measured interval spread, not confidence', () => {
    const result = estimateTapTempo(timestamps([496, 508, 502, 494, 505, 499, 501, 497]))
    expect(result.status).toBe('ready'); expect(result.bpm).toBeCloseTo(120, 0)
    expect(result.spreadMs).toBe(14); expect(result).not.toHaveProperty('confidence')
  })

  it.each([
    [500, 500, 1000, 500, 500, 500, 500, 500],
    [500, 400, 600, 350, 700, 500],
    [460, 480, 500, 520, 540],
    [450, 450, 450, 550, 550, 550],
  ].map(intervals => [intervals]))('refuses inconsistent or drifting intervals %j even when their median looks useful', intervals => {
    expect(estimateTapTempo(timestamps(intervals))).toMatchObject({ status: 'irregular', bpm: null })
  })

  it.each([19, 301, 400])('refuses consistent timing outside supported BPM (%s)', bpm => {
    expect(estimateTapTempo(timestamps(Array(6).fill(60000 / bpm)))).toMatchObject({ status: 'out-of-range', bpm: null })
  })

  it('ignores accidental fast repeats without shifting the next interval', () => {
    const tapper = createTapTempo()
    for (const time of [0, 500, 1000, 1500]) {
      tapper.tap(time)
      expect(tapper.tap(time + 50).ignored).toBe('repeat')
    }
    expect(tapper.tap(2000)).toMatchObject({ status: 'ready', bpm: 120, tapCount: 5 })
  })

  it.each([1000, 1999])('starts fresh when the clock goes backwards (%s)', time => {
    const tapper = createTapTempo()
    for (const value of [0, 500, 1000, 1500, 2000]) tapper.tap(value)
    expect(tapper.tap(time)).toMatchObject({ status: 'collecting', tapCount: 1, bpm: null, resetReason: 'non-monotonic' })
    expect(tapper.tap(time + 500)).toMatchObject({ tapCount: 2 })
  })

  it('ignores duplicate timestamps instead of destroying the run on a precision-limited clock', () => {
    const tapper = createTapTempo()
    for (const value of [0, 500, 1000, 1500, 2000]) tapper.tap(value)
    expect(tapper.tap(2000)).toMatchObject({ status: 'ready', bpm: 120, tapCount: 5, ignored: 'repeat' })
  })

  it('resets after a long gap and accepts the slowest supported beat interval', () => {
    const tapper = createTapTempo()
    for (const value of [0, 3000, 6000, 9000, 12000]) tapper.tap(value)
    expect(tapper.getState()).toMatchObject({ status: 'ready', bpm: 20 })
    expect(tapper.tap(12000 + TAP_TEMPO_LIMITS.resetGapMs + 1)).toMatchObject({ status: 'collecting', tapCount: 1, resetReason: 'long-gap' })
  })

  it('keeps only 32 taps and recovers once an earlier irregular run leaves the bounded window', () => {
    const tapper = createTapTempo()
    tapper.tap(0); tapper.tap(900)
    for (let index = 1; index <= 200; index++) tapper.tap(900 + index * 500)
    expect(tapper.getState()).toEqual({ status: 'ready', bpm: 120, spreadMs: 0, tapCount: 32, intervalCount: 31 })
    const result = tapper.getState(); result.bpm = 0
    expect(tapper.getState().bpm).toBe(120)
    expect(tapper.reset()).toMatchObject({ status: 'collecting', tapCount: 0, bpm: null })
  })

  it.each([NaN, Infinity, -1, '500', undefined])('does not poison a session with invalid timestamp %s', time => {
    const tapper = createTapTempo({ now: () => time })
    tapper.tap(0); tapper.tap(500)
    expect(tapper.tap()).toMatchObject({ ignored: 'invalid-time', tapCount: 2 })
    expect(tapper.tap(1000)).toMatchObject({ tapCount: 3 })
  })

  it.each([null, {}, [0, 500, 500, 1000, 1500], [0, NaN, 1000, 1500, 2000]].map(times => [times]))('refuses malformed pure estimation input %j', times => {
    expect(estimateTapTempo(times)).toMatchObject({ status: 'invalid', bpm: null })
  })

  it('uses an injected clock and rejects a non-callable clock', () => {
    let time = 0; const tapper = createTapTempo({ now: () => time })
    for (let index = 0; index < 5; index++, time += 600) tapper.tap()
    expect(tapper.getState().bpm).toBe(100)
    expect(() => createTapTempo({ now: 10 })).toThrow(TypeError)
  })
})
