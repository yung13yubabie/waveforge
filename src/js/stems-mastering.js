/**
 * Stems Mastering — Demucs 分軌 + 每軌 EQ/壓縮 + Bounce 回主鏈
 *
 * 模式：
 *   HF_READY=false → 5 秒模擬分軌（UI 展示）
 *   HF_READY=true  → 呼叫 HF Spaces Gradio API（真實 Demucs htdemucs）
 *
 * Bounce 流程：
 *   每軌: buffer → lowShelf → midPeak → highShelf → DynamicsCompressor → gain
 *   Mix: 4 軌加總 → overload warning / explicit Normalize Bounce
 *   載入: 發送 CustomEvent 'wf:stem-bounce'，main.js 接收後載入母帶鏈
 */

import WaveSurfer from 'wavesurfer.js'
import { startDemucsAnimation, stopDemucsAnimation } from './antitheft.js'
import { HF_ENDPOINT, HF_READY } from './config.js'
import { runDemucsJob } from './audio/hf-demucs.js'
import { processStem, mixBuffers, createStemGraph, bufferPeak, normalizeBuffer } from './audio/stem-mix.js'
import { encodeWAV } from './audio/wav.js'

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
  stemParams[m.key]  = { lowGain: 0, midGain: 0, highGain: 0, thresh: -24, ratio: 4, pan: 0 }
  stemVolumes[m.key] = 1.0
})

// ── Stem audio buffers (set after Demucs returns) ─────────
const stemBuffers = {}          // AudioBuffer per stem key
const stemWaveSurfers = {}      // WaveSurfer per stem key

let previewContext = null
let previewSources = []
let previewGraphs = {}
let previewGeneration = 0
let previewMeter = null

function stopStemPreview() {
  previewGeneration++
  clearInterval(previewMeter); previewMeter = null
  previewSources.forEach(src => { try { src.stop() } catch {} src.disconnect() })
  previewSources = []
  Object.values(previewGraphs).forEach(graph => graph.disconnect()); previewGraphs = {}
  if (previewContext) { previewContext.close().catch(() => {}); previewContext = null }
  const btn = document.getElementById('stems-preview-btn')
  if (btn) btn.textContent = '▶ 試聽分軌混音'
}
function updateStemPreview(key) {
  previewGraphs[key]?.update(stemParams[key], stemVolumes[key])
}
async function toggleStemPreview() {
  const status = document.getElementById('bounce-status')
  if (previewContext) { stopStemPreview(); status.textContent = '已停止分軌試聽'; return }
  if (!STEM_META.every(m => stemBuffers[m.key])) { status.textContent = '請先載入完整四軌'; return }
  const generation = ++previewGeneration
  const ctx = new AudioContext({ sampleRate: 48000 }); previewContext = ctx
  status.textContent = '啟動分軌試聽…'
  try {
    await ctx.resume()
    if (generation !== previewGeneration) return
    document.dispatchEvent(new Event('wf:stem-preview-start'))
    const bus = ctx.createGain(), split = ctx.createChannelSplitter(2)
    const meters = [ctx.createAnalyser(), ctx.createAnalyser()]
    bus.connect(ctx.destination); bus.connect(split)
    meters.forEach((meter, ch) => { meter.fftSize = 2048; split.connect(meter, ch) })
    const start = ctx.currentTime + 0.05
    let ended = 0
    for (const m of STEM_META) {
      const graph = createStemGraph(ctx, stemParams[m.key], stemVolumes[m.key])
      const src = ctx.createBufferSource(); src.buffer = stemBuffers[m.key]
      src.connect(graph.input); graph.output.connect(bus)
      previewGraphs[m.key] = graph; previewSources.push(src)
      src.onended = () => { if (generation === previewGeneration && ++ended === 4) { stopStemPreview(); status.textContent = '分軌試聽結束' } }
      src.start(start)
    }
    document.getElementById('stems-preview-btn').textContent = '■ 停止分軌試聽'
    const samples = new Float32Array(2048)
    previewMeter = setInterval(() => {
      let peak = 0
      for (const meter of meters) {
        meter.getFloatTimeDomainData(samples)
        for (const x of samples) peak = Math.max(peak, Math.abs(x))
      }
      const overload = peak >= 1
      status.classList.toggle('status-error', overload)
      status.textContent = overload ? '⚠ 混音超峰值，請降低各軌音量' : '試聽中 · EQ／壓縮／音量即時生效'
    }, 100)
  } catch (err) { stopStemPreview(); status.textContent = `試聽失敗：${err.message}` }
}

/** Decode one stem's encoded bytes into an AudioBuffer. */
async function decodeStem(arrayBuffer) {
  const ctx = new AudioContext({ sampleRate: 48000 })
  try {
    return await ctx.decodeAudioData(arrayBuffer)
  } finally {
    await ctx.close()
  }
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

  // Encode a WAV for WaveSurfer to draw from
  const wavBlob = new Blob([encodeWAV(pcm, sr, 16)], { type: 'audio/wav' })

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
  ws.loadBlob(wavBlob).catch(err => {
    const status = document.getElementById('bounce-status')
    if (status) status.textContent = `波形載入失敗：${err.message}`
  })
  stemWaveSurfers[stemKey] = ws
}

// ── Main separation flow ──────────────────────────────────
export async function separateStems(fileOrBlob) {
  const btnEl    = document.getElementById('stems-ai-btn')
  const wrapEl   = document.getElementById('demucs-progress-wrap')
  const etaEl    = document.getElementById('demucs-eta')
  const gridEl   = document.getElementById('stems-processing-grid')
  const bounceEl = document.getElementById('bounce-btn')

  if (!btnEl) return

  stopStemPreview()
  btnEl.classList.add('processing')
  btnEl.disabled  = true
  btnEl.textContent = '分軌中...'
  wrapEl?.classList.add('visible')
  startDemucsAnimation()

  // Honest elapsed timer — CPU Demucs has no reliable ETA (cold start + file
  // length vary wildly). Count UP, never fake a countdown that hits 0:00 while
  // the job is still running.
  const fmtClock = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
  let elapsed = 0
  const timer = setInterval(() => {
    elapsed++
    if (!etaEl) return
    etaEl.textContent = elapsed < 240
      ? `處理中 ${fmtClock(elapsed)}（CPU 分軌通常需 2–5 分鐘）`
      : `處理中 ${fmtClock(elapsed)}（Space 冷啟動或檔案較長，請耐心等待）`
  }, 1000)

  try {
    if (HF_READY) {
      // ── Live mode: call HF Spaces ────────────────────────
      if (etaEl) etaEl.textContent = '上傳至 HF Spaces...'
      const file = fileOrBlob instanceof File ? fileOrBlob : new File([fileOrBlob], 'audio.wav')
      const encoded = await runDemucsJob(file, HF_ENDPOINT)

      const next = {}
      for (const m of STEM_META) {
        if (!encoded[m.key]) throw new Error(`分軌結果缺少 ${m.label}`)
        next[m.key] = await decodeStem(encoded[m.key])
      }
      Object.assign(stemBuffers, next)
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

    if (bounceEl) bounceEl.disabled = !HF_READY
    document.getElementById('stems-preview-btn').disabled = !HF_READY
    const statusEl = document.getElementById('bounce-status')
    if (statusEl) statusEl.textContent = '各軌調整完成後點擊 Bounce'

  } catch (err) {
    clearInterval(timer)
    stopDemucsAnimation()
    wrapEl?.classList.remove('visible')
    btnEl.classList.remove('processing')
    btnEl.textContent = '重試分軌'
    btnEl.disabled    = false
    console.error('[Demucs]', err)
    const bsEl = document.getElementById('bounce-status')
    if (bsEl) bsEl.textContent = `分軌失敗：${err.message}`
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
  const stemIndex = STEM_META.findIndex(m => m.key === meta.key)
  card.style.setProperty('--stem-card-delay', `${stemIndex * 60}ms`)

  const modeNote = !!stemBuffers[meta.key]
    ? '已載入音軌'
    : 'Phase 2 — 接 Demucs 後載入'

  card.innerHTML = `
    <div class="stem-proc-head">
      <div class="stem-proc-dot" style="background:${meta.color}"></div>
      <div class="stem-proc-name">${meta.label}</div>
      <div class="stem-proc-type">${modeNote}</div>
    </div>
    <div class="stem-proc-waveform" id="stem-waveform-${meta.key}" style="background:${meta.bg}">
      ${stemBuffers[meta.key] ? '' : `
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
            <div class="stem-eq-value" id="eq-val-${meta.key}-${paramKey}">${stemParams[meta.key][paramKey]} dB</div>
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
    <label>聲像 <input class="stem-pan" type="range" min="-1" max="1" step="0.01"
      value="${stemParams[meta.key].pan}" aria-label="${meta.label} 聲像"></label>
    <div class="stem-proc-footer">
      <input type="range" class="stem-proc-vol" min="0" max="1" step="0.01" value="${stemVolumes[meta.key]}"
             data-stem="${meta.key}" aria-label="${meta.label} 音量">
      <span class="stem-vol-label" data-stem="${meta.key}">${Math.round(stemVolumes[meta.key] * 100)}%</span>
    </div>
  `

  card.querySelector('.stem-pan').addEventListener('input', e => {
    stemParams[meta.key].pan = Number(e.target.value); updateStemPreview(meta.key)
  })
  // Wire EQ sliders
  card.querySelectorAll('.stem-eq-slider').forEach(slider => {
    const valEl = card.querySelector(`#eq-val-${slider.dataset.stem}-${slider.dataset.param}`)
    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value)
      stemParams[slider.dataset.stem][slider.dataset.param] = v
      updateStemPreview(slider.dataset.stem)
      if (valEl) valEl.textContent = `${v >= 0 ? '+' : ''}${v} dB`
    })
  })

  // Wire compressor inputs
  card.querySelectorAll('.stem-comp-input').forEach(input => {
    input.addEventListener('change', () => {
      const value = Number(input.value)
      if (!Number.isFinite(value) || !input.checkValidity() || input.value === '') { input.reportValidity(); return }
      stemParams[input.dataset.stem][input.dataset.param] = value
      updateStemPreview(input.dataset.stem)
    })
  })

  // Wire volume slider
  const volSlider = card.querySelector('.stem-proc-vol')
  const volLabel  = card.querySelector(`.stem-vol-label[data-stem="${meta.key}"]`)
  volSlider?.addEventListener('input', () => {
    const pct = Math.round(volSlider.value * 100)
    stemVolumes[meta.key] = parseFloat(volSlider.value)
    updateStemPreview(meta.key)
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
    let mixed = mixBuffers(processed)
    if (!mixed) throw new Error('無可用的分軌音訊')

    const peak = bufferPeak(mixed)
    if (document.getElementById('normalize-bounce').checked) mixed = normalizeBuffer(mixed)
    else if (peak >= 1) throw new Error('混音超峰值：請降低音量，或明確勾選 Normalize Bounce 後重試（未載入母帶）')
    stopStemPreview()
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
  document.getElementById('stems-preview-btn').addEventListener('click', toggleStemPreview)
  document.addEventListener('wf:stop-stem-preview', stopStemPreview)
  window.addEventListener('pagehide', stopStemPreview)
  document.getElementById('stems-local-files').addEventListener('change', async e => {
    const files = Array.from(e.target.files), status = document.getElementById('bounce-status')
    stopStemPreview(); status.textContent = '讀取四軌音訊…'
    try {
      const next = {}
      for (const m of STEM_META) {
        const file = files.find(f => f.name.toLowerCase().includes(m.key) || f.name.includes(m.label))
        if (!file) throw new Error(`缺少 ${m.label}（${m.key}）檔案`)
        next[m.key] = await decodeStem(await file.arrayBuffer())
      }
      Object.assign(stemBuffers, next)
      renderStemCards(document.getElementById('stems-processing-grid'))
      STEM_META.forEach(m => loadStemWaveSurfer(m.key, stemBuffers[m.key]))
      document.getElementById('bounce-btn').disabled = false
      document.getElementById('stems-preview-btn').disabled = false
      status.textContent = '已載入四軌，可試聽並即時調整'
    } catch (err) { status.textContent = `載入失敗：${err.message}` }
    finally { e.target.value = '' }
  })
  // Show backend notice if HF not configured
  if (!HF_READY) {
    const notice = document.getElementById('stems-hf-notice')
    const desc   = document.getElementById('stems-hf-desc')
    if (notice) notice.hidden = false
    if (desc)   desc.hidden   = true
  }

  const btn = document.getElementById('stems-ai-btn')
  btn?.addEventListener('click', () => {
    const file = getAudioFile()
    if (!file) return
    separateStems(file)
  })

  document.getElementById('bounce-btn')?.addEventListener('click', bounce)
}
