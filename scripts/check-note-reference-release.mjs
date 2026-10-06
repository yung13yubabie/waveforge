#!/usr/bin/env node
/**
 * Focused regression: a cancelled note-reference resume must not retain source PCM.
 *
 * Run from the repository root:
 *   node --expose-gc /path/to/check-note-reference-release.mjs
 * Or supply the repository root:
 *   node --expose-gc /path/to/check-note-reference-release.mjs /path/to/waveforge
 *
 * Uses installed jsdom, the real DAW panel and real YIN analysis. Only the audio
 * decoder, analysis transport and suspended Web Audio context are doubles.
 * All PCM is generated here. No browser, network, private media or model is used.
 * This checks one specific reachability regression, not general leak freedom,
 * native Web Audio behavior, worker termination or total browser memory use.
 */
import assert from 'node:assert/strict'
import { File } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

if (typeof globalThis.gc !== 'function') {
  throw new Error('This regression requires explicit GC: run node --expose-gc check-note-reference-release.mjs [repository-root]')
}
if (process.argv.length > 3) throw new Error('Usage: node --expose-gc check-note-reference-release.mjs [repository-root]')

const repositoryRoot = resolve(process.argv[2] || process.cwd())
const requireFromRepository = createRequire(resolve(repositoryRoot, 'package.json'))
const { JSDOM } = requireFromRepository('jsdom')
const { initDawPanel } = await import(pathToFileURL(resolve(repositoryRoot, 'src/js/daw/panel.js')).href)
const { analyzePitch } = await import(pathToFileURL(resolve(repositoryRoot, 'src/js/pitch/analysis.js')).href)
const html = await readFile(resolve(repositoryRoot, 'index.html'), 'utf8')
const dom = new JSDOM(html)
const oldGlobals = new Map(['window', 'document', 'requestAnimationFrame', 'cancelAnimationFrame']
  .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
})

const root = document.getElementById('mode-editor')
assert(root, 'The actual editor DOM must exist')
root.hidden = false
const action = name => {
  const element = root.querySelector(`[data-daw="${name}"]`)
  assert(element, `Missing actual panel action: ${name}`)
  return element
}
async function waitFor(predicate, label, maxTurns = 100) {
  for (let turn = 0; turn < maxTurns; turn++) {
    await nextTurn()
    if (predicate()) return
  }
  throw new Error(`Timed out waiting for ${label}`)
}

let references = null, decodeCount = 0, analysisCalls = 0
function makeSyntheticSource() {
  const sampleRate = 48000, duration = .8, frequency = 440 * 2 ** (23 / 1200)
  const pcm = Float32Array.from({ length: Math.round(duration * sampleRate) },
    (_, frame) => .2 * Math.sin(2 * Math.PI * frequency * frame / sampleRate))
  const buffer = {
    length: pcm.length, numberOfChannels: 1, sampleRate, duration,
    getChannelData(channel) { assert.equal(channel, 0); return pcm },
  }
  // This function returns only the source. Its three probes are weak; no test
  // array, completed render, mock call log or fixture retains the real objects.
  references = {
    source: new WeakRef(buffer), channel: new WeakRef(pcm), backingStore: new WeakRef(pcm.buffer),
  }
  decodeCount++
  return buffer
}
const alive = () => Object.fromEntries(Object.entries(references).map(([name, reference]) => [name, reference.deref() !== undefined]))
async function collectReleasedSource() {
  let observed
  for (let turn = 1; turn <= 80; turn++) {
    // A deref keeps an object alive for the current JS job. Yield before every
    // GC, and retain only booleans between turns, so the probe cannot save it.
    await nextTurn(); globalThis.gc()
    await nextTurn(); globalThis.gc()
    observed = alive()
    if (turn >= 8 && Object.values(observed).every(value => !value)) return { turns: turn, alive: observed }
  }
  return { turns: 80, alive: observed }
}

let releaseResume, resumeRequested = false, resumeSettled = false, oscillatorCreations = 0
const resumeGate = new Promise(resolve => { releaseResume = resolve })
resumeGate.then(() => { resumeSettled = true })
const context = {
  currentTime: 0,
  resume() { resumeRequested = true; return resumeGate },
  close() { return Promise.resolve() },
  createOscillator() {
    oscillatorCreations++
    throw new Error('A cancelled reference must never create an oscillator')
  },
}
let panel
try {
  panel = initDawPanel({
    decodeAsset: async () => makeSyntheticSource(),
    AudioContextClass: function () { return context },
    confirmAction: () => true,
    noteAnalysisClientFactory: () => ({
      async analyze(buffer, options) {
        analysisCalls++
        const result = await analyzePitch(buffer.getChannelData(options.channel), buffer.sampleRate, {
          start: options.start, signal: options.signal,
        })
        return { ...result, channel: options.channel, analyzedChannel: options.channel }
      },
      dispose() {},
    }),
  })
  assert(panel)
  // The injected decoder ignores this deliberately non-WAV fixture. The panel
  // still performs its real import, registration, selection and history flow.
  await panel.importFiles([new File([new Uint8Array([1, 2, 3])], 'synthetic-reference.fixture')])
  await panel.analyzeNoteCenter()
  assert.equal(decodeCount, 1)
  assert.equal(analysisCalls, 1)
  assert.equal(action('note-center-reference').disabled, false, 'Real YIN/planner must enable the reference')
  assert.deepEqual(alive(), { source: true, channel: true, backingStore: true }, 'Probes must observe the live imported source first')

  action('note-center-reference').click()
  await waitFor(() => resumeRequested, 'the reference to reach its suspended resume')
  assert.equal(resumeSettled, false)
  assert.equal(root.getAttribute('aria-busy'), 'true')
  action('cancel').click()
  await waitFor(() => root.getAttribute('aria-busy') === 'false', 'Cancel to retire the current job')
  action('clear').click()
  await waitFor(() => panel.getProject().assets.length === 0, 'Clear to discard the project and retained sources')

  const collection = await collectReleasedSource()
  assert.equal(resumeSettled, false, 'Resume must remain unresolved throughout the collection check')
  assert.deepEqual(collection.alive, { source: false, channel: false, backingStore: false },
    'Cancelled reference resume still retains the cleared source or its PCM')
  assert.equal(oscillatorCreations, 0)

  releaseResume()
  await waitFor(() => resumeSettled, 'the explicit late resume release')
  for (let turn = 0; turn < 8; turn++) await nextTurn()
  assert.equal(oscillatorCreations, 0, 'A late resume must not start a cancelled reference')
  assert.equal(panel.getProject().assets.length, 0)
  console.log(JSON.stringify({
    passed: true, scenario: 'reference -> suspended resume -> Cancel -> Clear',
    syntheticFrames: 38400, sampleRate: 48000, collectionTurns: collection.turns,
    aliveWhileResumePending: collection.alive, oscillatorCreations,
    scope: 'Source/PCM reachability for this cancellation boundary only; Web Audio is a test double',
  }, null, 2))
} finally {
  releaseResume?.()
  for (let turn = 0; turn < 4; turn++) await nextTurn()
  panel?.destroy()
  dom.window.close()
  for (const [key, descriptor] of oldGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete globalThis[key]
  }
}
