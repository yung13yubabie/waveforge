// Real-time goniometer / vectorscope. Plots the OUTPUT stereo field as a
// 45°-rotated Lissajous with a phosphor-trail persistence so transients leave
// a fading streak (classic broadcast scope feel). Reads engine.getStereoScope().
import { scopePoints } from '../audio/goniometer.js'

const SQRT2 = Math.SQRT2

export class Goniometer {
  constructor(canvas, engine) {
    this.canvas = canvas
    this.engine = engine
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
    // Square scope: use the smaller side so the field is never distorted.
    const side = Math.max(1, Math.min(rect.width, rect.height))
    this.canvas.width = side * this.dpr
    this.canvas.height = side * this.dpr
    this.w = side
    this.h = side
  }

  _graticule(ctx, cx, cy, rad) {
    ctx.save()
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'
    ctx.lineWidth = 1
    // bounding circle
    ctx.beginPath()
    ctx.arc(cx, cy, rad, 0, Math.PI * 2)
    ctx.stroke()
    // vertical (mono / mid) + horizontal (side) axes
    ctx.beginPath()
    ctx.moveTo(cx, cy - rad); ctx.lineTo(cx, cy + rad)
    ctx.moveTo(cx - rad, cy); ctx.lineTo(cx + rad, cy)
    ctx.stroke()
    // L / R 45° diagonals
    const d = rad * Math.SQRT1_2
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    ctx.beginPath()
    ctx.moveTo(cx - d, cy - d); ctx.lineTo(cx + d, cy + d)
    ctx.moveTo(cx + d, cy - d); ctx.lineTo(cx - d, cy + d)
    ctx.stroke()
    // labels
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.font = '10px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('M', cx, cy - rad + 11)        // mono (in-phase) at top
    ctx.fillText('L', cx - d + 8, cy - d + 4)
    ctx.fillText('R', cx + d - 8, cy - d + 4)
    ctx.fillText('S', cx + rad - 6, cy - 4)     // side axis
    ctx.restore()
  }

  _draw() {
    // layout may not have settled when constructed (panel hidden/0-width) — retry
    if (!this.w || !this.h) { this._resize(); if (!this.w || !this.h) return }
    const ctx = this.canvas.getContext('2d')
    const dpr = this.dpr, w = this.w, h = this.h
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    // phosphor trail: fade previous frame instead of clearing it outright
    ctx.fillStyle = 'rgba(15,15,24,0.30)'
    ctx.fillRect(0, 0, w, h)

    const cx = w / 2, cy = h / 2
    const rad = (Math.min(w, h) / 2) * 0.92
    this._graticule(ctx, cx, cy, rad)

    const scope = this.engine?.getStereoScope?.()
    if (!scope) return
    const pts = scopePoints(scope.left, scope.right, 1024)
    if (pts.length === 0) return

    // map audio radius 1 → graticule radius (single-channel full scale = edge);
    // mono can reach √2 so we clip to the circle.
    const k = rad
    ctx.fillStyle = 'rgba(57,255,176,0.85)' // phosphor green
    for (const p of pts) {
      let x = p.x, y = p.y
      const m = Math.hypot(x, y)
      if (m > SQRT2) { x = (x / m) * SQRT2; y = (y / m) * SQRT2 }
      const px = cx + x * k
      const py = cy - y * k // screen y is inverted; +mid → up
      ctx.fillRect(px - 0.6, py - 0.6, 1.2, 1.2)
    }
  }

  startLoop() {
    this.stopLoop() // prevent orphaned RAF loops on repeated calls (file reload)
    const tick = () => { this._draw(); this._raf = requestAnimationFrame(tick) }
    this._raf = requestAnimationFrame(tick)
  }

  stopLoop() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null }
  }
}
