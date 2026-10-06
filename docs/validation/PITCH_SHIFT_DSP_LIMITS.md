# Duration-preserving pitch DSP prototype: limits and evidence

Validation date: 2026-10-05. Status: **internal research only; do not enable a pitch-adjustment/export control.**

The implementation makes a genuine frequency change while preserving the exact sample count and sample rate. It is not a playback-rate shortcut. Objective pitch tests pass, but transient preservation, clip-boundary safety, close-frequency stereo, listening, and browser/worker validation do not yet meet a user-facing release bar. A green unit suite is not a production-quality vocal-correction claim.

## API and enforced bounds

`src/js/pitch/shift.js` exports `shiftPitch(channels, sampleRate, options)` and frozen `PITCH_SHIFT_LIMITS`.

- Input: one or two equal-length `Float32Array` channels, borrowed read-only until the promise completes. The caller must not mutate or transfer/detach them during processing
- Rates: 44,100, 48,000, or 96,000 Hz, explicitly checked
- Amount: `semitones` plus `cents / 100`, finite and within ±2 semitones total; constant throughout the clip
- Maximum: 30 seconds. Stereo 96 kHz therefore means at most 2,880,000 samples per channel
- Nonzero minimum: 4,096 samples at 44.1/48 kHz; 8,192 samples at 96 kHz, about 93/85/85 ms. Shorter nonempty requests reject explicitly, rather than return mislabeled unchanged audio
- Input samples must be finite and within ±8. Samples beyond unity are allowed within this bound
- Exact zero amount, including `semitones: 1, cents: -100`, returns fresh bit-identical channels, including signed zero. Empty input is a no-op for any supported amount
- Options: `signal`, `yieldControl`, `onProgress`. Default scheduling yields to the event loop; a worker wrapper may supply its own scheduler. Cancellation is checked between FFT frames and bounded sample blocks, and before/after awaited yields. The wrapper must discard stale results if a clip/source/edit changes
- Result: `{ channels, sampleRate, metadata }`. Output channels are fresh arrays with the original length. Metadata includes effective amount/ratio, input/output counts, FFT/hop sizes, window duration, `bypassed`, `experimental`, `releaseReadiness: 'internal-only'`, `formantPreserved: false`, and `outputGain`
- Progress is monotonic from 0 to 1. Only success emits 1. Exceptions/cancellation do not mutate the caller's audio or return a partial replacement

If a nonzero result exceeds a 0.999 sample peak, one shared attenuation is applied to all channels and reported as `outputGain`. The final Float32 representation can round the ceiling to 0.9990000129. This is not true-peak limiting, loudness normalization, or a clipping guarantee for later processing. Zero bypass does not alter headroom.

## Implementation and original technical basis

The module reuses the repository's pure radix-2 FFT from `audio/fft.js`; it adds no packages, model sources, remote execution, or uploads.

1. A centered periodic-Hann STFT uses 2,048 samples at 44.1/48 kHz, 4,096 at 96 kHz, and a quarter-window synthesis hop. Analysis centers follow synthesis time divided by pitch ratio
2. Interframe phase differences estimate instantaneous bin frequency. Channel cross-spectra are summed, rather than mixing stereo waveforms, so antiphase material does not cancel the reference
3. Shared spectral peaks define regions whose bins receive the same phase correction. Both channels receive the same rotations. Inverse transforms overlap-add with the periodic-Hann squared-window normalization of 1.5
4. A 48-tap, 1,024-phase, interpolated Blackman-windowed-sinc resampler restores the original sample count. Its low-pass cutoff is 0.94 divided by the larger of 1 and the pitch ratio
5. Full synthesis padding is retained through the resampler. The exact-length output is then returned

This is original code based on public DSP descriptions, not copied third-party implementation code. Technical references consulted:

- [Laroche and Dolson, 1999, “New Phase-Vocoder Techniques for Pitch-Shifting, Harmonizing and Other Exotic Effects”](https://www.ee.columbia.edu/~dpwe/papers/LaroD99-pvoc.pdf): the conventional time-scale/resample construction and shared peak-region phase coherence
- [Dan Ellis, “A Phase Vocoder in Matlab”](https://www.ee.columbia.edu/~dpwe/LabROSA/matlab/pvoc/): phase consistency during time scaling and the pitch-shift construction. No linked implementation files were copied
- [McLeod and Wyvill, 2005, “A Smarter Way to Find Pitch”](https://quod.lib.umich.edu/i/icmc/bbp2372.2005.107/1/--smarter-way-to-find-pitch?page=root%3Bsize%3D75%3Bview%3Dtext): normalized-square-difference periodicity used only by the independent real-fixture measurement harness

## Reproduce

From the repository root, with the existing installed dependencies and ffmpeg:

```sh
npx vitest run tests/audio/pitch-shift.test.js
node tests/audio/pitch-shift-characterize.js > /tmp/pitch-synthetic.json
node tests/audio/pitch-shift-real-fixture.js > /tmp/pitch-real.json
npm run lint
```

The first command has **40 passing tests**. Characterization scripts print observations; their successful exit means the measurement completed, **not that all release gates passed**. They are intentionally not blanket quality-pass tests. Generated synthetic fixtures, measurements, and rights-verified real-fixture conversion remain reproducible in `tests/audio/pitch-shift*.js`. The scripts store no newly generated audio in the repository and perform no network requests.

### Synthetic evidence

Across all three supported rates:

- A 220 Hz input at ±2 semitones measured about 195.99777 / 246.94172 Hz. Interior frequency error was under 0.001 cent in this fixture; this unusually small stationary-tone error must not be generalized to singing
- Tests also cover -37/+37 cents, +1 cent, +83 cents on several non-bin-centered vocal-band tones, exact duration/rate, original input immutability, and output RMS near the original tone
- A slowly rising 180–270 Hz chirp at ±2 semitones was within 0.94 cent at the nine sampled rate/time combinations per direction. Faster transitions are unvalidated
- A generated harmonic-rich source/filter-like vowel had fundamental error below 0.009 cent and periodicity correlation above 0.9985 at ±2 semitones. It is not a real-vocal corpus
- Identical, antiphase, and half-amplitude linked stereo, quarter-cycle stereo phase, widely separated L220/R440 Hz tones, noise, DC, silence, impulses, hard gates, deterministic output, invalid input, cancellation, and progress were exercised
- A 23 kHz tone at 48 kHz shifted upward two semitones was attenuated about 75.6 dB in the interior rather than strongly aliasing into the output. The deliberately conservative filter also attenuates near-Nyquist material on downward shifts; its 23 kHz example lost about 9.9 dB

### Known failing quality gates

**Transient location and clip edges are not export-safe.** At 48 kHz, an interior isolated impulse shifted -2/+2 semitones had peak offsets of about +2.58/-1.67 ms and energy loss of about 1.47/1.40 dB. Pre-ringing and smearing remain. A final-sample impulse at -2 semitones lost **15.33 dB** of energy in the required exact-length output. These are observed failures, not acceptable tolerances.

This was investigated with an extra 8,192 or 48,000 zero samples on **both** sides, full overlap flush, and an exact crop back to the original duration. For that final-sample -2-semitone impulse:

| Extra padding per side | Full-domain energy loss | Peak moved after event | Energy loss after exact crop |
|---|---:|---:|---:|
| 8,192 samples | 1.47 dB | 2.60 ms | 12.70 dB |
| 48,000 samples | 0.80 dB | 1.54 ms | 20.40 dB |

Thus adding more padding/flush does not solve the failure: transformed transient energy moves outside the clip, and exact-duration cropping removes it. The timing error varies with direction and STFT frame position, so a fixed delay compensation would not solve all cases. No unshifted edge patch, arbitrary gain recovery, waveform wrapping, or favorable-only crop was introduced to hide the failure. A transient-aware design and reliable boundary/context policy are required before export.

**Shared stereo phase locking has an independent-channel pitch tradeoff.** At 44.1 kHz, L220/R240 Hz shifted +2 semitones measured 248.695/268.695 Hz rather than 246.942/269.391 Hz: errors +12.25/-4.48 cents. At 48/96 kHz the corresponding errors were about +10.58/-6.03 cents. Nearby components can share a spectral peak region and retain their frequency separation instead of scaling it perfectly. L220/R230 and L55/R60 probes also show errors. Passing duplicated-mono or widely separated stereo tests does not establish general stereo accuracy.

**No formant preservation.** This moves the spectral envelope with the harmonics. Timbre changes, phasiness, breath/noise coloration, consonant softness, and modulation artifacts are plausible and not perceptually validated. This is constant clip transposition, not note detection/correction, melody editing, vibrato control, automatic retuning, or pitch automation.

## Existing CC0 singing fixture

The real measurement uses the already-retained 20-second mono `cc0-twinkle/first-20s-mono-16k.wav` fixture and its existing [rights/provenance documentation](../../tests/fixtures/lyrics-alignment/cc0-twinkle/README.md). SHA-256 is checked against `provenance.json` before running. Installed ffmpeg 7.1.5 converts it locally to 44.1 and 48 kHz; upsampling does not recreate source bandwidth above 8 kHz. No download, model, audio upload, or new rights claim is involved.

Eight runs cover ±1/±2 semitones at both rates. Each output remains exactly 20 seconds: 882,000 or 960,000 samples per channel. A duplicated, inverted half-level channel exercises linking, **not real recorded stereo**.

The independent harness uses ffmpeg low-pass resampling to 8 kHz for measurement, then a broad 70–700 Hz normalized-square-difference estimate. It samples 164 centers at 120 ms spacing. Both source and output must have confidence ≥0.92 and RMS ≥0.01; no frame is rejected because its measured pitch error is large. The narrower stable subset additionally requires source F0 within 25 cents at ±40 ms. This estimate is not human-annotated pitch gold.

Observed results:

| Rate | Shift | Paired voiced frames / 164 | 95th-percentile absolute pitch-ratio error | Maximum absolute error |
|---|---:|---:|---:|---:|
| 44.1 kHz | -2 st | 103 | 2.82 cents | 4.90 cents |
| 44.1 kHz | -1 st | 104 | 3.50 cents | 5.19 cents |
| 44.1 kHz | +1 st | 103 | 4.01 cents | 6.89 cents |
| 44.1 kHz | +2 st | 102 | 3.49 cents | 8.98 cents |
| 48 kHz | -2 st | 103 | 2.49 cents | 5.66 cents |
| 48 kHz | -1 st | 104 | 3.36 cents | 4.51 cents |
| 48 kHz | +1 st | 103 | 3.66 cents | 7.00 cents |
| 48 kHz | +2 st | 103 | 3.29 cents | 6.89 cents |

All outputs were finite. Linked half-level stereo differed by at most 7.01×10^-46 in four subnormal samples across the eight outputs; the other outputs had exact scalar relationships. At 48 kHz/-1 semitone, output overshoot required shared gain 0.95518, with final sample peak approximately 0.999. Other runs used gain 1. RMS changes ranged from about -0.01 to -0.41 dB, including that attenuation.

Five-millisecond RMS envelopes had their best coarse match at zero lag, cosine similarity 0.9964–0.9977, and normalized RMS error 6.8–9.1%. Median output/input change ratios at strong positive input-envelope rises were only 0.36–0.48; some corresponding output bins were already falling. This indicates materially changed short-time envelope shape and is not proof of preserved attacks. There are no manually annotated transient times or listening judgments. One singer, one English recording, and one source bandwidth do not establish generality or professional quality.

## Work/memory and integration gate

A 30-second, 96 kHz, two-channel synthetic request at +2 semitones completed in about **2.82 seconds of Node compute** on this executor, returning exactly 2,880,000 samples/channel. This excludes default scheduling delays and is not a browser/mobile speed guarantee. One run observed ~75 MB additional live typed-array storage and about 171 MB total process peak RSS; garbage collection and earlier runs affect process totals. The largest per-call audio arrays are approximately 52 MB stretched stereo + 23 MB output, in addition to about 23 MB caller-owned input and small FFT/filter workspaces. The duration/channel/rate/shift limits cap their sizes.

**A dedicated worker with cancellation/stale-result handling is mandatory before any control is enabled.** Cooperative yields are a responsiveness fallback, not permission to run multi-second processing on the UI thread. This module itself uses no DOM, AudioContext, server, or model API, but actual browser module loading, transferable buffers, worker cancellation, and preview/export application remain untested. Local Chromium launch was blocked by the executor's socket restriction; no alternate launch route was used.

Release prerequisites remain open:

1. Resolve transient movement and exact-clip edge loss without disguising unshifted output or changing duration
2. Resolve or explicitly restrict independent close-frequency stereo behavior
3. Add a worker wrapper, bounded-copy/source-version ownership, cancellation, and stale-result protection
4. Verify worker and audio playback/export in real Chromium/Firefox/Safari where supported; verify latency and memory on modest devices
5. Conduct authorized listening comparisons on diverse vocals, fast glides, consonants, breaths, harmony, and real stereo; retain failure examples
6. Keep UI/product language limited to evidence actually established. Do not describe this prototype as professional vocal correction

Next engineering options require no new package/model: prototype transient-aware phase resets with time anchors and measure every boundary; compare a bounded waveform-similarity time-scale implementation on the same fixtures; investigate per-channel peaks linked only where spectral coherence supports it. Each option must beat the retained failure probes, not merely stationary tones. Any context-padding design must demonstrate safe exact-duration cropping rather than assume padding solves it.

The source header and exported readiness metadata mark this internal-only. A unit gate scans application source imports and fails if the experimental shift module is imported by shipping source. No project/render/UI integration, dependency change, commit, push, or deployment was performed by this DSP task.
