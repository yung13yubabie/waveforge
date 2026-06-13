// Knob keyboard accessibility + ARIA (runs in jsdom).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Knob } from '../../src/js/ui/knob.js'

function makeKnobEl({ min = 0, max = 100, def = 50, unit = 'dB', param = 'test' } = {}) {
  const el = document.createElement('div')
  el.className = 'knob-wrap'
  el.dataset.min = String(min)
  el.dataset.max = String(max)
  el.dataset.default = String(def)
  el.dataset.unit = unit
  el.dataset.param = param
  el.innerHTML = '<svg width="40" height="40"></svg><div class="knob-label">Thresh</div><div class="knob-value"></div>'
  document.body.appendChild(el)
  return el
}

function press(el, key) {
  el.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

describe('Knob accessibility', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('exposes slider role, tabindex and aria range', () => {
    const el = makeKnobEl({ min: -60, max: 0, def: -24 })
    new Knob(el, () => {})
    expect(el.getAttribute('role')).toBe('slider')
    expect(el.getAttribute('tabindex')).toBe('0')
    expect(el.getAttribute('aria-valuemin')).toBe('-60')
    expect(el.getAttribute('aria-valuemax')).toBe('0')
    expect(el.getAttribute('aria-valuenow')).toBe('-24')
    expect(el.getAttribute('aria-label')).toBe('Thresh')
  })

  it('ArrowUp / ArrowRight increase by a fine step and fire onChange', () => {
    const el = makeKnobEl({ min: 0, max: 100, def: 50 })
    const onChange = vi.fn()
    const k = new Knob(el, onChange)
    press(el, 'ArrowUp')      // +1 (range/100)
    expect(k.value).toBeCloseTo(51, 6)
    press(el, 'ArrowRight')
    expect(k.value).toBeCloseTo(52, 6)
    expect(onChange).toHaveBeenCalledWith('test', 52)
  })

  it('ArrowDown / ArrowLeft decrease', () => {
    const el = makeKnobEl({ min: 0, max: 100, def: 50 })
    const k = new Knob(el, () => {})
    press(el, 'ArrowDown')
    press(el, 'ArrowLeft')
    expect(k.value).toBeCloseTo(48, 6)
  })

  it('PageUp / PageDown use a coarse step (range/20)', () => {
    const el = makeKnobEl({ min: 0, max: 100, def: 50 })
    const k = new Knob(el, () => {})
    press(el, 'PageUp')
    expect(k.value).toBeCloseTo(55, 6)
  })

  it('Home / End jump to min / max', () => {
    const el = makeKnobEl({ min: -60, max: 0, def: -24 })
    const k = new Knob(el, () => {})
    press(el, 'Home')
    expect(k.value).toBe(-60)
    press(el, 'End')
    expect(k.value).toBe(0)
  })

  it('clamps at the limits — ArrowUp past max stays at max', () => {
    const el = makeKnobEl({ min: 0, max: 100, def: 50 })
    const k = new Knob(el, () => {})
    press(el, 'End')
    press(el, 'ArrowUp')
    expect(k.value).toBe(100)
  })

  it('Backspace/Delete resets to default', () => {
    const el = makeKnobEl({ min: 0, max: 100, def: 50 })
    const k = new Knob(el, () => {})
    press(el, 'End')
    press(el, 'Backspace')
    expect(k.value).toBe(50)
  })

  it('updates aria-valuetext with the formatted value + unit', () => {
    const el = makeKnobEl({ min: -60, max: 0, def: -24, unit: 'dB' })
    new Knob(el, () => {})
    press(el, 'ArrowUp')
    expect(el.getAttribute('aria-valuetext')).toContain('dB')
  })

  it('ignores unrelated keys', () => {
    const el = makeKnobEl({ min: 0, max: 100, def: 50 })
    const k = new Knob(el, () => {})
    press(el, 'a')
    expect(k.value).toBe(50)
  })
})
