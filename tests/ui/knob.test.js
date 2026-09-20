import { describe, it, expect, vi } from 'vitest'
import { Knob, initKnobs } from '../../src/js/ui/knob.js'

function setup(unit = 'dB', min = -60, max = 0, def = -24) {
  const el = document.createElement('div')
  el.className = 'knob-wrap'
  Object.assign(el.dataset, { unit, min, max, default: def, param: 'threshold' })
  el.innerHTML = '<svg></svg><div class="knob-label">門限</div>'
  document.body.replaceChildren(el)
  const change = vi.fn()
  const control = new Knob(el, change)
  return { el, change, control, input: el.querySelector('input[type=number]'), slider: el.querySelector('input[type=range]') }
}
const commit = input => input.dispatchEvent(new Event('change'))

describe('parameter controls', () => {
  it('provides native labelled slider and numeric input without global drag listeners', () => {
    const { el, input, slider } = setup()
    expect(el.querySelector('svg')).toBeNull()
    expect(input.getAttribute('aria-label')).toBe('門限 數值')
    expect(slider.getAttribute('aria-label')).toBe('門限')
    expect(slider.value).toBe('-24')
  })
  it('commits exact numeric values to DSP and synchronizes slider', () => {
    const { input, slider, change } = setup()
    input.value = '-12.3'; commit(input)
    expect(change).toHaveBeenLastCalledWith('threshold', -12.3)
    expect(slider.value).toBe('-12.3')
  })
  it.each(['', '123', '-999'])('rejects invalid entry %s without changing DSP', value => {
    const { input, change, control } = setup()
    input.value = value; commit(input)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(change).not.toHaveBeenCalled()
    expect(control.value).toBe(-24)
  })
  it('preset restore updates inputs silently and rejects NaN', () => {
    const { control, input, change } = setup()
    control.setValue(-9, true); control.setValue(NaN)
    expect(input.value).toBe('-9')
    expect(change).not.toHaveBeenCalled()
  })
  it('reset restores default and clears invalid feedback', () => {
    const { el, control, input, change } = setup()
    control.setValue(-3)
    input.value = '8'; commit(input)
    el.querySelector('button').click()
    expect(input.value).toBe('-24')
    expect(input.getAttribute('aria-invalid')).toBe('false')
    expect(change).toHaveBeenLastCalledWith('threshold', -24)
  })
  it('supports milliseconds without rounding to whole seconds', () => {
    const { input, change } = setup('s', 0.001, 0.3, 0.003)
    input.value = '0.017'; commit(input)
    expect(change).toHaveBeenLastCalledWith('threshold', 0.017)
  })
  it('native range input updates number and DSP', () => {
    const { slider, input, change } = setup()
    slider.value = '-30'; slider.dispatchEvent(new Event('input'))
    expect(input.value).toBe('-30')
    expect(change).toHaveBeenLastCalledWith('threshold', -30)
  })
  it('retains keyed API used by preset and undo', () => {
    const { el } = setup()
    expect(Object.keys(initKnobs(document.body, () => {}))).toEqual(['threshold'])
    expect(el.querySelectorAll('input').length).toBe(2)
  })
})
