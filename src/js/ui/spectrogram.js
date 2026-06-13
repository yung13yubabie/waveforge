// Scrolling spectrogram (time-frequency waterfall). Each RAF: shift the full
// ImageData left by one pixel using TypedArray.copyWithin (no drawImage
// self-copy — that is unreliable in Firefox), then paint a new rightmost
// column from the analyser on a log-frequency vertical axis (high freq at top).
//
// Lives inside a collapsible module, so a ResizeObserver re-initialises the
// buffer once the panel actually has layout (display:none → 0-size canvas).
import { magnitudeToColor, buildRowToBin } from '../audio/spectrogram.js'

export class Spectrogram {
  // `engine` is the AudioEngine instance (not engine.analyser) because the
  // analyser is null at construction time (engine.init() runs on first loadFile).
  // We resolve the live analyser via engine.analyser each frame.
  constructor(canvas, engine, opt = {}) {
    this.canvas = canvas
    this.engine = engine
    this.floor = opt.floor ?? -90
    this.ceil = opt.ceil ?? -12
    this.dpr = window.devicePixelRatio || 1
    this._raf = null
    this.cw = 0
    this.ch = 0
    this._resize()
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._resize())
      this._ro.observe(this.canvas)
    } else {
      window.addEventListener('resize', () => this._resize())
    }
  }

  get _analyser() { return this.engine?.analyser ?? null }

  _resize() {
    const rect = this.canvas.getBoundingClientRect()
    const cw = Math.round(rect.width * this.dpr)
    const ch = Math.round(rect.height * this.dpr)
    if (cw < 1 || ch < 1) { this.cw = 0; this.ch = 0; return }
    if (cw === this.cw && ch === this.ch && this._ctx) return
    this.cw = cw
    this.ch = ch
    this.canvas.width = cw
    this.canvas.height = ch
    this._ctx = this.canvas.getContext('2d', { willReadFrequently: true })
    this._img = null  // force rebuild on next draw
  }

  _rebuild() {
    const an = this._analyser
    if (!an || this.cw < 1 || this.ch < 1 || !this._ctx) return
    const N = an.frequencyBinCount
    const sr = an.context?.sampleRate ?? 48000
    const binHz = sr / (N * 2)
    this.rowToBin = buildRowToBin(N, binHz, this.ch, 20, Math.min(20000, sr / 2))
    this._freq = new Float32Array(N)
    // Full-frame ImageData buffer — shift left via copyWithin, avoiding
    // drawImage(canvas, canvas) which Firefox doesn't accumulate reliably.
    this._img = this._ctx.createImageData(this.cw, this.ch)
    this._img.data.fill(4)   // near-black background
  }

  _draw() {
    if (!this.cw || !this.ch || !this._ctx) return
    // Lazy init: engine.analyser is null until the first loadFile completes.
    if (!this._img) this._rebuild()
    if (!this._img) return
    this._analyser.getFloatFrequencyData(this._freq)

    const buf = this._img.data   // Uint8ClampedArray, row-major RGBA
    const cw = this.cw, ch = this.ch
    const rowBytes = cw * 4
    const opt = { floor: this.floor, ceil: this.ceil }

    // Shift every row left by one pixel using copyWithin (fast typed-array op)
    for (let y = 0; y < ch; y++) {
      const base = y * rowBytes
      buf.copyWithin(base, base + 4, base + rowBytes)
    }

    // Paint the rightmost column with the current spectrum
    const xOff = (cw - 1) * 4
    for (let y = 0; y < ch; y++) {
      const c = magnitudeToColor(this._freq[this.rowToBin[y]], opt)
      const o = y * rowBytes + xOff
      buf[o] = c.r; buf[o + 1] = c.g; buf[o + 2] = c.b; buf[o + 3] = 255
    }

    this._ctx.putImageData(this._img, 0, 0)
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
