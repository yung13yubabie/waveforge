// Anti-theft detection module (ACRCloud + Supabase integration skeleton)

// ── Auth state (replaced by Supabase client in Phase 2) ──────────
let currentUser = null   // { email, id } | null
let acrApiKey = ''

// ── Auth overlay ──────────────────────────────────────────────────
export function checkAuthOverlay() {
  const overlay = document.getElementById('auth-required-overlay')
  if (!overlay) return
  overlay.classList.toggle('visible', !currentUser)

  const infoEl = document.getElementById('auth-user-info')
  const settingsBtn = document.getElementById('settings-auth-btn')
  if (currentUser) {
    if (infoEl)     infoEl.textContent = currentUser.email
    if (settingsBtn) settingsBtn.textContent = '登出'
  } else {
    if (infoEl)     infoEl.textContent = '未登入'
    if (settingsBtn) settingsBtn.textContent = '登入 / 註冊'
  }
}

// ── Works library state ───────────────────────────────────────────
const works = []   // [{ id, name, fingerprint, lastScan, results }]
let activeWorkId = null

// ── Radar canvas animation ────────────────────────────────────────
let radarAnim = null
let radarScanning = false

function startRadar() {
  const canvas = document.getElementById('acr-radar-canvas')
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  const W = canvas.width, H = canvas.height, CX = W / 2, CY = H / 2, R = W / 2 - 8
  let angle = 0

  function drawFrame() {
    ctx.clearRect(0, 0, W, H)

    // Background circle
    ctx.beginPath()
    ctx.arc(CX, CY, R, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(78,205,196,0.04)'
    ctx.fill()

    // Concentric rings
    for (let i = 1; i <= 4; i++) {
      ctx.beginPath()
      ctx.arc(CX, CY, R * (i / 4), 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(78,205,196,0.15)'
      ctx.lineWidth = 1
      ctx.stroke()
    }

    // Cross hairs
    ctx.strokeStyle = 'rgba(78,205,196,0.1)'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(CX - R, CY); ctx.lineTo(CX + R, CY); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(CX, CY - R); ctx.lineTo(CX, CY + R); ctx.stroke()

    if (radarScanning) {
      // Sweep gradient
      const grad = ctx.createConicalGradient
        ? ctx.createConicalGradient(CX, CY, angle)
        : null

      // Fallback: draw a triangle wedge
      ctx.save()
      ctx.translate(CX, CY)
      ctx.rotate(angle)

      const sweep = ctx.createRadialGradient(0, 0, 0, 0, 0, R)
      sweep.addColorStop(0, 'rgba(78,205,196,0.3)')
      sweep.addColorStop(1, 'rgba(78,205,196,0)')

      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.arc(0, 0, R, -0.5, 0)
      ctx.closePath()
      ctx.fillStyle = sweep
      ctx.fill()

      // Sweep line
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(R, 0)
      ctx.strokeStyle = '#4ECDC4'
      ctx.lineWidth = 2
      ctx.stroke()

      ctx.restore()

      angle += 0.04
    }

    // Center dot
    ctx.beginPath()
    ctx.arc(CX, CY, 4, 0, Math.PI * 2)
    ctx.fillStyle = radarScanning ? '#4ECDC4' : 'rgba(78,205,196,0.4)'
    ctx.fill()

    radarAnim = requestAnimationFrame(drawFrame)
  }

  if (radarAnim) cancelAnimationFrame(radarAnim)
  drawFrame()
}

function stopRadar() {
  radarScanning = false
}

// ── Demucs progress canvas ────────────────────────────────────────
let demucsAnim = null
let demucsRunning = false

export function startDemucsAnimation() {
  const canvas = document.getElementById('demucs-canvas')
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  const W = canvas.width, H = canvas.height
  const COLORS = ['#FF4B6E', '#4ECDC4', '#FFE66D', '#FD9644']
  const BARS = 28
  const phase = Array.from({ length: BARS }, (_, i) => (i / BARS) * Math.PI * 2)
  let t = 0
  demucsRunning = true

  function draw() {
    if (!demucsRunning) return
    ctx.clearRect(0, 0, W, H)
    const bw = (W - (BARS - 1) * 2) / BARS

    for (let i = 0; i < BARS; i++) {
      const colorIdx = Math.floor((i / BARS) * COLORS.length)
      const height = (0.3 + 0.7 * Math.abs(Math.sin(phase[i] + t))) * H * 0.85
      const y = (H - height) / 2
      ctx.fillStyle = COLORS[colorIdx] + 'CC'
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
}

// ── Scan a work with ACRCloud ─────────────────────────────────────
async function scanWork(work) {
  const statusEl = document.getElementById('scan-status-text')
  const countEl  = document.getElementById('scan-results-count')
  const listEl   = document.getElementById('scan-results-list')
  const scanBtn  = document.querySelector(`.work-scan-btn[data-id="${work.id}"]`)

  if (!acrApiKey) {
    setStatus('請先在右側設定填入 ACRCloud API Key', false)
    return
  }

  radarScanning = true
  if (statusEl) statusEl.textContent = '掃描中...'
  if (scanBtn)  scanBtn.classList.add('scanning')
  if (scanBtn)  scanBtn.textContent = '掃描中...'

  // Phase 2: replace with real ACRCloud API call via Supabase Edge Function
  // For now, show loading state for 3 seconds (demo)
  await new Promise(r => setTimeout(r, 3000))

  radarScanning = false
  if (statusEl)    statusEl.textContent = `完成 · ${new Date().toLocaleDateString('zh-TW')}`
  if (scanBtn)     scanBtn.classList.remove('scanning')
  if (scanBtn)     scanBtn.textContent = '重新掃描'

  // Demo results (replace with real API response in Phase 2)
  const demoResults = [
    { similarity: 94, title: '（待 ACRCloud 回傳）', artist: '—', platform: 'Spotify', url: '#' },
    { similarity: 81, title: '請先串接後端 API', artist: '—', platform: 'YouTube', url: '#' },
  ]

  work.results = demoResults
  work.lastScan = new Date().toISOString()
  renderResults(work)
  renderWorksList()

  document.getElementById('scan-matches-count').textContent = demoResults.length
  document.getElementById('scan-last-time').textContent = new Date().toLocaleDateString('zh-TW')
  if (countEl) countEl.textContent = `${demoResults.length} 筆`
}

// ── Render helpers ────────────────────────────────────────────────
function renderResults(work) {
  const listEl = document.getElementById('scan-results-list')
  if (!listEl) return

  if (!work?.results?.length) {
    listEl.innerHTML = `<div class="scan-empty"><div style="font-size:32px;opacity:0.2">◎</div><div>尚無比對結果</div></div>`
    return
  }

  listEl.innerHTML = work.results.map((r, i) => {
    const cls = r.similarity >= 90 ? 'high' : r.similarity >= 70 ? 'mid' : 'low'
    return `
    <div class="scan-result-item" style="animation-delay:${i * 60}ms">
      <div class="result-similarity ${cls}">${r.similarity}%</div>
      <div class="result-info">
        <div class="result-title">${r.title}</div>
        <div class="result-meta">
          <span>${r.artist}</span>
          <span class="result-platform">${r.platform}</span>
        </div>
      </div>
      <a class="result-link" href="${r.url}" target="_blank" rel="noopener" aria-label="前往平台">↗</a>
    </div>`
  }).join('')
}

function renderWorksList() {
  const listEl = document.getElementById('works-list')
  if (!listEl) return
  if (!works.length) {
    listEl.innerHTML = `<div class="works-empty"><div class="works-empty-icon">♪</div><div class="works-empty-text">點擊「+ 新增」上傳您的原創作品，WaveForge 會萃取音訊指紋存入資料庫。</div></div>`
    return
  }

  listEl.innerHTML = works.map(w => `
    <div class="work-card ${w.id === activeWorkId ? 'active' : ''}" data-id="${w.id}">
      <div class="work-card-title" title="${w.name}">${w.name}</div>
      <div class="work-card-meta">
        <div class="work-card-fp">
          <div class="fp-dot ${w.fingerprint ? 'ok' : ''}"></div>
          ${w.fingerprint ? '指紋已建立' : '建立指紋中...'}
        </div>
        ${w.lastScan ? `· ${new Date(w.lastScan).toLocaleDateString('zh-TW')}` : '· 未掃描'}
      </div>
      <div class="work-card-actions">
        <button class="work-scan-btn" data-id="${w.id}">
          ${w.results?.length ? '重新掃描' : '掃描'}
        </button>
        <button class="work-del-btn" data-del="${w.id}" aria-label="刪除">✕</button>
      </div>
    </div>
  `).join('')

  // Wire scan buttons
  listEl.querySelectorAll('.work-scan-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      const work = works.find(w => w.id === btn.dataset.id)
      if (work) scanWork(work)
    })
  })

  // Wire delete buttons
  listEl.querySelectorAll('.work-del-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      const idx = works.findIndex(w => w.id === btn.dataset.del)
      if (idx !== -1) works.splice(idx, 1)
      renderWorksList()
    })
  })

  // Wire card click → show results
  listEl.querySelectorAll('.work-card').forEach(card => {
    card.addEventListener('click', () => {
      activeWorkId = card.dataset.id
      const work = works.find(w => w.id === activeWorkId)
      if (work) {
        document.getElementById('scan-track-name').textContent = work.name
        document.getElementById('scan-status-text').textContent = work.lastScan ? `上次掃描 ${new Date(work.lastScan).toLocaleDateString('zh-TW')}` : '未掃描'
        document.getElementById('scan-matches-count').textContent = work.results?.length ?? '—'
        document.getElementById('scan-last-time').textContent = work.lastScan ? new Date(work.lastScan).toLocaleDateString('zh-TW') : '—'
        renderResults(work)
        document.getElementById('scan-results-count').textContent = `${work.results?.length ?? 0} 筆`
      }
      renderWorksList()
    })
  })
}

// ── Upload original work ──────────────────────────────────────────
function handleWorksUpload(file) {
  const id = `work-${Date.now()}`
  const work = { id, name: file.name.replace(/\.[^.]+$/, ''), fingerprint: false, lastScan: null, results: [] }
  works.push(work)
  renderWorksList()

  // Simulate fingerprint extraction (Phase 2: real ACRCloud identify)
  setTimeout(() => {
    work.fingerprint = true
    renderWorksList()
  }, 1500)
}

// ── Tutorial toggle ───────────────────────────────────────────────
function initTutorial() {
  const toggle = document.getElementById('tutorial-toggle')
  const body   = document.getElementById('tutorial-body')
  if (!toggle || !body) return

  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') === 'true'
    toggle.setAttribute('aria-expanded', String(!open))
    body.classList.toggle('open', !open)
  })
}

// ── API key save ──────────────────────────────────────────────────
function initApiKeySave() {
  const input   = document.getElementById('acr-api-key')
  const saveBtn = document.getElementById('acr-key-save')
  if (!input || !saveBtn) return

  saveBtn.addEventListener('click', () => {
    acrApiKey = input.value.trim()
    if (!acrApiKey) return
    localStorage.setItem('acr-api-key', acrApiKey)
    saveBtn.textContent = '已儲存 ✓'
    saveBtn.classList.add('saved')
    setTimeout(() => { saveBtn.textContent = '儲存'; saveBtn.classList.remove('saved') }, 2000)
  })

  // Restore from localStorage
  const stored = localStorage.getItem('acr-api-key')
  if (stored) { input.value = stored; acrApiKey = stored }
}

// ── Status helper (reused from main.js pattern) ───────────────────
function setStatus(msg, ok) {
  const el = document.getElementById('status-text')
  if (el) el.textContent = msg
}

// ── Public init ───────────────────────────────────────────────────
export function initAntiTheft() {
  document.addEventListener('wf:check-auth', () => checkAuthOverlay())
  startRadar()
  initTutorial()
  initApiKeySave()

  // Works file input
  document.getElementById('works-file-input')?.addEventListener('change', e => {
    const file = e.target.files?.[0]
    if (file) handleWorksUpload(file)
    e.target.value = ''
  })

  // Auth overlay buttons
  document.getElementById('auth-cta-btn')?.addEventListener('click', () => {
    document.getElementById('auth-modal')?.classList.add('open')
  })
  document.getElementById('settings-auth-btn')?.addEventListener('click', () => {
    if (currentUser) {
      currentUser = null
      checkAuthOverlay()
    } else {
      document.getElementById('auth-modal')?.classList.add('open')
    }
  })
}
