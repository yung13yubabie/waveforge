// ── Demucs progress canvas (shared with stems-mastering) ──
let demucsAnim    = null
let demucsRunning = false

export function startDemucsAnimation() {
  const canvas = document.getElementById('demucs-canvas')
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  const W = canvas.width, H = canvas.height
  const COLORS = ['#FF4B6E', '#4ECDC4', '#FFE66D', '#FD9644']
  const BARS   = 28
  const phase  = Array.from({ length: BARS }, (_, i) => (i / BARS) * Math.PI * 2)
  let t = 0
  demucsRunning = true

  function draw() {
    if (!demucsRunning) return
    ctx.clearRect(0, 0, W, H)
    const bw = (W - (BARS - 1) * 2) / BARS

    for (let i = 0; i < BARS; i++) {
      const colorIdx = Math.floor((i / BARS) * COLORS.length)
      const height   = (0.3 + 0.7 * Math.abs(Math.sin(phase[i] + t))) * H * 0.85
      const y        = (H - height) / 2
      ctx.fillStyle  = COLORS[colorIdx] + 'CC'
      ctx.beginPath()
      if (ctx.roundRect) {
        ctx.roundRect(i * (bw + 2), y, bw, height, 2)
      } else {
        ctx.rect(i * (bw + 2), y, bw, height)
      }
      ctx.fill()
    }

    t += 0.08
    demucsAnim = requestAnimationFrame(draw)
  }

  if (demucsAnim) cancelAnimationFrame(demucsAnim)
  draw()
}

export function stopDemucsAnimation() {
  demucsRunning = false
  if (demucsAnim) cancelAnimationFrame(demucsAnim)
  demucsAnim = null
}

