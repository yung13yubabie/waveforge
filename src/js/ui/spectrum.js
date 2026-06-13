// Real-time spectrum analyser using AnalyserNode.getFloatFrequencyData()
const FREQ_MIN = 20
const FREQ_MAX = 22050
const DB_FLOOR = -90

export class SpectrumAnalyser {
  constructor(canvas, analyser) {
    this.canvas   = canvas
    this.analyser = analyser
    this.dpr      = window.devicePixelRatio || 1
    this._raf     = null
    this._resizeTimer = null
    this._resize()
    // Debounced like EQCanvas — resize storms force layout per event otherwise
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
  }

  _freqToX(f) {
    const logMin = Math.log10(FREQ_MIN)
    const logMax = Math.log10(FREQ_MAX)
    return ((Math.log10(Math.max(f, FREQ_MIN)) - logMin) / (logMax - logMin)) * this.w
  }

  _draw() {
    if (!this.analyser) return
    const canvas = this.canvas
    const ctx    = canvas.getContext('2d')
    const dpr    = this.dpr
    const w      = this.w
    const h      = this.h

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#0F0F18'
    ctx.fillRect(0, 0, w, h)

    const N    = this.analyser.frequencyBinCount
    const data = new Float32Array(N)
    this.analyser.getFloatFrequencyData(data)

    // Read actual rate from the analyser's context — hardware may not honour 48k
    const sampleRate = this.analyser.context?.sampleRate ?? 48000
    const binWidth   = sampleRate / (N * 2)

    const grad = ctx.createLinearGradient(0, 0, 0, h)
    grad.addColorStop(0,   '#E8003C')
    grad.addColorStop(0.5, '#FF4B6E')
    grad.addColorStop(1,   'rgba(232,0,60,0.3)')

    ctx.beginPath()
    ctx.moveTo(0, h)

    for (let i = 1; i < N; i++) {
      const freq = i * binWidth
      if (freq < FREQ_MIN || freq > FREQ_MAX) continue
      const db = data[i]
      if (!isFinite(db)) continue
      const x = this._freqToX(freq)
      const y = h * (1 - (db - DB_FLOOR) / -DB_FLOOR)
      ctx.lineTo(x, Math.max(0, Math.min(h, y)))
    }

    ctx.lineTo(w, h)
    ctx.closePath()
    ctx.fillStyle = grad
    ctx.fill()

    ctx.strokeStyle = 'rgba(232,0,60,0.6)'
    ctx.lineWidth   = 1
    // Redraw top edge as line
    ctx.beginPath()
    let firstPoint = true
    for (let i = 1; i < N; i++) {
      const freq = i * binWidth
      if (freq < FREQ_MIN || freq > FREQ_MAX) continue
      const db = data[i]
      if (!isFinite(db)) continue
      const x = this._freqToX(freq)
      const y = h * (1 - (db - DB_FLOOR) / -DB_FLOOR)
      const yc = Math.max(0, Math.min(h, y))
      if (firstPoint) { ctx.moveTo(x, yc); firstPoint = false }
      else ctx.lineTo(x, yc)
    }
    ctx.stroke()
  }

  startLoop() {
    this.stopLoop()  // prevent orphaned RAF loops on repeated calls (file reload)
    const tick = () => { this._draw(); this._raf = requestAnimationFrame(tick) }
    this._raf = requestAnimationFrame(tick)
  }

  stopLoop() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null }
  }
}
