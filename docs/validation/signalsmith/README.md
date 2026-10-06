# Signalsmith Stretch integration candidate

> Integration update: a local constant clip-transpose workflow now implements this path; see [workflow candidate](../CLIP_TRANSPOSE_WORKFLOW_2026-10-06.md). The statements below describe the earlier engine-only checkpoint. Actual browser execution and listening remain pending.

Date: 2026-10-06. Scope: local engine, worker, tests and evidence only. No editor, DAW render, preview, export, package dependency or main-page integration has been made. The prior in-house pitch shifters remain separate internal research.

## Recommendation and current decision

Continue toward a narrowly labelled **constant clip-transpose audition**, after actual browser/worker execution and representative listening. The low-level implementation is promising enough for that next validation step. It does not establish precision pitch snapping, automatic note correction, professional vocal restoration, vibrato/drift editing, or exact formant preservation.

Suggested future workflow, not implemented here:

1. Select a short clip, initially an isolated vocal phrase, up to 30 seconds; retain the original source
2. Set constant pitch amount and, separately, optional timbre/formant controls; explicitly describe compensation as approximate
3. Render once in a dedicated worker, and use that **same returned PCM** for audition and later accepted/exported audio
4. Offer original/processed comparison, Cancel and explicit Accept as a new version/take. Editing the source or settings must cancel/invalidate the prior result
5. Preserve duration and placement. Warn when selection edges contain strong attacks; do not disguise edges with an unshifted splice. Check peak/headroom before playback/export and surface any necessary gain choice
6. Keep Undo/original recovery. Show that nearby stereo components, consonants, attacks, breaths and timbre may change; ask the listener to judge the actual result

A global all-signal “perfect waveform” criterion is not used. Separate adapter correctness from intrinsic DSP tradeoffs. An impulse is broadband, and moving its spectrum necessarily changes bandwidth, waveform shape and sometimes retained crop energy. These measurements are diagnostics, not a requirement that arbitrary transposition preserve every input sample or every impulse amplitude. Precision pitch adjustment needs tighter calibrated evidence than a labelled audition tool.

### Status by category

| Category | Result |
|---|---|
| Source identity / local-only execution | Verified pinned official bytes, export-only derivative, unchanged embedded WASM; no network calls in tested DSP paths |
| Adapter duration / finite PCM / ownership | Node tests pass exact length/rate, finite output, source immutability, zero bypass, owned worker transfer |
| EOF adapter drain | Corrected: process through output latency before final flush; direct early flush measurably attenuates incomplete terminal windows |
| Cancellation / stale jobs / timeout | Node lifecycle tests pass; per-job worker is terminated and old responses ignored |
| Build integration | Dedicated Vite worker bundle passes; public third-party notice survives normal site build |
| Intrinsic pitch/stereo/transient tradeoffs | Measured, retained below; no blanket professional-quality pass claimed |
| Actual browser execution | Pending; new Playwright engine test supplied but not run here |
| Perceptual / representative singing validation | Pending. One CC0 voice is an objective sample, not a vocal corpus or listening test |
| User-facing integration / export acceptance | Not performed; requires the above browser and listening evidence plus separate editor lifecycle tests |

## Approved component and provenance

Official project: <https://signalsmith-audio.co.uk/code/stretch/>. Fixed repository revision: [222093b4cc13ddb4d07c826bc3c1559326091731](https://github.com/Signalsmith-Audio/signalsmith-stretch/tree/222093b4cc13ddb4d07c826bc3c1559326091731). Its [web package metadata](https://github.com/Signalsmith-Audio/signalsmith-stretch/blob/222093b4cc13ddb4d07c826bc3c1559326091731/web/release/package.json) declares version **1.3.2**.

- Original ESM: `src/js/pitch/vendor/signalsmith-stretch/upstream/SignalsmithStretch.mjs`, byte-for-byte retained
- Original size: **113,867 bytes**; Git blob SHA-1 `7d5cae72e77a84143ed91ba12fc91b806dc4d9d1`
- Original SHA-256: `97530b11d5bc01015af4cde40d6aa55ff10c40aa1294ca4c8c5762027d517a46`
- Runtime derivative: `src/js/pitch/vendor/signalsmith-stretch/SignalsmithStretch.mjs`; **114,008 bytes**
- Derivative SHA-256: `4f6c89d205cc505087948fdfa10f3d9629e780349440cee9f9092c8e24d6e269`
- Embedded WASM: **64,494 bytes**; SHA-256 `83869197b3c5ebf9fc8c517a1586aef1ecf77404842218d62b9c0e82882d8ca3`

The only derivative change inserts a named `createSignalsmithModule` export before the higher-level wrapper replaces the underlying factory. The embedded WASM is unchanged. `scripts/verify-signalsmith-vendor.mjs` checks exact original hashes, exact patch and WASM equality; `--write` regenerates the derivative from the retained original. It never downloads, installs, builds a toolchain or runs upstream shell scripts.

The unchanged original is a provenance reference; the derivative is the single runtime import. There is no UMD duplicate and no runtime loading of the original reference. The isolated minified bundle contains one ~99 KB Signalsmith chunk, one ~5 KB worker, and one ~5 KB client/validation entry.

MIT notice is retained beside the component. `public/licenses/signalsmith-stretch.txt` also retains official Signalsmith Linear and Emscripten notices, so minification cannot strip the available notice artifact. This licenses **those third-party components only**, not the user's repository. The upstream precompiled release does not record the exact compiled Linear or Emscripten revision; the retained dependency notices are identified as such rather than claiming a reproducible native build or exact dependency SBOM.

### Source audit

Read before execution: the bundled factory/wrapper, [C ABI](https://github.com/Signalsmith-Audio/signalsmith-stretch/blob/222093b4cc13ddb4d07c826bc3c1559326091731/web/emscripten/main.cpp), [C++ algorithm/header](https://github.com/Signalsmith-Audio/signalsmith-stretch/blob/222093b4cc13ddb4d07c826bc3c1559326091731/signalsmith-stretch.h), [README](https://github.com/Signalsmith-Audio/signalsmith-stretch/blob/222093b4cc13ddb4d07c826bc3c1559326091731/README.md), and build-script text. The build script was **not executed**: it can clone `emsdk` and install `latest`.

Build flags declare `SINGLE_FILE=1`, `FILESYSTEM=0`, `DYNAMIC_EXECUTION=0`, and `ENVIRONMENT=web,worker,shell`. The factory decodes an embedded WASM data URI. Node tests replacing `fetch` with a throwing spy observed zero calls. No model, remote audio request, account, paid service, toolchain installation, or audio upload is introduced.

Two higher-level wrapper defects were confirmed: scheduling looks for `objIn.outputTime` although documented/public callers use `output`, and channel-change processing calls unqualified `configure()` instead of `this.configure()`. The adapter does **not call that wrapper**, create an AudioWorklet node, or use its scheduler.

The C++ constructor seeds a random engine, but phase randomisation is used for time-stretch ratios greater than two; this adapter holds time ratio at one. Repeated independent-instance noise renders were byte-identical in tested Node runs. No cross-browser bit-identity promise is made without browser evidence.

## API and hard resource bounds

`src/js/pitch/signalsmith-render.js` exports:

```js
renderSignalsmithPitch(channels, sampleRate, {
  semitones: 0, cents: 0,
  formantSemitones: 0,
  formantCompensation: false,
  formantBaseHz: 0,
  signal, onProgress, yieldControl,
}) // Promise<{ channels, sampleRate, metadata }>
```

- One or two equal-length `Float32Array` channels; no shared buffers; borrowed read-only until settlement
- Sample rates: 44,100 / 48,000 / 96,000 Hz
- Constant pitch: `semitones + cents / 100`, finite, total within ±2 semitones
- Independent formant amount: finite, within ±2 semitones. Compensation is a boolean. Base frequency is 0 (upstream automatic estimate) or 50–1000 Hz; the C ABI receives Hz/sampleRate
- Maximum length: 30 seconds; minimum nonempty nonzero pitch/formant render: 120 ms
- Finite input, absolute sample values ≤8. Invalid shapes/settings reject before allocating DSP buffers
- Zero pitch and zero formant shift return a fresh bit-exact copy, including signed zero and above-unity headroom, even if compensation is selected. No WASM instance is needed for bypass. Empty input is an exact no-op
- Output sample count and rate are unchanged. Output is fresh owned PCM; source is never modified
- **No normalization or clipping.** `metadata.outputPeak` reports peak, and `outputGain` remains 1. Above-unity float PCM must go through the application's existing preview/export safety decision; it must not be silently converted to clipped integer audio
- `signal` is validated as an AbortSignal-shaped interface. Core cancellation checks occur before/after yields, buffer chunks and initialization; no partial output is returned
- `onProgress` is monotonic in [0,1]; 1 reports a completed calculation. Core/client callbacks are observers; their exceptions do not invalidate audio. Cancellation is checked during work and before terminal completion. An abort requested from the terminal callback cannot undo already-completed DSP; the caller must still check signal/source ownership before adopting the returned PCM
- `metadata` includes engine/version, actual pitch/formant settings, exact sample counts, time ratio, latency, block/interval sizes, measured WASM memory, peak, bypass and unvalidated-quality status. `formantPreservationClaimed` is always false

`src/js/pitch/signalsmith-client.js` exports:

```js
const client = createSignalsmithPitchClient({ timeoutMs: 60000 })
const result = await client.render(channels, sampleRate, {
  semitones, cents, formantSemitones, formantCompensation, formantBaseHz,
  sourceToken: 'asset-id:edit-revision', signal, onProgress,
})
client.cancel()
client.dispose()
```

The browser client copies before transfer and never detaches an `AudioBuffer` channel. Maximum stereo input copy is 23,040,000 bytes. The worker returns owned output arrays by transfer. Only one job is active; a newer valid request terminates/rejects its predecessor. Invalid replacement input leaves the valid active job intact. Success, cancellation, timeout, disposal, crash, decode error and invalid response all terminate the one-shot worker. IDs and worker identity reject late messages. Default timeout is 60 seconds, with configurable maximum five minutes. No fallback computes nonzero DSP on the UI thread.

`sourceToken` is echoed with `requestId`; a UI must cancel when source/settings change and check that token before accepting PCM. The client cannot infer external editor mutations. Calling the same rendered result “preview and export parity” is only valid once application integration actually uses it in both paths.

### Latency and EOF policy

The selected setting is upstream `presetDefault`: 120 ms block, 30 ms interval, no split computation. It reports 60 ms input lookahead plus 60 ms output latency. At 48 kHz these are 2,880 + 2,880 samples; at 44.1 kHz 2,646 + 2,646; at 96 kHz 5,760 + 5,760.

1. Configure a fresh instance and set controls before processing
2. Seek with the first `inputLatency` source samples (zero padded only if needed)
3. Process equal input/output block sizes with input offset by input latency
4. Continue through **length + outputLatency** generated samples, supplying zero context beyond source end. Discard the output pre-roll and copy precisely the requested source-length interval
5. Only then flush/reset the residual state; do not use early-flush PCM as the unfinished final output

An initial experiment following a direct flush immediately after processing input length produced ~11 dB near-EOF impulse attenuation in 1.3.2. Full processing through output latency removed that adapter/drain problem. Remaining crop energy/shape changes below are retained DSP observations, not treated as dropped buffers. No unshifted edge patch, source wrapping, phase-independent channel substitution, folded reflection or arbitrary gain rescue is used.

## Objective evidence and limits

Machine-readable observations: [synthetic.json](synthetic.json), [configurations.json](configurations.json), [real-fixture.json](real-fixture.json), [formants.json](formants.json). Scripts complete even when an observation is poor; successful execution means measurement succeeded, not every quality criterion passed.

### Synthetic / stereo

- Exact lengths/rates and finite outputs in all reported runs
- The original 220 Hz tone probe, ±2 st at all three rates, has 3.93–9.07 cents error under the default setting; a broader six-frequency grid (55/110/180/220/440/997 Hz) reaches **21.90 cents**
- Synthetic harmonic vowel errors were ~0.60–1.07 cents, with high periodic correlation. This difference shows why one stationary waveform does not establish vocal performance
- Slow chirp measurement reached **10.86 cents** error in sampled centers
- Close-frequency native stereo at L220/R230, L220/R240, L55/R60 reached **26.96 cents** absolute per-channel error, depending on rate and direction
- The C++ `findPeaks()` explicitly identifies peaks from summed channel energy and makes one shared output map. Nearby components can share a mapped peak region; increasing block resolution improves but does not eliminate this tradeoff
- A 23 kHz/48 kHz tone shifted +2 st was attenuated ~88.8 dB in the interior; downward shift ~0.12 dB. This is a diagnostic of high-frequency behavior, not a comprehensive aliasing certification

### Boundaries / transients

The favorable 48 kHz/1-second five-impulse grid retains peak position exactly and loses at most ~0.64 dB energy. Compared with the old in-house prototype's −15.33 dB final-sample result and millisecond-scale interior peak movement, this is a meaningful improvement on those same probes.

The expanded **210-case** rate/duration/position matrix is essential: 44.1/48/96 kHz; 0.12, 0.121, 0.2, 0.333, 1, 1.001, 1.123 seconds; first, second, center, penultimate and final samples; ±2 st. Worst retained energy change is **−3.446 dB**, at 44.1 kHz/1 second/+2 st/final sample. Peak movement reaches **one sample**. The 48 kHz/0.2-second final impulse loses ~3.32 dB; 96 kHz/1.001-second final impulse ~3.28 dB. Thus the first favorable grid must not stand for all clip edges.

Other observed changes include pre-event energy, lower impulse peak height and attack-envelope redistribution. Exact duration and correct draining do not imply identical attacks or zero ringing. These artifacts need representative listening at phrase/consonant boundaries, without an artificial rule that all band-limited impulse energy must remain identical.

### Documented configuration experiment

The API's documented custom `configure(channels, blockSamples, intervalSamples, splitComputation)` was evaluated without changing production settings. All runs use native multichannel processing, never a hidden independent-channel fallback.

| Setting | Max absolute mono cents, six-frequency grid | Max absolute close-stereo cents | Minimum energy dB in 48 kHz/1 s impulse grid |
|---|---:|---:|---:|
| Default 120/30 ms | 21.90 | 26.96 | −0.64 |
| Cheaper 100/40 ms, split | 61.80 | 65.69 | −0.79 |
| 120/10 ms | 8.28 | 16.43 | −3.06 |
| 240/20 ms | 6.40 | 16.01 | −0.81 |
| 240/30 ms | 9.00 | 17.47 | −0.87 |
| 360/30 ms | 5.14 | 14.81 | −3.34 |
| 480/30 ms | 2.06 | 11.55 | −0.88 |

These custom settings are experiments with the documented API, not upstream-endorsed quality presets. The longest window adds 240 ms input + 240 ms output lookahead and changes transient/timbre behavior. Stationary-tone improvement alone is insufficient to select it for vocals. Default stays explicit until browser/listening comparison justifies a change. Independent stereo mode is not implemented; it would require an explicit spatial-coherence design decision and its own tests.

### Existing real singing fixture

The retained 20-second CC0 Twinkle fixture is hash-verified against its existing provenance, then locally converted using installed ffmpeg. No new recording/model/download/upload is involved. Upsampling its 16 kHz source to 44.1/48 kHz cannot restore frequencies above 8 kHz. Only one English voice is represented; the stereo probe is duplicated/inverted half-level mono, not a real stereo performance.

The same broad NSDF measurement used for the failed old implementation is retained. Frames are selected by confidence/level, never by whether their pitch error is favorable.

| Rate | Shift | Paired voiced frames | p95 absolute pitch error | Maximum absolute error |
|---|---:|---:|---:|---:|
| 44.1 kHz | −2 | 103 | 4.27 c | 18.76 c |
| 44.1 kHz | −1 | 103 | 5.24 c | 14.18 c |
| 44.1 kHz | +1 | 100 | 6.02 c | 11.09 c |
| 44.1 kHz | +2 | 101 | 5.09 c | 14.21 c |
| 48 kHz | −2 | 102 | 4.88 c | 15.03 c |
| 48 kHz | −1 | 104 | 6.60 c | 12.42 c |
| 48 kHz | +1 | 100 | 6.36 c | 11.51 c |
| 48 kHz | +2 | 101 | 4.46 c | 14.28 c |

Old implementation p95 values were ~2.49–4.01 c on the same fixture, so the new library is **not a blanket numerical improvement**. The new engine's stable-voiced subset p95 is ~3.56–4.63 c. All eight outputs are finite/exact 20 seconds. RMS changes are ~−0.086 to −0.140 dB without normalization. Maximum linked half-level stereo residual is **1.26×10⁻⁴**; it is not bit-exact stereo scaling and does not meet the old test's 10⁻⁷ residual criterion. Near-perfect correlation alone would hide that difference.

Five-ms envelopes retain best coarse match at zero lag, cosine similarity ~0.9958–0.9977, but normalized RMS shape error remains ~6.8–9.1%. Median strong-rise ratios span ~0.36–0.70; some corresponding output bins are falling. Consonants/attacks are not perceptually validated.

### Independent formant controls

A generated 100 Hz harmonic source with envelope centers ~700/1400/2800 Hz verifies that formant-only controls change spectral envelope without changing F0. At nominal ±2 st, measured envelope peaks move ~133–181 cents, not exactly 200. This is approximate timbre processing.

Pitch +2 st without compensation moves envelope peaks ~196–201 cents. With compensation, residual shifts are still ~9–63 cents. The synthetic F0 change remains ~+200.6 cents. Thus the API genuinely separates pitch and formant controls, while evidence does **not** justify an “exact natural voice preservation” label.

### Resources

One 30-second/96 kHz/native stereo render returned exactly 2,880,000 samples/channel in ~1.04 seconds of Node compute, excluding default yield delays. Observed WASM memory: **2,686,976 bytes**; new output PCM: ~23 MB, with caller source and browser worker copy separate. Process peak RSS was ~127 MB across the characterization run and is not a per-job/browser memory bound. Default control constraints cap the source, output and I/O buffers; one-shot worker termination releases the owning runtime, subject to browser reclamation timing.

## Lossless generated-source follow-up

A separate bounded Float32 WAV serializer and a native audition/accepted-asset/Undo/ZIP acceptance design have now been added. See [ASSET_ACCEPTANCE_PATH.md](ASSET_ACCEPTANCE_PATH.md) for the API, exact-storage tests, independent ffmpeg evidence, pending browser harness and sample-rate caveats. User-facing 16/24-bit export defaults remain unchanged.

## Validation and reproduction

On the final local candidate:

- **61 new focused tests pass** (47 engine/client plus 14 generated-file persistence tests): source hash/patch, true pitch vs unchanged rate, bypass, finite data, shape/resource limits, EOF drain examples, formants, no implicit clipping, deterministic repeat, no fetch, progress/cancel, worker transfer/source identity, timeout/crash/decode errors, malformed signal cleanup, stale results and worker/core PCM parity
- Full suite: **1,168 passed, 1 skipped**, 66 files
- `npm run lint`: 192 JavaScript files syntax checked
- `npm run build`: passes; existing large-chunk warning remains unrelated
- `node scripts/verify-signalsmith-bundle.mjs`: dedicated module worker build passes, no upstream-reference duplicate runtime; retained evidence in `bundle.json`
- `git diff --check`: passes for tracked diff; no remote push/deployment performed
- Independent source/Node review found one invalid-signal cleanup defect, now fixed with validation, guarded setup/cleanup and a regression test; it also prompted the expanded endpoint matrix

```sh
node scripts/verify-signalsmith-vendor.mjs
npx vitest run tests/audio/signalsmith-render.test.js tests/audio/signalsmith-client.test.js
node scripts/signalsmith-characterize.mjs > /tmp/signalsmith-synthetic.json
node scripts/signalsmith-configurations.mjs > /tmp/signalsmith-configurations.json
node scripts/signalsmith-real-fixture.mjs > /tmp/signalsmith-real.json
node scripts/signalsmith-formants.mjs > /tmp/signalsmith-formants.json
node scripts/verify-signalsmith-bundle.mjs
node scripts/verify-generated-float-wav.mjs
npm run lint && npm test && npm run build
```

Actual browser engine harness is supplied at `tests/e2e/signalsmith-worker.spec.js` for an authorized CI/browser environment. It tests real module worker loading, transferable source preservation, cancellation, formant-only execution, zero bypass, worker/core parity and no audio-upload request. It has **not run here**: local Chromium/socket execution is restricted, and no alternate launch/bypass was attempted. Even passing that harness will not count as editor UX, audio-device playback, export round-trip, mobile performance or perceptual validation.

Next validation should cover actual Chromium plus target Firefox/Safari where available; first-load/failed-load recovery; cancel/new source/settings during rendering; consecutive long selections and reclamation; original/processed audible comparison; clip edge context; saved/loaded accepted takes; same PCM through preview and export; and authorized listening on fast glides, breathy/raspy vocals, consonants, sustained vowels and genuine stereo material. No UI or export release claim should precede that evidence.
