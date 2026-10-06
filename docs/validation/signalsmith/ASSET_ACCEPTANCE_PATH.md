# Non-destructive audition → accepted native asset → ZIP

> Integration update: a local constant clip-transpose workflow now implements this path; see [workflow candidate](../CLIP_TRANSPOSE_WORKFLOW_2026-10-06.md). The statements below describe the earlier engine-only checkpoint. Actual browser execution and listening remain pending.

Date: 2026-10-06. This is an integration design and retained engine harness. Shipping UI and DAW files remain unchanged. No browser was launched; native-browser results below are still pending.

## Verified follow-up findings

- The invalid-AbortSignal cleanup finding is fixed in `signalsmith-render.js` input validation and `signalsmith-client.js` guarded listener setup/cleanup. `tests/audio/signalsmith-client.test.js` retains the malformed signal, accidental AbortController, throwing attachment/cleanup and active-job-preservation regression. It was rerun successfully on this follow-up
- `synthetic.json` retains all **210** rate/duration/endpoint cases. The main README distinguishes completed tail draining and exact duration from intrinsic spectral/phase/crop tradeoffs. Worst −3.446 dB and one-sample peak movement remain visible; no claim that transposition should preserve arbitrary broadband impulse energy perfectly
- Existing `registerAudioBuffer()` can adopt a real native `AudioBuffer` without copying or altering its samples. Existing asset metadata already supports frame count, rate, channels, source rate, hash and a decode-backend label
- Existing `ProjectHistory` stores metadata snapshots, while file/buffer maps retain all IDs referenced by history. One accepted candidate can therefore be one Undo entry without rerunning DSP
- Existing ZIP requires a Blob and SHA-256 for every saved asset. The former 16/24-bit delivery encoder cannot be used as lossless generated-source storage: it quantizes and clips samples outside ±1

## New, isolated generated-file utility

File: `src/js/audio/generated-float-wav.js`

```js
const bytes = await encodeGeneratedFloatWav(channels, sampleRate, {
  signal, onProgress, yieldControl,
})
```

`bytes` is an owned standard RIFF/WAVE ArrayBuffer: format tag 3 (`WAVE_FORMAT_IEEE_FLOAT`), 32 bits, little-endian interleaved channel frames, an 18-byte WAVEFORMATEX `fmt ` chunk with zero extension bytes, a `fact` sample-count chunk and a `data` chunk. Header size is 58 bytes. The format fields follow [Microsoft's WAVEFORMATEX definition](https://learn.microsoft.com/en-us/windows/win32/api/mmreg/ns-mmreg-waveformatex).

Bounds: one/two equal-length Float32 channels; 44.1/48/96 kHz; at least one frame, at most 30 seconds; at most **23,040,058 encoded bytes**. Shared buffers and nonfinite samples reject. Work yields every 16,384 frames; cancellation returns no partial bytes. Source arrays remain caller-owned and must stay immutable until settlement.

Progress observers cannot invalidate completed bytes by throwing. Cancellation checks occur before/after each nonterminal yield; completion is sealed before progress 1. An abort requested from the terminal observer is too late to cancel serialization, so staging code must still recheck source/job ownership before adoption.

Serialization preserves finite Float32 values exactly, including signed zero, subnormal values and headroom above unity. It applies no dither, normalization, clipping or sample-rate conversion. It is **not imported by the existing WAV delivery/export path**. This does not authorize playing high-level headroom without the existing preview/export peak checks.

Verified:

- Fourteen new tests check independent RIFF parsing, exact Float32 bit round-trip for both channel counts at all supported rates, nonfinite rejection, resource/cancel behavior, sparse-input rejection before allocation, maximum-size output, terminal-progress semantics and existing asset/hash/history/ZIP validation
- The Node ZIP test uses an independent fixture decoder and does not claim native Web Audio validation
- Installed ffmpeg/ffprobe recognise all three rates as `pcm_f32le`, two channels, six frames in the diagnostic fixture, and return exactly identical interleaved float bytes including signed zero/subnormals/headroom
- Reproduce the independent tool check with `node scripts/verify-generated-float-wav.mjs`; saved results are `float-wav-ffmpeg.json`
- Full local suite after this addition: **1,168 passed, 1 skipped**, 66 files; lint checks 192 JavaScript files; build passes

## Narrow production API path to implement after browser acceptance

1. **Capture owner and resource reservation.** Capture project object/revision, selected track/clip, source asset ID, selection generation and control settings. Reserve engine input copy, generated PCM, native buffer, generated file, hash read, retained original/history sources and any old/new full-mix caches against existing limits. A second selection must replace/cancel work, not accumulate a queue
2. **Crop on source-native frames.** Let `first = floor(offsetSeconds * sourceRate)` and `last = ceil((offsetSeconds + durationSeconds) * sourceRate)`. Copy `[first,last)` and keep `replacementOffset = offsetSeconds - first/sourceRate`. The new asset covers the selected interval without changing its exact seconds or rounding away a fractional sample. Bounds apply to the actual cropped frames, including the at-most-two-frame coverage expansion; reject an over-limit request explicitly
3. **Render once.** Pass the bounded source-native channels to `createSignalsmithPitchClient().render()` with the complete source/settings token. Recheck ownership after every asynchronous boundary. Do not recompute on Accept, export or ZIP save
4. **Create the native candidate once.** Use `new AudioBuffer({ numberOfChannels, length, sampleRate })` (or a context's `createBuffer()` with the explicit native rate) and `copyToChannel()` from the returned PCM. Keep exactly this candidate object for audition and accepted source registration. No plain-object fake may be passed to an actual `AudioBufferSourceNode`
5. **Create the retained file from that same PCM.** Serialize Float32 WAV, wrap as local `File`/`Blob`, compute SHA-256, and call `registerAudioBuffer()` against staged copies of the buffer/file maps. Use metadata such as `decodeBackend: 'generated-float32-wav'` and `sourceSampleRate: result.sampleRate`. The hash belongs to the generated file, not the original source file
6. **Build a staged project.** Reuse the alternate-recording task's `clip.replaceSource` command once integrated: change only asset ID and the calculated fractional source offset. Preserve clip ID/name, timeline placement/duration, gain, fades, cropped fade envelope and volume automation. The command is now available in locally verified integration commit `2debf63`, but this isolated Signalsmith base `0c22461` does not yet have it. Do not substitute a generic remove/re-add implementation for ordered multi-clip editing
7. **Audition using the actual candidate.** A/B should use the accepted-original and staged-candidate projects through the same `renderProject()` path if context/mix audition is promised. Cache candidate full-mix PCM separately from the accepted-project cache. The existing `createPitchSourcePreview()` helper is labelled original-only and returns `processed:false`; do not reuse that response to mislabel processed audition
8. **Accept atomically.** Recheck source/settings token and memory, then push the complete staged metadata once and swap project/buffer/file maps together. Invalidate ordinary mix playback/cache. The accepted source is the native candidate already auditioned. Preserve the original source and both IDs required by Undo/Redo
9. **Save/restore ordinary ZIP.** Existing archive schema can carry the generated file unchanged; no new archive fields are required for basic accepted audio. On restore, native decode must return the saved rate/channels/frame count and identical PCM in the supported engine. Preserve both original and generated files; disclose that sharing ZIP includes full retained sources. ZIP stores current project/media, **not Undo history**; reopening starts a fresh history
10. **Delivery export stays separate.** Existing project rendering and peak protection remain in force. User-selected 16/24-bit delivery WAV is intentionally quantized; that must not be confused with lossless generated-source storage or MP3 identity

### Ownership and interruption acceptance

Cancel, another selected clip, source change, any relevant setting edit, Undo/Redo, project open/clear, navigation and teardown must stop audition, invalidate the staged token and prevent late render/hash/serialization/native-decode completion from committing. Register only into staged maps before Accept. Keep reservations for asynchronous work that cannot truly be stopped until it settles. A malformed signal must reject before changing the active job or starting its timer.

Accepted project changes should be one history snapshot. Failed staging, cancellation, codec rejection, stale owner, invalid duration, memory pressure and peak-safety refusal leave the original project playable and saveable. Repeated Accept must not create multiple assets or history entries.

## Browser rate caveat

The Web Audio decode algorithm resamples decoded audio to the **decoding context's** rate if they differ; audio-device and project/render rates are separate from native source rate. See the [Web Audio Recommendation, decodeAudioData](https://www.w3.org/TR/2021/REC-webaudio-20210617/#dom-baseaudiocontext-decodeaudiodata).

The existing `decodeSourceAsset()` examines RIFF `fmt ` and creates a native-rate OfflineAudioContext when the provided monitor context differs. `decodeDawAsset()`/ZIP restore reuse that route. The generated 18-byte `fmt ` plus `fact` layout is compatible with the existing chunk-based `wavSampleRate()` reader; it does not assume a fixed data offset.

This is a source-path compatibility finding, not proof that every browser preserves every Float32 bit. Actual native decoding of float WAV must still be tested. A different-rate `AudioContext.decodeAudioData()` call outside this native-rate route would intentionally resample, breaking source PCM parity. Playback and `renderProject()` may also resample a native source to the device/project rate without changing the retained native asset. Same-rate stored-source identity and rendered-mix parity therefore need separate assertions. Do not silently fall back to integer encoding, change the requested rate, or weaken exact storage assertions if a browser fails the test.

## Prepared real-browser harness

`tests/e2e/signalsmith-asset-acceptance.spec.js` contains two tests, discovered but **not executed**:

- All supported rates: real module worker result → real native AudioBuffer → native offline audition → staged asset + Float32 file/hash → one Undo/Redo acceptance → ordinary ZIP export/import using the unmocked native browser decoder → exact source PCM/file hash and mixed-output parity
- All supported rates: ordinary native decoder of generated float WAV with signed zero, subnormal values, above-unity finite samples, distinct left/right data and an intentionally different monitor context

The single-clip test fixture constructs a staged replacement with existing remove/add commands only to exercise today's base. It is explicitly not a production replacement-command implementation; shipping integration depends on the atomic `clip.replaceSource` command described above. The harness includes a half-frame source offset at 44.1 kHz and checks the fractional offset preservation. These prepared native fixtures currently cover stereo; add mono native-decode cases before claiming the full browser channel matrix (the Node serializer matrix already covers mono and stereo).

```sh
npm run test:e2e -- tests/e2e/signalsmith-worker.spec.js tests/e2e/signalsmith-asset-acceptance.spec.js --workers=1
```

Local Chromium/socket execution remains restricted; no alternate browser launch or environment bypass was attempted. This work added no shipping UI, external model/dependency download, remote write, push or deployment.

## Remaining functional blockers before shipping integration

1. Actual native-browser float-WAV decoding, worker/native buffer creation and ZIP round-trip are still unexecuted. Node and ffmpeg results cannot substitute for them
2. The atomic replacement command and staging ownership from the alternate-recording task must be integrated, or an equivalently reviewed transaction API supplied
3. The panel needs an explicit accepted-generated-file path and cancellation/resource ownership connecting the APIs above; currently no user control invokes this work
4. Existing strict project schema does not store a pitch/formant recipe or source lineage. Basic baked audio works without new fields, but a reopenable “edit this pitch again” control needs a separately designed/versioned metadata extension; do not promise nondestructive parameter editing merely because original audio is retained
5. Listening and real vocal/transient tradeoffs remain pending as documented in the main README
