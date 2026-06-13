// EQ frequency response curve visualisation
// Uses engine.getEQResponse() which calls BiquadFilterNode.getFrequencyResponse()
// — this is the real mathematical response, not an approximation.

const FREQ_MIN  = 20
const FREQ_MAX  = 22050
const DB_MIN    = -18
const DB_MAX    = 18
const GRID_FREQS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
const GRID_DB    = [-12, -6, 0, 6, 12]

export class EQCanvas {
  constructor(canvas, engine) {
    this.canvas  = canvas
    this.engine  = engine
    this.dpr     = window.devicePixelRatio || 1
    this._raf    = null
    this._resizeTimer = null
    this._resize()
    // Debounced: resize storms would otherwise call getFrequencyResponse per event
    window.addEventListener('resize', () => {
      clearTimeout(this._resizeTimer)
      this._resizeTimer = setTimeout(() => this._resize(), 80)
    })
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect()
    this.canvas.width  = rect.width  * this.dpr
    this.canvas.height = rect.height * this.dpr
    this.w = rect.width
    this.h = rect.height
    this.draw()
  }

  // Map frequency (Hz) → x pixel
  _freqToX(f) {
    const logMin = Math.log10(FREQ_MIN)
    const logMax = Math.log10(FREQ_MAX)
    return ((Math.log10(f) - logMin) / (logMax - logMin)) * this.w
  }

  // Map dB → y pixel
  _dbToY(db) {
    return this.h * (1 - (db - DB_MIN) / (DB_MAX - DB_MIN))
  }

  draw() {
    const canvas = this.canvas
    const ctx    = canvas.getContext('2d')
    const dpr    = this.dpr
    const w      = this.w
    const h      = this.h

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    // ── Background ────────────────────────────────────────
    ctx.fillStyle = 'var(--c-bg-input)' // falls back in canvas; use hex below
    ctx.fillStyle = '#0F0F18'
    ctx.fillRect(0, 0, w, h)

    // ── Grid: frequency lines ─────────────────────────────
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'
    ctx.lineWidth   = 1
    GRID_FREQS.forEach(f => {
      const x = this._freqToX(f)
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke()
    })

    // ── Grid: dB lines ────────────────────────────────────
    GRID_DB.forEach(db => {
      const y = this._dbToY(db)
      ctx.strokeStyle = db === 0 ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.05)'
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke()
    })

    // ── Grid labels ───────────────────────────────────────
    ctx.fillStyle  = 'rgba(255,255,255,0.25)'
    ctx.font       = `${9 * dpr}px "JetBrains Mono", monospace`
    ctx.textAlign  = 'center'
    ctx.setTransform(1, 0, 0, 1, 0, 0)  // reset to draw labels at 1:1
    GRID_FREQS.forEach(f => {
      const x = this._freqToX(f) * dpr
      const label = f >= 1000 ? `${f/1000}k` : `${f}`
      ctx.fillText(label, x, h * dpr - 3)
    })
    ctx.textAlign = 'right'
    GRID_DB.forEach(db => {
      if (db === 0) return
      const y = this._dbToY(db) * dpr
      ctx.fillText(`${db > 0 ? '+' : ''}${db}`, w * dpr - 3, y + 4)
    })
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    // ── Frequency response curve ──────────────────────────
    if (!this.engine?.eqBands?.length) return

    const N = 512
    const freqs = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1)
      freqs[i] = FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, t)
    }

    const mags = this.engine.getEQResponse(freqs)
    if (!mags) return

    // Filled area under curve
    const grad = ctx.createLinearGradient(0, 0, 0, h)
    grad.addColorStop(0,   'rgba(232,0,60,0.18)')
    grad.addColorStop(0.5, 'rgba(232,0,60,0.06)')
    grad.addColorStop(1,   'rgba(232,0,60,0.01)')

    ctx.beginPath()
    const y0 = this._dbToY(0)
    ctx.moveTo(0, y0)
    for (let i = 0; i < N; i++) {
      const db = 20 * Math.log10(Math.max(mags[i], 1e-6))
      const x  = this._freqToX(freqs[i])
      const y  = this._dbToY(Math.max(DB_MIN, Math.min(DB_MAX, db)))
      ctx.lineTo(x, y)
    }
    ctx.lineTo(w, y0)
    ctx.closePath()
    ctx.fillStyle = grad
    ctx.fill()

    // Curve line
    ctx.beginPath()
    for (let i = 0; i < N; i++) {
      const db = 20 * Math.log10(Math.max(mags[i], 1e-6))
      const x  = this._freqToX(freqs[i])
      const y  = this._dbToY(Math.max(DB_MIN, Math.min(DB_MAX, db)))
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    }
    ctx.strokeStyle = '#E8003C'
    ctx.lineWidth   = 1.5
    ctx.lineJoin    = 'round'
    ctx.stroke()
  }

  startLoop() {
    this.stopLoop()  // prevent orphaned RAF loops on repeated calls (file reload)
    const tick = () => {
      this.draw()
      this._raf = requestAnimationFrame(tick)
    }
    this._raf = requestAnimationFrame(tick)
  }

  stopLoop() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null }
  }
}
