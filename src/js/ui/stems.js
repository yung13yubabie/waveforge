// Render 6 stem tracks after Demucs separation
// Each track gets its own WaveSurfer instance, solo/mute/volume controls.

import WaveSurfer from 'wavesurfer.js'

const STEM_META = [
  { key: 'vocals',  label: '人聲',  type: '主唱 / 和聲', icon: '🎤', colorVar: '--c-waveform-stem-0' },
  { key: 'drums',   label: '鼓組',  type: '大鼓 / 小鼓 / 鈸', icon: '🥁', colorVar: '--c-waveform-stem-1' },
  { key: 'bass',    label: '貝斯',  type: '電貝斯 / 合成貝斯',  icon: '🎸', colorVar: '--c-waveform-stem-2' },
  { key: 'piano',   label: '鋼琴',  type: '鋼琴 / 鍵盤',  icon: '🎹', colorVar: '--c-waveform-stem-3' },
  { key: 'guitar',  label: '吉他',  type: '電吉他 / 木吉他',  icon: '🎵', colorVar: '--c-waveform-stem-4' },
  { key: 'other',   label: '其他',  type: '弦樂 / 合成器',  icon: '🎼', colorVar: '--c-waveform-stem-5' },
]

export class StemsPanel {
  constructor(container) {
    this.container = container
    this.stems = {}   // key → { ws: WaveSurfer, muted, solo, gain }
    this.soloActive = false
  }

  // stemBlobs: { vocals: Blob, drums: Blob, ... }
  async load(stemBlobs) {
    this._clear()
    document.getElementById('stems-empty')?.remove()

    for (const meta of STEM_META) {
      const blob = stemBlobs[meta.key]
      if (!blob) continue

      const color = getComputedStyle(document.documentElement)
        .getPropertyValue(meta.colorVar).trim() || '#E8003C'

      const track = this._createTrack(meta, color)
      this.container.appendChild(track.el)

      const ws = WaveSurfer.create({
        container:     track.waveEl,
        waveColor:     color + '80',
        progressColor: color,
        height:        34,
        barWidth:      2,
        barGap:        1,
        barRadius:     1,
        interact:      false,
        normalize:     true,
      })

      await ws.loadBlob(blob)

      this.stems[meta.key] = {
        ws, el: track.el,
        muted: false, solo: false, gain: 1.0,
        muteBtn: track.muteBtn, soloBtn: track.soloBtn,
        volInput: track.volInput,
      }

      this._wireControls(meta.key)
    }
  }

  _createTrack(meta, color) {
    const el = document.createElement('div')
    el.className = 'stem-track'
    el.dataset.stemKey = meta.key

    const waveEl = document.createElement('div')
    waveEl.className = 'stem-waveform'

    const info = document.createElement('div')
    info.className = 'stem-info'

    const dot = document.createElement('div')
    dot.className = 'stem-color-dot'
    dot.style.background = color

    const icon = document.createElement('span')
    icon.className = 'stem-icon'
    icon.textContent = meta.icon

    const textWrap = document.createElement('div')
    const nameEl = document.createElement('div')
    nameEl.className = 'stem-name'
    nameEl.textContent = meta.label
    const typeEl = document.createElement('div')
    typeEl.className = 'stem-type'
    typeEl.textContent = meta.type
    textWrap.appendChild(nameEl)
    textWrap.appendChild(typeEl)

    info.appendChild(dot)
    info.appendChild(icon)
    info.appendChild(textWrap)
    el.appendChild(info)
    el.appendChild(waveEl)

    const controls = document.createElement('div')
    controls.className = 'stem-controls'

    const volInput = document.createElement('input')
    volInput.type = 'range'; volInput.min = '0'; volInput.max = '1'
    volInput.step = '0.01'; volInput.value = '1'
    volInput.className = 'stem-vol'
    volInput.setAttribute('aria-label', `${meta.label} 音量`)

    const muteBtn = document.createElement('button')
    muteBtn.className = 'stem-btn'
    muteBtn.textContent = 'M'
    muteBtn.setAttribute('aria-label', `靜音 ${meta.label}`)
    muteBtn.setAttribute('aria-pressed', 'false')

    const soloBtn = document.createElement('button')
    soloBtn.className = 'stem-btn'
    soloBtn.textContent = 'S'
    soloBtn.setAttribute('aria-label', `獨奏 ${meta.label}`)
    soloBtn.setAttribute('aria-pressed', 'false')

    controls.append(volInput, muteBtn, soloBtn)
    el.appendChild(controls)

    return { el, waveEl, muteBtn, soloBtn, volInput }
  }

  _wireControls(key) {
    const s = this.stems[key]

    s.volInput.addEventListener('input', () => {
      s.gain = parseFloat(s.volInput.value)
      this._applyGain(key)
    })

    s.muteBtn.addEventListener('click', () => {
      s.muted = !s.muted
      s.muteBtn.classList.toggle('active-mute', s.muted)
      s.muteBtn.setAttribute('aria-pressed', String(s.muted))
      s.el.classList.toggle('muted', s.muted)
      this._applyGain(key)
    })

    s.soloBtn.addEventListener('click', () => {
      s.solo = !s.solo
      s.soloBtn.classList.toggle('active-solo', s.solo)
      s.soloBtn.setAttribute('aria-pressed', String(s.solo))
      this.soloActive = Object.values(this.stems).some(st => st.solo)
      this._applyAllGains()
    })
  }

  _applyGain(key) {
    const s = this.stems[key]
    // setVolume exists on all WaveSurfer v7 backends; solo state must also apply
    const vol = (s.muted || (this.soloActive && !s.solo)) ? 0 : s.gain
    s.ws.setVolume(vol)
  }

  _applyAllGains() {
    for (const key of Object.keys(this.stems)) this._applyGain(key)
  }

  // Synchronise playback with main WaveSurfer (seek all stems to same position)
  seekAll(fraction) {
    for (const s of Object.values(this.stems)) s.ws.seekTo(fraction)
  }

  playAll()  { for (const s of Object.values(this.stems)) s.ws.play()  }
  pauseAll() { for (const s of Object.values(this.stems)) s.ws.pause() }
  stopAll()  { for (const s of Object.values(this.stems)) s.ws.stop()  }

  _clear() {
    for (const s of Object.values(this.stems)) s.ws.destroy()
    this.stems = {}
    this.soloActive = false
    // Remove rendered tracks (keep empty state if present)
    this.container.querySelectorAll('.stem-track').forEach(el => el.remove())
  }
}
