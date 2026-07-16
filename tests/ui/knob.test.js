// Knob keyboard accessibility + ARIA (runs in jsdom).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Knob, initKnobs } from '../../src/js/ui/knob.js'

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

describe('Knob value formatting', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  /** Read the label a knob paints for a given unit and value. */
  function labelFor(unit, value, { min = -100, max = 100000 } = {}) {
    const el = makeKnobEl({ min, max, def: value, unit })
    new Knob(el, () => {})
    return el.querySelector('.knob-value').textContent
  }

  it('abbreviates Hz above 1k and drops the decimal above 10k', () => {
    expect(labelFor('Hz', 440)).toBe('440')
    expect(labelFor('Hz', 2500)).toBe('2.5k')
    expect(labelFor('Hz', 12000)).toBe('12k')
  })

  it('signs dB values so a boost is unambiguous', () => {
    expect(labelFor('dB', 3)).toBe('+3.0')
    expect(labelFor('dB', -3)).toBe('-3.0')
    expect(labelFor('dB', 0)).toBe('+0.0')
  })

  it('formats dBTP like dB and dBFS without a plus sign', () => {
    expect(labelFor('dBTP', -1)).toBe('-1.0')
    expect(labelFor('dBFS', -14)).toBe('-14.0')
  })

  it('switches seconds to milliseconds below 100ms', () => {
    expect(labelFor('s', 0.05)).toBe('50ms')
    expect(labelFor('s', 0.25)).toBe('0.25s')
  })

  it('formats ratio and percent units', () => {
    expect(labelFor(':1', 4)).toBe('4.0:1')
    expect(labelFor('%', 62.4)).toBe('62%')
  })

  it('trims trailing zeros for an unlabelled value', () => {
    expect(labelFor('', 2.5)).toBe('2.5')
    expect(labelFor('', 3)).toBe('3')
  })
})

describe('Knob pointer interaction', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  const mouse = (type, init) => window.dispatchEvent(new window.MouseEvent(type, init))

  it('drags upward to increase and downward to decrease', () => {
    const el = makeKnobEl({ min: 0, max: 100, def: 50 })
    const k = new Knob(el, () => {})

    el.dispatchEvent(new window.MouseEvent('mousedown', { clientY: 200, bubbles: true }))
    mouse('mousemove', { clientY: 180 }) // 20px up @ range/100 per px
    expect(k.value).toBeCloseTo(70, 5)

    mouse('mousemove', { clientY: 220 }) // 20px below the start
    expect(k.value).toBeCloseTo(30, 5)
  })

  it('applies a finer sensitivity while shift is held', () => {
    const el = makeKnobEl({ min: 0, max: 100, def: 50 })
    const k = new Knob(el, () => {})

    el.dispatchEvent(new window.MouseEvent('mousedown', { clientY: 200, bubbles: true }))
    mouse('mousemove', { clientY: 170, shiftKey: true }) // 30px @ range/300

    expect(k.value).toBeCloseTo(60, 5)
  })

  it('ignores movement when no drag is in progress', () => {
    const el = makeKnobEl({ min: 0, max: 100, def: 50 })
    const k = new Knob(el, () => {})

    mouse('mousemove', { clientY: 10 })

    expect(k.value).toBe(50)
  })

  it('stops tracking after mouseup', () => {
    const el = makeKnobEl({ min: 0, max: 100, def: 50 })
    const k = new Knob(el, () => {})

    el.dispatchEvent(new window.MouseEvent('mousedown', { clientY: 200, bubbles: true }))
    mouse('mouseup', {})
    mouse('mousemove', { clientY: 100 })

    expect(k.value).toBe(50)
    expect(document.body.style.userSelect).toBe('')
  })

  it('clamps a drag past the maximum', () => {
    const el = makeKnobEl({ min: 0, max: 100, def: 50 })
    const k = new Knob(el, () => {})

    el.dispatchEvent(new window.MouseEvent('mousedown', { clientY: 200, bubbles: true }))
    mouse('mousemove', { clientY: -500 })

    expect(k.value).toBe(100)
  })

  it('reports each drag step through onChange', () => {
    const el = makeKnobEl({ min: 0, max: 100, def: 50, param: 'thresh' })
    const onChange = vi.fn()
    new Knob(el, onChange)

    el.dispatchEvent(new window.MouseEvent('mousedown', { clientY: 200, bubbles: true }))
    mouse('mousemove', { clientY: 190 })

    expect(onChange).toHaveBeenCalledWith('thresh', 60)
  })

  it('does not fire onChange when a drag lands on the same value', () => {
    const el = makeKnobEl({ min: 0, max: 100, def: 50 })
    const onChange = vi.fn()
    new Knob(el, onChange)

    el.dispatchEvent(new window.MouseEvent('mousedown', { clientY: 200, bubbles: true }))
    mouse('mousemove', { clientY: 200 })

    expect(onChange).not.toHaveBeenCalled()
  })

  it('drags from a touch point', () => {
    const el = makeKnobEl({ min: 0, max: 100, def: 50 })
    const k = new Knob(el, () => {})

    const touch = (type, target, clientY) => {
      const e = new window.Event(type, { bubbles: true, cancelable: true })
      e.touches = [{ clientY }]
      target.dispatchEvent(e)
    }
    touch('touchstart', el, 200)
    touch('touchmove', window, 180)

    expect(k.value).toBeCloseTo(70, 5)
  })

  it('resets to default on double-click', () => {
    const el = makeKnobEl({ min: 0, max: 100, def: 50 })
    const k = new Knob(el, () => {})
    k.setValue(90)

    el.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }))

    expect(k.value).toBe(50)
  })

  it('nudges by a fine step on wheel, up for scroll-up', () => {
    const el = makeKnobEl({ min: 0, max: 100, def: 50 })
    const k = new Knob(el, () => {})

    el.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true }))
    expect(k.value).toBeCloseTo(50.5, 5)

    el.dispatchEvent(new window.WheelEvent('wheel', { deltaY: 1, bubbles: true, cancelable: true }))
    expect(k.value).toBeCloseTo(50, 5)
  })
})

describe('Knob.setValue', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('clamps into range', () => {
    const el = makeKnobEl({ min: 0, max: 10, def: 5 })
    const k = new Knob(el, () => {})

    k.setValue(999)
    expect(k.value).toBe(10)

    k.setValue(-999)
    expect(k.value).toBe(0)
  })

  it('stays silent when told to, so preset loads do not echo back', () => {
    const el = makeKnobEl({ min: 0, max: 10, def: 5 })
    const onChange = vi.fn()
    const k = new Knob(el, onChange)

    k.setValue(7, true)

    expect(k.value).toBe(7)
    expect(onChange).not.toHaveBeenCalled()
    expect(el.querySelector('.knob-value').textContent).toBe('+7.0')
  })

  it('renders no progress arc at the minimum', () => {
    const el = makeKnobEl({ min: 0, max: 10, def: 5 })
    const k = new Knob(el, () => {})

    k.setValue(0)

    expect(el.querySelector('svg').innerHTML).not.toContain('<path')
  })

  it('renders a progress arc above the minimum', () => {
    const el = makeKnobEl({ min: 0, max: 10, def: 5 })
    new Knob(el, () => {})

    expect(el.querySelector('svg').innerHTML).toContain('<path')
  })

  it('draws a large-arc sweep past the halfway point', () => {
    const el = makeKnobEl({ min: 0, max: 10, def: 5 })
    const k = new Knob(el, () => {})

    k.setValue(9)

    // 270° sweep × 0.9 = 243° — past 180°, so the large-arc flag must be set.
    expect(el.querySelector('svg').innerHTML).toMatch(/A [\d.]+ [\d.]+ 0 1 0/)
  })
})

describe('initKnobs', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('builds one Knob per data-param element, keyed by param', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    for (const param of ['thresh', 'ratio']) {
      const el = makeKnobEl({ param })
      container.appendChild(el)
    }

    const knobs = initKnobs(container, () => {})

    expect(Object.keys(knobs).sort()).toEqual(['ratio', 'thresh'])
    expect(knobs.thresh.param).toBe('thresh')
  })

  it('skips elements without a data-param', () => {
    const container = document.createElement('div')
    container.innerHTML = '<div class="knob-wrap"><svg width="40"></svg><div class="knob-value"></div></div>'
    document.body.appendChild(container)

    expect(Object.keys(initKnobs(container, () => {}))).toEqual([])
  })

  it('wires onChange through to every knob it builds', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    container.appendChild(makeKnobEl({ param: 'thresh', min: 0, max: 100, def: 50 }))
    const onChange = vi.fn()

    const knobs = initKnobs(container, onChange)
    knobs.thresh.setValue(60)

    expect(onChange).toHaveBeenCalledWith('thresh', 60)
  })
})

describe('Knob defaults', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('falls back to a 0..1 range with no unit when dataset is bare', () => {
    const el = document.createElement('div')
    el.innerHTML = '<svg width="40"></svg><div class="knob-value"></div>'
    document.body.appendChild(el)

    const k = new Knob(el, () => {})

    expect(k.min).toBe(0)
    expect(k.max).toBe(1)
    expect(k.value).toBe(0)
    expect(k.unit).toBe('')
    expect(k.param).toBe('')
  })

  it('omits aria-label when there is no label element to read', () => {
    const el = document.createElement('div')
    el.innerHTML = '<svg width="40"></svg><div class="knob-value"></div>'
    document.body.appendChild(el)

    new Knob(el, () => {})

    expect(el.hasAttribute('aria-label')).toBe(false)
  })
})
