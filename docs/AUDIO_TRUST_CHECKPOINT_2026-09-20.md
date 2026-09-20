# Audio Trust / controls and stems repair — 2026-09-20

Baseline: `777a30f`. Specification: the user-supplied Full DAW All-In Master Prompt (§§0–112), read in full. Online-first product; native VST3/ARA are not browser features.

## Implemented in this change

- Replaced rotary drag handlers with horizontal native ranges, editable numbers, units and reset buttons. Invalid/empty values leave DSP unchanged. Preset/history retain the same keyed control API; no per-control window mouse/touch listeners.
- Source file status, duration and waveform are visible in the full-width stems tab. Corrupt replacement reports failure and preserves the previously accepted source, playhead, export controls and stem settings. A successfully accepted new source invalidates the previous stem set.
- Removed the unused six-stem `StemsPanel` and null-container construction. Unconfigured Demucs is disabled, with a visible alternative to import four stems; no simulated success.
- Four-stem loading has generation guards, duplicate/missing name errors, neutral defaults and visible current file names. Old WaveSurfer instances are destroyed before containers are replaced. Draw from already-decoded PCM instead of decoding the WAV again.
- Stems have explicit EQ/compressor bypass, mute, solo and compression reduction readouts. A default stereo impulse nulls against the source. Bounce captures processing state and awaits master-loader acknowledgement.
- Monitor gain is outside the master processing/meter/export path. Master output gain is a separate editable dB parameter. Legacy snapshots migrate linear master gain and global compressor values to canonical dB/per-band state, schema v2.
- HP/LP and limiter use actual alternate routes. Limiter activation reapplies ceiling/release/input. Pre-load parameter changes no longer dereference missing nodes.
- MBC dry delay aligns with the native compressor pre-delay, tested at 44.1/48/96 kHz and mixes 0/25/50/75/100. Bypass removes the delay.
- Export graphs allocate no spectrum/correlation analysers, A/B bypass gain, LUFS meter or monitor gain. EQ response uses static shared band metadata.
- WAV decoding preserves source sample rate independently from the monitor context. Unknown formats still use an explicitly documented browser-rate fallback.
- Integer deliveries reject non-finite samples and overload by default. Single-track exports can explicitly allow hard clipping; album assembly blocks overload. Final preview clears on new source load.
- Browser output comparison checks exact WAV headers, every sample within 2 PCM24 LSB and RMS below 1 LSB, rather than failing on a one-bit floating-point difference.
- Decode commit stops any old playback restarted during decoding. UI transport is locked during source loading. Stem imports remain locked throughout Bounce and master loading.
- Album gain trim remains effective with the limiter bypassed; with the limiter active it still applies before limiting.

## Reproduced failures

1. No range/number inputs existed for HP frequency; no stems source-status node existed.
2. Default disabled stem DSP changed the impulse by a peak residual of 0.8000000119.
3. Pre-load HP update threw `Cannot read properties of undefined (reading 'frequency')`.
4. Offline graph created a bypass gain and monitoring analysers.
5. All-bypassed master with limiter input +12 dB produced residual 0.5 instead of identity.
6. MBC at 44.1 kHz: dry impulse index 1024, wet index 1288. Partial mixes contained distinct delayed components.
7. Unit discovery picked up ignored Playwright deployment artifacts under `outputs/`; scope narrowed to `tests/**/*.test.js`.
8. Full browser run exposed toolbar overflow: invisible upload input intercepted stems-tab clicks after an extra export setting was added. Corrected before release.
9. Playback restarted while decoding was not stopped at source commit; regression now asserts the previous source is stopped.
10. Album trim of -6 dB produced a 0 dB change when limiter bypass skipped its input gain; browser regression now requires -6 dB.

## Verification status

- `npm run build`: PASS (95 modules; Vite reports a non-blocking >500 kB chunk warning).
- `npm run lint`: PASS, 98 JavaScript files.
- `npm test`: PASS, 39 files / 457 tests. Rotary-only tests were retired and replaced with native input tests.
- `npm run test:e2e -- --workers=1`: PASS, 40 real Chromium tests, including the reproduced album-trim regression.
- After the final upload-label CSS adjustment, rebuilt and ran `npm run test:production`: PASS, 13 tests against built assets.
- Inspected actual master-control and four-stem screenshots. Upload label no longer wraps outside its header; stems use the full workspace and scroll to their controls.
- Read-only independent review found no remaining High/Medium release blockers in the scoped source-loading, transport, stem-locking and album-trim fixes.
- `git diff --check`: PASS. No new dependencies or separate package/asset generation step is required for this Vite deployment. Live deployment validation is recorded separately.

## Full specification status

Phase A is **IN PROGRESS**, not PASS. This change is a bug-fix checkpoint, not completion of the Full DAW specification. Remaining acceptance work includes:

- Saturator oversampling latency calibration across Chromium, Firefox and WebKit; full processor/path compensation and render tails.
- Native-rate decoding for other input formats and deterministic, calibrated high-quality SRC (current render resampling remains browser-native).
- One-clock, gain-matched final A/B transport; current preview uses separate media elements.
- Strict post-limit ceiling verification against independent/reference inter-sample vectors, post-codec QC, iterative measured album loudness.
- Stem/session persistence, undo and aligned multi-rate source assets; new project/timeline/recording/MIDI/WAM/automation/takes/AI phases B–M remain unimplemented.

Cloud separation, real microphones/devices, long-session stress and Firefox/WebKit were not validated by this checkpoint. No fake PASS or production-ready full-DAW claim is warranted.

## Documentation grounding

Context Hub had no relevant WaveSurfer/Web Audio entry and no docs_mcp server was available. Used installed WaveSurfer implementation and official [WaveSurfer documentation](https://wavesurfer.xyz/docs/), plus [W3C compressor processing](https://www.w3.org/TR/webaudio/#DynamicsCompressorNode) and [oversampling latency](https://www.w3.org/TR/webaudio/#WaveShaperNode). W3C describes a 6 ms compressor pre-delay; oversampling delay is implementation dependent. The MBC implementation is verified on Chromium here, not certified across browsers.
