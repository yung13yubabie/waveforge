// Custom rotary knob — drag vertically to change value
// Double-click to reset. Shift+drag for fine control (10x slower).
const KNOB_START_ANGLE = 225  // degrees (start of arc from top)
const KNOB_SWEEP       = 270  // degrees total sweep

export class Knob {
  constructor(el, onChange) {
    this.el      = el
    this.onChange = onChange
    this.min     = parseFloat(el.dataset.min     ?? 0)
    this.max     = parseFloat(el.dataset.max     ?? 1)
    this.def     = parseFloat(el.dataset.default ?? 0)
    this.unit    = el.dataset.unit ?? ''
    this.param   = el.dataset.param ?? ''
    this.value   = this.def

    this._svg   = el.querySelector('svg')
    this._label = el.querySelector('.knob-value')
    this._dragging = false
    this._dragStartY = 0
    this._dragStartVal = 0

    // Accessibility: a knob is a slider. Make it focusable and announce state.
    el.setAttribute('role', 'slider')
    el.setAttribute('tabindex', '0')
    el.setAttribute('aria-valuemin', String(this.min))
    el.setAttribute('aria-valuemax', String(this.max))
    const labelText = el.querySelector('.knob-label')?.textContent?.trim()
    if (labelText) el.setAttribute('aria-label', labelText)
    el.setAttribute('title', '拖曳調整 · 雙擊重設 · 方向鍵微調')

    this._render()
    this._bind()
  }

  _normalise(v) {
    return (v - this.min) / (this.max - this.min)
  }

  _denormalise(n) {
    return this.min + n * (this.max - this.min)
  }

  _clamp(v) {
    return Math.min(this.max, Math.max(this.min, v))
  }

  _render() {
    const svg = this._svg
    const norm = this._normalise(this.value)
    const size = parseInt(svg.getAttribute('width')) || 40
    const cx = size / 2
    const cy = size / 2
    const r  = size * 0.38

    // Arc path from start to current angle
    const startRad = (KNOB_START_ANGLE - 90) * Math.PI / 180
    const sweepRad = KNOB_SWEEP * Math.PI / 180
    const endRad   = startRad - sweepRad * norm

    function polar(angle, radius) {
      return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]
    }

    const [sx, sy] = polar(startRad, r)
    const [ex, ey] = polar(endRad, r)

    // Determine large-arc-flag
    const delta = ((startRad - endRad) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)
    const largeArc = delta > Math.PI ? 1 : 0

    svg.innerHTML = `
      <circle cx="${cx}" cy="${cy}" r="${r}"
              fill="none" stroke="var(--c-bg-overlay)" stroke-width="3"/>
      ${norm > 0 ? `<path d="M ${sx} ${sy} A ${r} ${r} 0 ${largeArc} 0 ${ex} ${ey}"
              fill="none" stroke="var(--c-primary)" stroke-width="3"
              stroke-linecap="round"/>` : ''}
      <circle cx="${ex}" cy="${ey}" r="2.5"
              fill="${norm > 0 ? 'var(--c-primary)' : 'var(--c-text-3)'}"/>
      <line x1="${cx}" y1="${cy}" x2="${ex}" y2="${ey}"
            stroke="var(--c-text-3)" stroke-width="1.5" stroke-linecap="round"
            opacity="0.4"/>
    `

    this._label.textContent = this._format(this.value)

    // Keep screen readers in sync with the visual value
    this.el.setAttribute('aria-valuenow', String(parseFloat(this.value.toFixed(4))))
    this.el.setAttribute('aria-valuetext', `${this._format(this.value)}${this.unit ? ' ' + this.unit : ''}`)
  }

  _format(v) {
    const u = this.unit
    if (u === 'Hz') {
      if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`
      return `${Math.round(v)}`
    }
    if (u === 'dB' || u === 'dBTP') return `${v >= 0 ? '+' : ''}${v.toFixed(1)}`
    if (u === 'dBFS') return `${v.toFixed(1)}`
    if (u === 's') {
      if (v < 0.1) return `${Math.round(v * 1000)}ms`
      return `${v.toFixed(2)}s`
    }
    if (u === ':1') return `${v.toFixed(1)}:1`
    if (u === '%') return `${Math.round(v)}%`
    return `${parseFloat(v.toFixed(2))}`
  }

  setValue(v, silent = false) {
    this.value = this._clamp(v)
    this._render()
    if (!silent) this.onChange?.(this.param, this.value)
  }

  _bind() {
    const el = this.el

    // Mouse
    el.addEventListener('mousedown', e => this._startDrag(e))
    window.addEventListener('mousemove', e => this._drag(e))
    window.addEventListener('mouseup',   () => this._endDrag())

    // Touch
    el.addEventListener('touchstart', e => this._startDrag(e.touches[0]), { passive: true })
    window.addEventListener('touchmove', e => { if (this._dragging) { e.preventDefault(); this._drag(e.touches[0]) } }, { passive: false })
    window.addEventListener('touchend', () => this._endDrag())

    // Double-click to reset
    el.addEventListener('dblclick', () => this.setValue(this.def))

    // Scroll wheel fine control
    el.addEventListener('wheel', e => {
      e.preventDefault()
      const step = (this.max - this.min) / 200
      this.setValue(this.value + (e.deltaY < 0 ? step : -step))
    }, { passive: false })

    // Keyboard control (WCAG): arrows fine, PageUp/Down coarse, Home/End limits
    el.addEventListener('keydown', e => this._key(e))
  }

  _key(e) {
    const range = this.max - this.min
    const fine = range / 100
    const coarse = range / 20
    let next = null
    switch (e.key) {
      case 'ArrowUp': case 'ArrowRight':   next = this.value + fine;   break
      case 'ArrowDown': case 'ArrowLeft':  next = this.value - fine;   break
      case 'PageUp':                       next = this.value + coarse; break
      case 'PageDown':                     next = this.value - coarse; break
      case 'Home':                         next = this.min;            break
      case 'End':                          next = this.max;            break
      case 'Backspace': case 'Delete':     next = this.def;            break  // reset
      default: return
    }
    e.preventDefault()
    this.setValue(this._clamp(next))
  }

  _startDrag(e) {
    this._dragging = true
    this._dragStartY = e.clientY
    this._dragStartVal = this.value
    this.el.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
  }

  _drag(e) {
    if (!this._dragging) return
    const dy = this._dragStartY - e.clientY  // up = positive
    const range = this.max - this.min
    // Shift = fine control (100px = full range); normal = coarser (50px = full range)
    const sensitivity = e.shiftKey ? range / 300 : range / 100
    const newVal = this._clamp(this._dragStartVal + dy * sensitivity)
    if (newVal !== this.value) this.setValue(newVal)
  }

  _endDrag() {
    this._dragging = false
    this.el.style.cursor = ''
    document.body.style.userSelect = ''
  }
}

// Initialise all .knob-wrap elements in a container
export function initKnobs(container, onChange) {
  const knobs = {}
  container.querySelectorAll('.knob-wrap[data-param]').forEach(el => {
    const k = new Knob(el, onChange)
    knobs[k.param] = k
  })
  return knobs
}
