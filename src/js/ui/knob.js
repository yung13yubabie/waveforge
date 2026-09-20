// Historical public name retained for preset/history callers; controls are native inputs.
export class Knob {
  constructor(el, onChange) {
    this.el = el
    this.onChange = onChange
    this.min = Number(el.dataset.min ?? 0)
    this.max = Number(el.dataset.max ?? 1)
    this.def = Number(el.dataset.default ?? 0)
    this.unit = el.dataset.unit ?? ''
    this.param = el.dataset.param ?? ''
    this.value = this.def
    const label = el.querySelector('.knob-label')?.textContent?.trim() || this.param || '參數'
    const context = el.closest('.mbc-band')?.querySelector('.mbc-band-label')?.textContent?.trim()
      || el.closest('.module-card')?.querySelector('.module-name')?.textContent?.trim() || ''
    const name = `${context} ${label}`.trim()
    el.replaceChildren()
    el.classList.add('parameter-control')
    el.setAttribute('role', 'group')
    el.setAttribute('aria-label', name)
    const caption = document.createElement('span')
    caption.className = 'knob-label'
    caption.textContent = `${label}${this.unit ? ' (' + this.unit + ')' : ''}`
    this.slider = document.createElement('input')
    this.slider.type = 'range'
    this.slider.className = 'parameter-slider'
    this.input = document.createElement('input')
    this.input.type = 'number'
    this.input.className = 'parameter-number'
    const step = el.dataset.step ?? (this.unit === 's' ? '0.001' : this.unit === 'Hz' || this.unit === '%' ? '1' : '0.1')
    for (const input of [this.slider, this.input]) {
      input.min = String(this.min); input.max = String(this.max); input.step = step
      input.setAttribute('aria-label', `${name}${input === this.input ? ' 數值' : ''}`)
    }
    this.reset = document.createElement('button')
    this.reset.type = 'button'
    this.reset.className = 'parameter-reset'
    this.reset.textContent = '↺'
    this.reset.title = `重設為 ${this.def} ${this.unit}`
    this.reset.setAttribute('aria-label', `重設 ${name}`)
    const row = document.createElement('div')
    row.className = 'parameter-entry'
    row.append(this.input, this.reset)
    el.append(caption, this.slider, row)
    this.slider.addEventListener('input', () => this.setValue(this.slider.valueAsNumber))
    const commit = () => {
      const value = this.input.valueAsNumber
      if (!Number.isFinite(value) || value < this.min || value > this.max) {
        this.input.setAttribute('aria-invalid', 'true')
        this.input.setCustomValidity(`請輸入 ${this.min} 到 ${this.max} ${this.unit}`)
        this.input.reportValidity()
        return
      }
      this.setValue(value)
    }
    this.input.addEventListener('input', () => this.input.setCustomValidity(''))
    this.input.addEventListener('change', commit)
    this.input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commit() }
      if (e.key === 'Escape') { e.preventDefault(); this.setValue(this.value, true) }
    })
    this.reset.addEventListener('click', () => this.setValue(this.def))
    this.setValue(this.def, true)
  }
  setValue(value, silent = false) {
    if (!Number.isFinite(value)) return
    this.value = Math.min(this.max, Math.max(this.min, value))
    this.slider.value = String(this.value)
    this.slider.style.setProperty('--fill', `${100 * (this.value - this.min) / (this.max - this.min || 1)}%`)
    this.input.value = String(Number(this.value.toFixed(6)))
    this.input.setCustomValidity('')
    this.input.setAttribute('aria-invalid', 'false')
    if (!silent) this.onChange?.(this.param, this.value)
  }
}

export function initKnobs(container, onChange) {
  const knobs = {}
  container.querySelectorAll('.knob-wrap[data-param]').forEach(el => {
    const k = new Knob(el, onChange)
    knobs[k.param] = k
  })
  return knobs
}
