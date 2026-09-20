import { test, expect } from '@playwright/test'

test('real browser realtime graph vs export: signals, modules, MBC mix and bypass', async ({ page }, testInfo) => {
  test.setTimeout(120000)
  await page.goto('/')
  const rows = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/js/audio/engine.js')
    const { renderMasterChain } = await import('/src/js/audio/render-chain.js')
    const { signal, signalNames } = await import('/tests/audio/render-parity/signals.js')
    const { measureIntegratedLUFS } = await import('/src/js/audio/measure.js')
    const { fft } = await import('/src/js/audio/fft.js')
    const rows = []
    const states = ['hplp', 'eq', 'dyneq', 'ms', 'deesser', 'comp', 'sat', 'limiter', 'full', 'bypass', 0, 25, 50, 75, 100]
    for (const state of states) for (const kind of signalNames) {
      const live = new AudioEngine()
      live.params.eqGains[5] = 4; live.params.compMakeup = 6; live.params.msWidth = 135
      live.params.mbcMix = typeof state === 'number' ? state : 50
      for (const key in live.bypassed) live.bypassed[key] = !(state === 'full' || key === state || (typeof state === 'number' && key === 'comp'))
      live.ctx = new OfflineAudioContext(2, 28800, 48000)
      live.dynamicsAvailable = true
      await live.ctx.audioWorklet.addModule('/src/js/audio/lufs-worklet.js')
      await live.ctx.audioWorklet.addModule('/src/js/audio/dynamics-worklet.js')
      live._buildGraph()
      const input = signal(live.ctx, kind)
      const src = live.ctx.createBufferSource(); src.buffer = input; src.connect(live.nodes.inputGain); src.start()
      const a = await live.ctx.startRendering()
      const b = await renderMasterChain({ engine: live, sourceBuffer: input, params: live.params,
        bypassed: live.bypassed, sampleRate: 48000, dynamicsWorkletUrl: '/src/js/audio/dynamics-worklet.js' })
      let peakResidual = 0, sq = 0, peakA = 0, peakB = 0
      for (let ch = 0; ch < 2; ch++) for (let i = 0; i < a.length; i++) {
        const x = a.getChannelData(ch)[i], y = b.getChannelData(ch)[i], d = x-y
        peakResidual = Math.max(peakResidual, Math.abs(d)); sq += d*d
        peakA = Math.max(peakA, Math.abs(x)); peakB = Math.max(peakB, Math.abs(y))
      }
      const lufs = buffer => measureIntegratedLUFS([buffer.getChannelData(0), buffer.getChannelData(1)], 48000)
      const la = lufs(a), lb = lufs(b)
      const ar = Float64Array.from(a.getChannelData(0).slice(0, 4096)), ai = new Float64Array(4096)
      const br = Float64Array.from(b.getChannelData(0).slice(0, 4096)), bi = new Float64Array(4096)
      fft(ar, ai); fft(br, bi)
      let spectrumDelta = 0
      for (let k = 0; k < 2048; k++) spectrumDelta = Math.max(spectrumDelta, Math.abs(Math.hypot(ar[k], ai[k]) - Math.hypot(br[k], bi[k])))
      rows.push({ state, kind, peakResidual, rmsResidual: Math.sqrt(sq/(2*a.length)),
        peakDelta: Math.abs(20*Math.log10(peakA/peakB)), lufsDelta: la === lb ? 0 : Math.abs(la-lb), spectrumDelta })
    }
    return rows
  })
  await testInfo.attach('render-parity.json', { body: JSON.stringify(rows, null, 2), contentType: 'application/json' })
  for (const row of rows) {
    expect(row.peakResidual, JSON.stringify(row)).toBeLessThan(1e-6)
    expect(row.rmsResidual).toBeLessThan(1e-7)
    expect(row.peakDelta).toBeLessThan(0.05)
    expect(row.lufsDelta).toBeLessThan(0.05)
    expect(row.spectrumDelta).toBeLessThan(0.001)
  }
})

test('MBC Mix zero is dry and bypass is sample exact at the module boundary', async ({ page }) => {
  await page.goto('/')
  const results = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/js/audio/engine.js')
    const { signal } = await import('/tests/audio/render-parity/signals.js')
    const { buildProcessingGraph } = await import('/src/js/audio/processing-graph.js')
    const renders = []
    for (const mode of [0, 25, 50, 75, 100, 'bypass']) {
      const e = new AudioEngine(); e.ctx = new OfflineAudioContext(2, 28800, 48000)
      e.params.compMakeup = 12; e.params.mbcMix = mode === 'bypass' ? 75 : mode; e.bypassed.comp = mode === 'bypass'
      buildProcessingGraph(e, { metering: false })
      e.nodes.mbcParallelOut.disconnect(); e.nodes.mbcParallelOut.connect(e.ctx.destination)
      const input = signal(e.ctx, 'multitone'), src = e.ctx.createBufferSource(); src.buffer = input
      src.connect(e.nodes.mbcIn); src.connect(e.nodes.mbcDryTap); src.start()
      const out = await e.ctx.startRendering()
      renders.push(Array.from(out.getChannelData(0)))
      if (mode === 0 || mode === 'bypass') {
        for (let i = 0; i < out.length; i++) if (out.getChannelData(0)[i] !== input.getChannelData(0)[i]) throw new Error('Not dry')
      }
    }
    return [1, 2, 3].map(k => Math.max(...renders[k].map((x, i) => Math.abs(x - ((1-k/4)*renders[0][i] + k/4*renders[4][i])))))
  })
  results.forEach(v => expect(v).toBeLessThan(1e-6))
})


test('linear-phase EQ keeps the 1 kHz boost at 44.1/48/96 kHz from a 48 kHz source', async ({ page }) => {
  await page.goto('/')
  const results = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/js/audio/engine.js')
    const { renderFinalMaster } = await import('/src/js/audio/final-render.js')
    const { signal } = await import('/tests/audio/render-parity/signals.js')
    const e = new AudioEngine(); await e.init()
    for (const key in e.bypassed) e.bypassed[key] = true
    e.bypassed.eq = false; e.params.masterVol = 1
    const source = signal(e.ctx, 'sine1000')
    const rows = []
    for (const sampleRate of [44100, 48000, 96000]) {
      const render = async gain => {
        const snapshot = e.serialize(); snapshot.params.eqGains[5] = gain
        const result = await renderFinalMaster({ engine: e, sourceBuffer: source, snapshot, sampleRate, linearPhase: true })
        const x = result.channels[0]; let sum = 0, n = 0
        for (let i = Math.round(sampleRate * 0.2); i < Math.round(sampleRate * 0.5); i++) { sum += x[i]*x[i]; n++ }
        return Math.sqrt(sum/n)
      }
      rows.push(20*Math.log10(await render(6) / await render(0)))
    }
    await e.ctx.close(); return rows
  })
  for (const db of results) expect(db).toBeCloseTo(6, 1)
})
