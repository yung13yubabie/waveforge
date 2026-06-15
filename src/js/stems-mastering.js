// Stems mastering module — per-stem EQ + compression + bounce

import { startDemucsAnimation, stopDemucsAnimation } from './antitheft.js'

const STEM_META = [
  { key: 'vocals', label: '人聲', color: '#FF4B6E', bg: 'var(--stem-vocals-bg)' },
  { key: 'drums',  label: '鼓組', color: '#4ECDC4', bg: 'var(--stem-drums-bg)' },
  { key: 'bass',   label: '貝斯', color: '#FFE66D', bg: 'var(--stem-bass-bg)' },
  { key: 'other',  label: '其他', color: '#FD9644', bg: 'var(--stem-other-bg)' },
]

const stemParams = {}   // { vocals: { lowGain, midGain, highGain, thresh, ratio }, ... }

STEM_META.forEach(m => {
  stemParams[m.key] = { lowGain: 0, midGain: 0, highGain: 0, thresh: -24, ratio: 4 }
})

// ── Demucs backend call ───────────────────────────────────────────
const HF_ENDPOINT = 'https://hf.space/embed/linpcw/demucs-waveforge/+/api/predict'

export async function separateStems(audioBlob) {
  const btnEl   = document.getElementById('stems-ai-btn')
  const wrapEl  = document.getElementById('demucs-progress-wrap')
  const etaEl   = document.getElementById('demucs-eta')
  const gridEl  = document.getElementById('stems-processing-grid')
  const bounceEl = document.getElementById('bounce-btn')

  if (!btnEl) return

  btnEl.classList.add('processing')
  btnEl.disabled = true
  btnEl.textContent = '分軌中...'
  wrapEl?.classList.add('visible')
  startDemucsAnimation()

  // Countdown timer (2-5 min estimate)
  let elapsed = 0
  const timer = setInterval(() => {
    elapsed += 1
    const remaining = Math.max(0, 240 - elapsed)
    const mins = Math.floor(remaining / 60)
    const secs = remaining % 60
    if (etaEl) etaEl.textContent = `估計剩餘 ${mins}:${String(secs).padStart(2, '0')}`
  }, 1000)

  try {
    // Phase 2: replace with actual HF Spaces API call
    // const form = new FormData()
    // form.append('audio', audioBlob)
    // const res = await fetch(HF_ENDPOINT, { method: 'POST', body: form })
    // const { stems } = await res.json()

    // Demo: simulate 5-second wait then render stem cards
    await new Promise(r => setTimeout(r, 5000))

    clearInterval(timer)
    stopDemucsAnimation()
    wrapEl?.classList.remove('visible')
    btnEl.classList.remove('processing')
    btnEl.textContent = '重新分軌'
    btnEl.disabled = false

    if (etaEl) etaEl.textContent = '分軌完成'

    renderStemCards(gridEl)
    if (bounceEl) bounceEl.disabled = false
    document.getElementById('bounce-status').textContent = '各軌調整完成後點擊 Bounce'
  } catch (err) {
    clearInterval(timer)
    stopDemucsAnimation()
    wrapEl?.classList.remove('visible')
    btnEl.classList.remove('processing')
    btnEl.textContent = 'AI 分軌（重試）'
    btnEl.disabled = false
    console.error('Demucs error:', err)
  }
}

// ── Render per-stem processing cards ─────────────────────────────
function renderStemCards(container) {
  if (!container) return
  container.innerHTML = ''

  STEM_META.forEach(meta => {
    const card = buildStemCard(meta)
    container.appendChild(card)
  })
}

function buildStemCard(meta) {
  const card = document.createElement('div')
  card.className = 'stem-proc-card'
  card.style.borderTop = `2px solid ${meta.color}`

  card.innerHTML = `
    <div class="stem-proc-head">
      <div class="stem-proc-dot" style="background:${meta.color}"></div>
      <div class="stem-proc-name">${meta.label}</div>
      <div class="stem-proc-type">Phase 2 — 接 Demucs 後分軌音訊</div>
    </div>
    <div class="stem-proc-waveform" style="background:${meta.bg}">
      <!-- WaveSurfer instance mounted here in Phase 2 -->
      <div style="height:100%;display:flex;align-items:center;justify-content:center;font-size:10px;color:${meta.color};opacity:0.5">波形（分軌後載入）</div>
    </div>
    <div class="stem-proc-body">
      <div style="font-size:9px;color:var(--c-text-3);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px">EQ — 三頻段</div>
      <div class="stem-mini-eq">
        ${['低', '中', '高'].map((band, i) => {
          const paramKey = ['lowGain', 'midGain', 'highGain'][i]
          return `
          <div class="stem-eq-band">
            <div class="stem-eq-label">${band}</div>
            <input type="range" class="stem-eq-slider" min="-12" max="12" step="0.5"
                   value="${stemParams[meta.key][paramKey]}"
                   data-stem="${meta.key}" data-param="${paramKey}"
                   aria-label="${meta.label} ${band}頻 EQ">
            <div class="stem-eq-value" id="eq-val-${meta.key}-${paramKey}">0 dB</div>
          </div>`
        }).join('')}
      </div>
      <div style="font-size:9px;color:var(--c-text-3);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px">壓縮</div>
      <div class="stem-comp-row">
        <div class="stem-comp-field">
          <div class="stem-comp-label">Thresh (dB)</div>
          <input type="number" class="stem-comp-input" min="-60" max="0" step="1"
                 value="${stemParams[meta.key].thresh}"
                 data-stem="${meta.key}" data-param="thresh"
                 aria-label="${meta.label} 壓縮門限">
        </div>
        <div class="stem-comp-field">
          <div class="stem-comp-label">Ratio</div>
          <input type="number" class="stem-comp-input" min="1" max="20" step="0.5"
                 value="${stemParams[meta.key].ratio}"
                 data-stem="${meta.key}" data-param="ratio"
                 aria-label="${meta.label} 壓縮比">
        </div>
      </div>
    </div>
    <div class="stem-proc-footer">
      <input type="range" class="stem-proc-vol" min="0" max="1" step="0.01" value="1"
             aria-label="${meta.label} 音量">
      <span style="font-size:10px;color:var(--c-text-3);font-family:var(--font-mono);min-width:32px">100%</span>
    </div>
  `

  // Wire EQ sliders
  card.querySelectorAll('.stem-eq-slider').forEach(slider => {
    const valEl = card.querySelector(`#eq-val-${slider.dataset.stem}-${slider.dataset.param}`)
    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value)
      stemParams[slider.dataset.stem][slider.dataset.param] = v
      if (valEl) valEl.textContent = `${v >= 0 ? '+' : ''}${v} dB`
    })
  })

  // Wire compressor inputs
  card.querySelectorAll('.stem-comp-input').forEach(input => {
    input.addEventListener('change', () => {
      stemParams[input.dataset.stem][input.dataset.param] = parseFloat(input.value)
    })
  })

  // Wire volume slider
  const volSlider = card.querySelector('.stem-proc-vol')
  const volLabel  = card.querySelector('[style*="100%"]')
  volSlider?.addEventListener('input', () => {
    const pct = Math.round(volSlider.value * 100)
    if (volLabel) volLabel.textContent = `${pct}%`
  })

  return card
}

// ── Bounce all stems to master chain ─────────────────────────────
export function bounce() {
  // Phase 2: render each stem through its EQ+compression (OfflineAudioContext),
  // mix down, then hand the result back to the main mastering engine.
  console.log('Bounce params:', stemParams)
  document.getElementById('bounce-status').textContent = '已 Bounce → 回到母帶處理 (Phase 2 實作中)'
}

// ── Public init ───────────────────────────────────────────────────
export function initStemsMastering(getAudioBlob) {
  const btn = document.getElementById('stems-ai-btn')
  btn?.addEventListener('click', () => {
    const blob = getAudioBlob()
    if (!blob) return
    separateStems(blob)
  })

  document.getElementById('bounce-btn')?.addEventListener('click', bounce)
}
