# Audio foundation audit and scoped repairs — 2026-10-05

Later local integration adds the manual-lyrics slice plus preview/worklet recovery fixes. The baseline findings below remain historical evidence; current scope is recorded in [lyrics integration validation](validation/LYRICS_INTEGRATION_VALIDATION_2026-10-05.md).

Baseline: `main` commit `3c838187e45635efbaffc4a83a3d38b4c867bdf9` in
[yung13yubabie/waveforge](https://github.com/yung13yubabie/waveforge).
This is a code audit and local foundation repair, not a claim of a finished DAW,
trained singing model, deployed release, or musical-quality certification.

## What the source really implements

- Mastering controls call real setters and use a shared live/offline processing graph
- HP/LP, ten-band EQ, Dynamic EQ, M/S, de-esser, multiband compression, saturation, limiter and master output are real processors
- The four fixed stems have EQ/compression/pan/volume/mute/solo, synchronized playback from zero, and an actual offline Bounce
- Demucs has a real upload→Gradio job→SSE→download path and a CPU `htdemucs` worker implementation; deployment configuration is separate from runtime availability
- Final preview, single master and album track renders share `renderFinalMaster`; WAV16/24, MP3 and CD WAV+CUE+MD5 packages are implemented
- Master presets and their Undo/Redo contain static DSP state only

There is no Project/Track/Clip timeline, recording, MIDI, automation lane, note/F0
editor, independent pitch/time processor, take/comp system, AI timbre conversion,
or lyric-resinging implementation. A four-stem panel is not a full DAW. Replacing
one already-aligned vocal manually currently requires reimporting a complete four-file
set and resets stem controls. The vocal-drift manifest has no licensed musical corpus.

## Reproduced defects and this patch

### 1. Key detector advertised 30 seconds but inspected only the opening

`audio/analyze.js` copied 30 seconds then stopped after eight early 4096-sample
windows. Coverage ended at 2.694/2.475/1.237 seconds for 44.1/48/96 kHz.
A synthetic three-second silence followed by 27 seconds C major returned no key at
all three rates. The corrected bounded detector spreads its eight windows across
the stated range and scales its analysis-window size with source rate. The fixture
now returns C major at all three rates. Every return path reports the time span, window count, individual window duration
and total sampled time. UI describes this as sampling, not complete
note-level analysis; the score is not presented as a guaranteed correctness rate.

Remaining: representative real-song evaluation, modulation, key candidates, analysis
range selection and user-confirmed musical targets before any automatic correction.

### 2. True-peak tail loss and unsupported ceiling guarantee

Both peak meter and limiter detector failed to flush the interpolation FIR at EOF.
A final sample of 0.999 was reported as about −60.139 dBTP with no warning, although
its sample peak was −0.00869 dBFS. A −1 dB limiter left that sample unchanged.
An fs/4, 45-degree sine at amplitude 1.4 measured about −0.718 dBTP after the same
−1 dB limiter. The prior envelope-only argument did not bound the reconstructed
waveform after a time-varying gain was applied.

The patch shares a finite-buffer four-times oversampling estimator, flushes its tail,
includes the sample-peak lower bound, places the detector envelope back on source
sample coordinates, remeasures the limited result and applies linked attenuation
when necessary. Requested limiting fails closed if final PCM exceeds the estimator's
ceiling. Verification metadata explicitly says `pre-encode-float-pcm`: WAV quantization/dither
and MP3 encoding happen afterward and are not covered by that check. Non-finite samples and mismatched channels are rejected. Quiet audio is not
boosted. Source buffers, channel relationships and sample counts are preserved.

The terminal fixture now measures −0.00869 dBTP before limiting and about −1.0000003
after limiting. Tested ISP vectors now measure about −1.000009 dBTP. These numbers
are **same-estimator PCM invariants**, not independent ITU/EBU certification. The UI
and README no longer promise a universal true-peak or MP3-output guarantee.

Remaining: independent calibrated reference vectors, higher-quality estimator review,
post-encoding WAV/MP3 QC, real-device verification and long-file performance testing.

### 3. Reference matching and album source LUFS used the monitor's rate

Native WAV decoding retains 44.1/96 kHz, but Reference Match interpreted that PCM
as 48 kHz. An identical multitone at 96 kHz and 48 kHz could receive false EQ changes
near −10 dB and +12 dB. Both source and reference now use their own buffer rate for
spectrum and LUFS calculations; album source measurement does likewise. Reference
Match now records its applied EQ edit in history. Cross-rate synthetic comparisons
allow 0.5 dB for different finite FFT bins, not the old large frequency shift.

### 4. Streaming timeout and file-retention disclosure

The integrated retention patch keeps deadlines alive while consuming upload JSON,
SSE and downloaded audio bodies. Tests cover native Response streams, caller abort,
error/complete cleanup and stalled readers. This is request cancellation/cleanup;
it does not add a user-visible cancel button or a server delete API.

See [file-retention audit](FILE_RETENTION_AUDIT_2026-10-05.md) and
[privacy/source lifetime](SESSION_PRIVACY_AND_STUDIO.md). Clearing mastering does
not delete the separate works-library metadata or already downloaded files. Closing
a browser is not a verified cloud-deletion event.

### 5. Misleading or unsupported UI claims

Vinyl is a duration advisory panel, not RIAA processing. The label now says so.
Its duration warning no longer predicts inevitable distortion. IRC remains disabled
and marked unavailable, rather than implying that any backend would supply a
proprietary algorithm. No new placeholder repair/AI controls were added.

## Important remaining findings, not claimed fixed

- Offline render length equals source duration despite compressor/limiter delay; delayed endings/filter tails need allocation and compensated timing
- Pre-enabled Dynamic EQ/De-esser plus a failed worklet load can leave export blocked while the bypass checkbox is disabled; a visible recovery path is needed
- Album alignment displays an estimate derived from measured loudness plus suggested trim; pre-limiter trim is nonlinear and needs re-rendered measurement
- Snapshots omit trim/export settings, watermarks, sample rate/bit depth and active loudness target; presets are not reproducible saved projects
- Final preview uses separate media elements, lacks one-clock/gain-matched A/B and needs explicit stale-preview handling
- Stem import/album edits have no durable project store or complete Undo/Redo; a beforeunload warning is not autosave
- Browser-native sample-rate conversion, saturation latency, long sessions and cross-browser audio quality remain uncalibrated
- Existing parity tests compare two shared-builder offline renders, useful for wiring but not independent algorithm correctness or physical live monitoring
- HF Python tests mock Gradio/model inference and copy a fixture to four stems; they test service boundaries and temp cleanup, not separation quality or cache-expiry execution

## Retained reproducible evidence

- `tests/fixtures/audio-trust/signals.js`: deterministic original synthetic inputs
- `scripts/test-audio-trust.mjs`: dependency-free production-DSP checks
- `tests/audio/audio-trust-regressions.test.js`: coverage, EOF, ISP, invalid data and native-rate regressions
- `tests/audio/final-render-safety.test.js`: real final-chain guard with a deliberately regressed limiter
- `tests/ui/album-source-rate.test.js`: the actual album-add handler with three source rates
- `tests/e2e/audio-trust-foundation.spec.js`: UI analysis/reference/album and preview/download PCM parity cases
- `docs/validation/audio-trust-synthetic-results.json`: direct runner output

All generated inputs are synthetic. No user audio or private voice model was uploaded,
trained, committed or sent to an external AI service. New browser cases remain
unverified until run in a permitted browser environment; see the validation record.
