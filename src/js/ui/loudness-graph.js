// Scrolling short-term LUFS history graph (chart-recorder style). Reads a
// LoudnessHistory ring buffer each RAF and plots it left→right (oldest→newest),
// with a dashed target line (e.g. −14 LUFS) and reference grid lines.
import { lufsToY } from '../audio/loudness-history.js'

export class LoudnessGraph {
  constructor(canvas, history, opts = {}) {
    this.canvas = canvas
    this.history = history
    this.getTarget = opts.getTarget || (() => null)
    this.min = opts.min ?? -40
    this.max = opts.max ?? 0
    this.dpr = window.devicePixelRatio || 1
    this._raf = null
    this._resizeTimer = null
    this._resize()
    window.addEventListener('resize', () => {
      clearTimeout(this._resizeTimer)
      this._resizeTimer = setTimeout(() => this._resize(), 80)
    })
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect()
    this.canvas.width = Math.max(1, rect.width) * this.dpr
    this.canvas.height = Math.max(1, rect.height) * this.dpr
    this.w = rect.width
    this.h = rect.height
  }

  _y(lufs) { return lufsToY(lufs, { min: this.min, max: this.max, height: this.h }) }

  _gridLine(ctx, lufs, color, dash) {
    const y = this._y(lufs)
    if (y == null) return
    ctx.strokeStyle = color
    ctx.setLineDash(dash || [])
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.w, y); ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = color
    ctx.font = '9px var(--font-mono, monospace)'
    ctx.textAlign = 'left'
    ctx.fillText(String(lufs), 3, Math.max(9, y - 2))
  }

  _draw() {
    if (!this.w || !this.h) { this._resize(); if (!this.w || !this.h) return }
    const ctx = this.canvas.getContext('2d')
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, this.w, this.h)
    ctx.fillStyle = '#0F0F18'
    ctx.fillRect(0, 0, this.w, this.h)

    // reference grid
    this._gridLine(ctx, -14, 'rgba(255,255,255,0.12)') // streaming target band
    this._gridLine(ctx, -23, 'rgba(255,255,255,0.08)') // EBU R128 broadcast
    const target = this.getTarget()
    if (Number.isFinite(target)) {
      this._gridLine(ctx, target, 'rgba(57,255,176,0.55)', [4, 3])
    }

    const data = this.history.toArray()
    const n = data.length
    if (n < 2) return
    const dx = this.w / Math.max(1, this.history.capacity - 1)
    // newest sample sits at the right edge; oldest fills leftward
    const x0 = this.w - (n - 1) * dx

    ctx.strokeStyle = '#FF4B6E'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    let pen = false
    for (let i = 0; i < n; i++) {
      const y = this._y(data[i])
      const x = x0 + i * dx
      if (y == null) { pen = false; continue } // silence gap → break the line
      if (!pen) { ctx.moveTo(x, y); pen = true } else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }

  startLoop() {
    this.stopLoop()
    const tick = () => { this._draw(); this._raf = requestAnimationFrame(tick) }
    this._raf = requestAnimationFrame(tick)
  }

  stopLoop() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null }
  }
}
