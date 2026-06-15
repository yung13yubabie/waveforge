/**
 * Stems Mastering — Demucs 分軌 + 每軌 EQ/壓縮 + Bounce 回主鏈
 *
 * 模式：
 *   HF_READY=false → 5 秒模擬分軌（UI 展示）
 *   HF_READY=true  → 呼叫 HF Spaces Gradio API（真實 Demucs htdemucs）
 *
 * Bounce 流程：
 *   每軌: buffer → lowShelf → midPeak → highShelf → DynamicsCompressor → gain
 *   Mix: 4 軌加總 → peak normalize
 *   載入: 發送 CustomEvent 'wf:stem-bounce'，main.js 接收後載入母帶鏈
 */

import WaveSurfer from 'wavesurfer.js'
import { startDemucsAnimation, stopDemucsAnimation } from './antitheft.js'
import { HF_ENDPOINT, HF_READY } from './config.js'

// ── Stem metadata ─────────────────────────────────────────
const STEM_META = [
  { key: 'vocals', label: '人聲', color: '#FF4B6E', bg: 'var(--stem-vocals-bg)' },
  { key: 'drums',  label: '鼓組', color: '#4ECDC4', bg: 'var(--stem-drums-bg)' },
  { key: 'bass',   label: '貝斯', color: '#FFE66D', bg: 'var(--stem-bass-bg)' },
  { key: 'other',  label: '其他', color: '#FD9644', bg: 'var(--stem-other-bg)' },
]

// ── Per-stem DSP params ───────────────────────────────────
const stemParams = {}
const stemVolumes = {}
STEM_META.forEach(m => {
  stemParams[m.key]  = { lowGain: 0, midGain: 0, highGain: 0, thresh: -24, ratio: 4 }
  stemVolumes[m.key] = 1.0
})

// ── Stem audio buffers (set after Demucs returns) ─────────
const stemBuffers = {}          // AudioBuffer per stem key
const stemWaveSurfers = {}      // WaveSurfer per stem key

// ── Helpers ───────────────────────────────────────────────

/** Convert File to data URL */
function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload  = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

/** Decode base64 audio data URL → AudioBuffer */
async function decodeBase64Audio(dataURL) {
  const b64 = dataURL.replace(/^data:[^;]+;base64,/, '')
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  const ctx = new AudioContext()
  try {
    return await ctx.decodeAudioData(bytes.buffer.slice(0))
  } finally {
    await ctx.close()
  }
}

/** Fetch a Gradio file URL and return as ArrayBuffer */
async function fetchGradioFile(baseUrl, filePath) {
  const res = await fetch(`${baseUrl}/file=${encodeURIComponent(filePath)}`)
  if (!res.ok) throw new Error(`HF file fetch failed: ${res.status}`)
  return res.arrayBuffer()
}

/** Call HF Spaces Gradio API — upload file then predict */
async function callHFDemucs(file) {
  const base = HF_ENDPOINT.replace(/\/$/, '')

  // Step 1: Upload file
  const uploadForm = new FormData()
  uploadForm.append('files', file, file.name)
  const uploadRes = await fetch(`${base}/upload`, {
    method: 'POST',
    body: uploadForm,
  })
  if (!uploadRes.ok) throw new Error(`HF upload failed: ${uploadRes.status}`)
  const uploaded = await uploadRes.json()
  const tmpPath = Array.isArray(uploaded) ? uploaded[0] : uploaded

  // Step 2: Predict (fn_index 0 = separate_stems)
  const predictRes = await fetch(`${base}/api/predict`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: [{ path: tmpPath }], fn_index: 0 }),
  })
  if (!predictRes.ok) throw new Error(`HF predict failed: ${predictRes.status}`)
  const { data } = await predictRes.json()

  // Step 3: Download each stem as AudioBuffer
  const stemKeys = ['vocals', 'drums', 'bass', 'other']
  const result = {}
  for (let i = 0; i < stemKeys.length; i++) {
    const item = data?.[i]
    if (!item) { result[stemKeys[i]] = null; continue }
    const filePath = item.path ?? item.name ?? item
    const arr = await fetchGradioFile(base, filePath)
    const ctx = new AudioContext()
    try {
      result[stemKeys[i]] = await ctx.decodeAudioData(arr)
    } finally {
      await ctx.close()
    }
  }
  return result
}

/** Process one stem buffer through EQ + dynamics compression */
async function processStem(buffer, params, volume) {
  if (!buffer) return null
  const { lowGain, midGain, highGain, thresh, ratio } = params
  const ctx = new OfflineAudioContext(
    buffer.numberOfChannels,
    buffer.length,
    buffer.sampleRate,
  )

  const src = ctx.createBufferSource()
  src.buffer = buffer

  // 3-band EQ
  const low = ctx.createBiquadFilter()
  low.type = 'lowshelf'; low.frequency.value = 200; low.gain.value = lowGain

  const mid = ctx.createBiquadFilter()
  mid.type = 'peaking'; mid.frequency.value = 1000; mid.Q.value = 0.7; mid.gain.value = midGain

  const high = ctx.createBiquadFilter()
  high.type = 'highshelf'; high.frequency.value = 8000; high.gain.value = highGain

  // Dynamics compressor
  const comp = ctx.createDynamicsCompressor()
  comp.threshold.value = thresh
  comp.ratio.value     = ratio
  comp.knee.value      = 6
  comp.attack.value    = 0.003
  comp.release.value   = 0.25

  // Per-stem volume
  const gain = ctx.createGain()
  gain.gain.value = volume

  src.connect(low)
  low.connect(mid)
  mid.connect(high)
  high.connect(comp)
  comp.connect(gain)
  gain.connect(ctx.destination)
  src.start()

  return ctx.startRendering()
}

/** Sum all processed stem buffers and peak-normalize */
function mixBuffers(buffers) {
  const valid = buffers.filter(Boolean)
  if (!valid.length) return null

  const ch  = valid[0].numberOfChannels
  const len = Math.max(...valid.map(b => b.length))
  const sr  = valid[0].sampleRate

  const mixed = Array.from({ length: ch }, () => new Float32Array(len))

  for (const buf of valid) {
    for (let c = 0; c < ch; c++) {
      const data = buf.getChannelData(c)
      const dest = mixed[c]
      for (let i = 0; i < data.length; i++) dest[i] += data[i]
    }
  }

  // Peak normalize (prevent clipping)
  let peak = 0
  for (const chan of mixed) for (const s of chan) if (Math.abs(s) > peak) peak = Math.abs(s)
  if (peak > 0.99) for (const chan of mixed) for (let i = 0; i < chan.length; i++) chan[i] /= peak

  // Build output AudioBuffer using OfflineAudioContext (broadest compat)
  const tmpCtx = new OfflineAudioContext(ch, len, sr)
  const out    = tmpCtx.createBuffer(ch, len, sr)
  for (let c = 0; c < ch; c++) out.copyToChannel(mixed[c], c)
  return out
}

/** Mount a WaveSurfer instance into a stem card's waveform container */
function loadStemWaveSurfer(stemKey, buffer) {
  const container = document.getElementById(`stem-waveform-${stemKey}`)
  if (!container) return

  // Destroy any existing instance
  stemWaveSurfers[stemKey]?.destroy()

  const meta = STEM_META.find(m => m.key === stemKey)

  // Convert AudioBuffer → Blob → URL for WaveSurfer
  const sr = buffer.sampleRate
  const ch = buffer.numberOfChannels
  const pcm = []
  for (let c = 0; c < ch; c++) pcm.push(buffer.getChannelData(c))

  // Encode a minimal WAV header for WaveSurfer
  const wavBlob = pcmToWavBlob(pcm, sr)
  const url = URL.createObjectURL(wavBlob)

  const ws = WaveSurfer.create({
    container,
    waveColor:     meta.color + '66',
    progressColor: meta.color,
    height:        56,
    barWidth:      2,
    barGap:        1,
    barRadius:     2,
    normalize:     true,
    interact:      false,
  })
  ws.load(url)
  stemWaveSurfers[stemKey] = ws
}

/** Minimal 16-bit PCM WAV encoder */
function pcmToWavBlob(channels, sampleRate) {
  const numCh = channels.length
  const numFrames = channels[0].length
  const byteRate = sampleRate * numCh * 2
  const dataBytes = numFrames * numCh * 2
  const buf = new ArrayBuffer(44 + dataBytes)
  const v   = new DataView(buf)
  const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)) }

  str(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE')
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true)
  v.setUint16(22, numCh, true); v.setUint32(24, sampleRate, true)
  v.setUint32(28, byteRate, true); v.setUint16(32, numCh * 2, true); v.setUint16(34, 16, true)
  str(36, 'data'); v.setUint32(40, dataBytes, true)

  let off = 44
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]))
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      off += 2
    }
  }
  return new Blob([buf], { type: 'audio/wav' })
}

// ── Main separation flow ──────────────────────────────────
export async function separateStems(fileOrBlob) {
  const btnEl    = document.getElementById('stems-ai-btn')
  const wrapEl   = document.getElementById('demucs-progress-wrap')
  const etaEl    = document.getElementById('demucs-eta')
  const gridEl   = document.getElementById('stems-processing-grid')
  const bounceEl = document.getElementById('bounce-btn')

  if (!btnEl) return

  btnEl.classList.add('processing')
  btnEl.disabled  = true
  btnEl.textContent = '分軌中...'
  wrapEl?.classList.add('visible')
  startDemucsAnimation()

  // Countdown timer
  let elapsed = 0
  const timer = setInterval(() => {
    elapsed++
    const remaining = Math.max(0, 240 - elapsed)
    const m = Math.floor(remaining / 60)
    const s = remaining % 60
    if (etaEl) etaEl.textContent = `估計剩餘 ${m}:${String(s).padStart(2, '0')}`
  }, 1000)

  try {
    if (HF_READY) {
      // ── Live mode: call HF Spaces ────────────────────────
      if (etaEl) etaEl.textContent = '上傳至 HF Spaces...'
      const file = fileOrBlob instanceof File ? fileOrBlob : new File([fileOrBlob], 'audio.wav')
      const stems = await callHFDemucs(file)

      STEM_META.forEach(m => {
        if (stems[m.key]) stemBuffers[m.key] = stems[m.key]
      })
    } else {
      // ── Demo mode: simulate 5-second wait ────────────────
      await new Promise(r => setTimeout(r, 5000))
    }

    clearInterval(timer)
    stopDemucsAnimation()
    wrapEl?.classList.remove('visible')
    btnEl.classList.remove('processing')
    btnEl.textContent = '重新分軌'
    btnEl.disabled    = false
    if (etaEl) etaEl.textContent = HF_READY ? '分軌完成' : '分軌完成（示範）'

    renderStemCards(gridEl)

    // Load WaveSurfer per stem if we have real buffers
    if (HF_READY) {
      STEM_META.forEach(m => {
        if (stemBuffers[m.key]) loadStemWaveSurfer(m.key, stemBuffers[m.key])
      })
    }

    if (bounceEl) bounceEl.disabled = false
    const statusEl = document.getElementById('bounce-status')
    if (statusEl) statusEl.textContent = '各軌調整完成後點擊 Bounce'

  } catch (err) {
    clearInterval(timer)
    stopDemucsAnimation()
    wrapEl?.classList.remove('visible')
    btnEl.classList.remove('processing')
    btnEl.textContent = 'AI 分軌（重試）'
    btnEl.disabled    = false
    console.error('[Demucs]', err)
    document.getElementById('bounce-status').textContent = `分軌失敗：${err.message}`
  }
}

// ── Render per-stem processing cards ─────────────────────
function renderStemCards(container) {
  if (!container) return
  container.innerHTML = ''
  STEM_META.forEach(meta => container.appendChild(buildStemCard(meta)))
}

function buildStemCard(meta) {
  const card = document.createElement('div')
  card.className = 'stem-proc-card'
  card.style.borderTop = `2px solid ${meta.color}`

  const modeNote = HF_READY
    ? '已分軌'
    : 'Phase 2 — 接 Demucs 後載入'

  card.innerHTML = `
    <div class="stem-proc-head">
      <div class="stem-proc-dot" style="background:${meta.color}"></div>
      <div class="stem-proc-name">${meta.label}</div>
      <div class="stem-proc-type">${modeNote}</div>
    </div>
    <div class="stem-proc-waveform" id="stem-waveform-${meta.key}" style="background:${meta.bg}">
      ${HF_READY && stemBuffers[meta.key] ? '' : `
        <div style="height:100%;display:flex;align-items:center;justify-content:center;font-size:10px;color:${meta.color};opacity:0.5">
          ${HF_READY ? '載入波形...' : '波形（分軌後載入）'}
        </div>`}
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
             data-stem="${meta.key}" aria-label="${meta.label} 音量">
      <span class="stem-vol-label" data-stem="${meta.key}">100%</span>
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
  const volLabel  = card.querySelector(`.stem-vol-label[data-stem="${meta.key}"]`)
  volSlider?.addEventListener('input', () => {
    const pct = Math.round(volSlider.value * 100)
    stemVolumes[meta.key] = parseFloat(volSlider.value)
    if (volLabel) volLabel.textContent = `${pct}%`
  })

  return card
}

// ── Bounce: process each stem → mix → dispatch to main chain
export async function bounce() {
  const statusEl = document.getElementById('bounce-status')
  const bounceEl = document.getElementById('bounce-btn')

  const hasRealBuffers = STEM_META.some(m => stemBuffers[m.key])
  if (!hasRealBuffers) {
    if (statusEl) statusEl.textContent = '需先完成 AI 分軌才能 Bounce（請設定 VITE_HF_ENDPOINT）'
    return
  }

  if (bounceEl) { bounceEl.disabled = true; bounceEl.textContent = 'Bounce 中...' }
  if (statusEl) statusEl.textContent = '處理各軌 EQ + 壓縮...'

  try {
    const processed = await Promise.all(
      STEM_META.map(m => processStem(stemBuffers[m.key], stemParams[m.key], stemVolumes[m.key]))
    )

    if (statusEl) statusEl.textContent = '混音中...'
    const mixed = mixBuffers(processed)
    if (!mixed) throw new Error('無可用的分軌音訊')

    // Dispatch to main.js for loading into master chain
    document.dispatchEvent(new CustomEvent('wf:stem-bounce', { detail: { buffer: mixed } }))

    if (statusEl) statusEl.textContent = '✓ Bounce 完成 → 已載入母帶處理鏈'
    if (bounceEl) { bounceEl.disabled = false; bounceEl.textContent = '重新 Bounce' }
  } catch (err) {
    console.error('[Bounce]', err)
    if (statusEl) statusEl.textContent = `Bounce 失敗：${err.message}`
    if (bounceEl) { bounceEl.disabled = false; bounceEl.textContent = 'Bounce (重試)' }
  }
}

// ── Public init ───────────────────────────────────────────
export function initStemsMastering(getAudioFile) {
  const btn = document.getElementById('stems-ai-btn')
  btn?.addEventListener('click', () => {
    const file = getAudioFile()
    if (!file) return
    separateStems(file)
  })

  document.getElementById('bounce-btn')?.addEventListener('click', bounce)
}
