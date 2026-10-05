import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Album } from '../../src/js/album.js'
import { initAlbumPanel } from '../../src/js/ui/album-panel.js'
import { measureIntegratedLUFS } from '../../src/js/audio/measure.js'
import { TEST_RATES, tonalBalance } from '../fixtures/audio-trust/signals.js'

describe('album source-loudness native-rate regression', () => {
  beforeEach(() => {
    document.body.innerHTML = '<button id="album-add-btn"></button><div id="album-list"></div><span id="album-count"></span><button id="album-align-btn"></button><button id="album-export-btn"></button>'
  })
  it.each(TEST_RATES)('measures uploaded %i Hz PCM at its own rate, not monitor rate', sampleRate => {
    const buffer = tonalBalance(sampleRate)
    const album = new Album()
    const source = new File(['synthetic fixture descriptor'], 'synthetic.wav')
    initAlbumPanel({ album, engine: { ctx: { sampleRate: 48000 }, buffer, serialize: () => ({ params: {} }) },
      getCurrentFile: () => source, captureRenderOptions: vi.fn(), setProcessing: vi.fn(), setStatus: vi.fn() })
    document.getElementById('album-add-btn').click()
    expect(album.tracks[0].lufs).toBe(measureIntegratedLUFS([buffer.getChannelData(0)], sampleRate))
    expect(document.querySelector('.ac-lufs').textContent).toBe(album.tracks[0].lufs.toFixed(1))
  })
})
