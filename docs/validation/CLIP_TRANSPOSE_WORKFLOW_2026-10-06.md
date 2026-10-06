# Constant clip-transpose workflow candidate

Date: 2026-10-06. Candidate awaiting browser verification; not deployed. Actual browser execution and perceptual listening are still pending at this checkpoint.

## Integration basis

- Compact/focus base: `02dbb1a5ae197db39638a6275b7a2fa957d459d0`
- Reviewed atomic replacement UI/core: `2debf63b85a6333bea0840020d4a01351a287801`
- Audited official Signalsmith Stretch 1.3.2 and Float32 storage: `1b0356bd522d7dde2d78fe725a2b2d1ec04696a4`
- The work uses the already vendored, hash-verified component. No dependencies, model, remote service or audio upload was added

## User workflow

Select an existing clip, expand **片段移調（試用）**, set a constant pitch amount, and explicitly choose **產生試聽**. Semitones plus cents must total within ±2 semitones. Source-native covered frames must fit 30 seconds; a fractional boundary can add a frame and therefore requires slightly less than a nominal 30 seconds. Nonzero processing needs at least 120 ms. Mono/stereo at 44.1, 48 and 96 kHz are preserved.

Independent ±2-semitone formant control and approximate compensation live in the optional **音色調整** disclosure. These call separate Signalsmith API settings; they are not labels on the pitch control. Quality/edge/stereo limitations, local processing and retained-source privacy are in expandable help. The UI does not claim automatic note snapping, precise natural vocal correction or listening validation.

The same contextual review used by replacement recordings is moved into the active disclosure: A original mix, B processed mix, Accept and Cancel. It does not create a second replacement state machine or global/orphan controls. Review dismissal returns keyboard focus to the control that created it, or its disclosure summary while busy. Existing mobile scroll and compact layout rules remain intact; actual layout verification awaits the browser tests.

## Audio and persistence contract

`src/js/daw/transpose.js` plans and reserves the job before allocating owned audio. It takes `[floor(offset × rate), ceil((offset + duration) × rate))` and retains `offset − first/rate` for the new clip source. Existing clip ID, timeline placement, exact duration, gain, fade envelope, volume automation, track routing and mix settings stay unchanged.

The client copies source views before worker transfer. One worker produces one result, copied once into a genuine native AudioBuffer. The Float32 WAV serializer reads that very native candidate. A staged project and file/buffer maps register it, then atomic `clip.replaceSource` changes source ID and fractional source offset, attaching the bounded lineage record described below. A/B, accepted playback, WAV export and ZIP restore use the ordinary DAW render route. No additional DSP runs on Accept, Undo, Redo or ZIP save.

Accept pushes one history snapshot and atomically swaps the project/maps. The original source/file remains retained. Undo/Redo recover original/generated audio without running DSP again. Ordinary Save/Export before Accept still uses the accepted original project, even after a B audition. Failure leaves the accepted project saveable and playable.

The optional `clip.transpose` record is version 1 and has a fixed engine identity, original asset ID and original interval, exact floor/ceil crop frames, and pitch/formant settings. Unknown versions, engines or fields, missing/generated original identities, inconsistent rate/channel/frame metadata, invalid ranges and expanded intervals reject transactionally. The project schema remains backward-compatible with projects lacking this optional record; older clients that do not understand it reject unknown fields instead of silently dropping the recovery link.

ZIP restores the accepted baked audio, original link and editable settings. Selecting that clip prefills controls and exposes **回到原音**, which restores its original source/offset in one Undo-able command while keeping current timing, fades and automation. Re-render always starts from the retained original, not the already shifted PCM. Trim/split preserve the mapping back into the captured original interval. A different replacement recording deliberately clears the former recipe. The model intentionally forbids generated-to-generated lineage chains.

Prior Undo history remains nonpersistent, but direct original recovery and parameter-based re-render work after a fresh restore. Retained full original media can contain cropped/unused sound; the existing ZIP warning and help disclose it.

Finite samples above unity are retained exactly, with no normalization or clipping. The review reports source overload. Actual preview and delivery WAV check the existing mixed sample/estimated-true-peak thresholds; unsafe playback/export stop and ask for an explicit mix-gain change. Accept itself can preserve hot source PCM, so lowering mix gain afterward does not destroy its headroom.

## Lifecycle and conservative memory ownership

- A project object/revision, source asset, selected track/clip, selection generation, control generation and raw visible-settings key own each job
- Cancel, pending settings input/change, source edits, selection, track/project edits, Undo/Redo, clear/open, workspace navigation and teardown invalidate ownership; late worker/serialization/hash results cannot register or accept assets
- Worker timeout/crash/invalid response use the existing one-shot client lifecycle. There is no nonzero main-thread DSP fallback
- Reservations include the full borrowed original source (which could outlive Clear), worker input/output, native candidate, serialized WAV, Blob and crypto input copy, plus 16 MiB native/allocator/metadata slack; ordinary retained files/history and A/B caches are included in the panel total separately
- An uncancellable hash keeps its reservation and blocks another transpose until actual settlement. Other operations see the same `pendingReplacementBytes` ledger
- A detached pending audition retains a budget for its captured maps until the permission/resume/render chain settles. It cannot spawn another audition chain in the meantime
- The shared renderer exposes native-held source/output bytes until both native settlement and its JS scan/cleanup finish. Cancellation/timeout cannot hide ongoing offline-render memory from a subsequent import/render budget
- No candidate Object URLs are created. Existing source nodes are stopped/disconnected, job observers are removed by the worker client, and the client is disposed on panel teardown

Ordinary import/ZIP-load cancellation hardening from `23488a3d649524e37bf20cd262da97e1eeac3cc8` is integrated in `65cf0d3`. Imported replacement takes now use the same load reservation and native-settlement tracker (`c71d061`); cancelling a pending replacement cannot unlock another read/decode. Its pending-load reservation is additive with generated jobs, detached auditions and native renders. The generated worker path keeps its own bounded reservation because it does not use native file decoding.

## Validation

Prepared tests:

- `tests/audio/daw-transpose.test.js`: real core execution, allocation planning, fractional crop bounds, supported-rate/channel Float32 bit identity, source immutability, independent formants, ownership after worker/serializer/hash boundaries
- `tests/audio/daw-transpose-lineage.test.js`: strict bounded metadata, original recovery through trim/split, old-project compatibility, exact Float32 ZIP round-trip, fresh history, malformed/unknown lineage rejection before audio decode
- `tests/ui/daw-transpose.test.js`: mocked audio boundary clearly scoped to transaction/UI wiring, same native object through audition/accept, retained files, Undo/Redo, fractional geometry, unsafe output, timeout/retry, cancelled hash, interrupted render and shared resource refusal
- `tests/audio/daw-render.test.js`: native-job byte ledger persists through Cancel/timeout until actual settlement
- `tests/e2e/daw-transpose.spec.js`: 19 genuine-worker/native-browser cases, enabled in the production test configuration as well as the development suite. The six rate/channel combinations cover complete PCM/file hashes, B/accepted mix export equality, same native candidate identity, original file retention, Undo/Redo, ZIP native restore, fresh-page original recovery, prefilled controls and worker-input identity proving no pitch stacking, formants, bounds, repeated cancellation/navigation/settings/selection and 1440/390 px keyboard/touch reachability

Only synthetic fixtures and the existing hash-verified CC0 Twinkle fixture were used. The existing real-fixture characterization script was rerun successfully: all eight stored audio measurements matched the earlier evidence exactly (only timestamps and elapsed runtime changed). Vendor hashes, the worker bundle check and independent ffmpeg Float32 WAV verification also passed again. Its known DSP limitations remain; no human listening result is inferred from it.

Final code checkpoint `c71d061` passes **1,300 tests, 1 existing opt-in skip**, across 70 files with two local workers. Syntax checks pass for 200 JavaScript files; the production build passes with its existing large-chunk warning. Independent source/resource review reran **242 focused tests** against that exact commit and found no additional blocker in shared imported-replacement ownership or generated staging. `git diff --check` also passes.

Browser tests were syntax-checked and discovered with Playwright `--list` only. No browser was launched. No browser, audible playback, mobile layout or naturalness pass is claimed.

Reproduction:

```sh
npm test -- --maxWorkers=2
npm run lint
npm run build
node scripts/verify-signalsmith-vendor.mjs
node scripts/signalsmith-real-fixture.mjs
node_modules/.bin/playwright test -c playwright.production.config.js tests/e2e/daw-transpose.spec.js tests/e2e/daw-replacement.spec.js --list
# Run only in an authorized browser/CI environment:
npm run test:e2e -- tests/e2e/daw-transpose.spec.js tests/e2e/signalsmith-worker.spec.js tests/e2e/signalsmith-asset-acceptance.spec.js --workers=1
```

A first full-suite run under unrestricted concurrent local workers timed out one preexisting replacement ZIP test at 5 seconds while fixture characterization also ran; no failed sample assertion was reported. The isolated two-worker full suite passed 1,286 tests (1 skipped) at the lineage feature checkpoint and 1,299 tests (1 skipped) after import/ZIP resource integration. The final shared replacement-native checkpoint passes 1,300 tests (1 skipped); the first timed-out run is not treated as a pass.

## Reviewed sample-boundary correction

Independent workflow review found that raw `ceil((frames / rate) * rate)` can add an unintended frame. Exact full-source examples were 5,518 and 44,107 frames at 44.1 kHz, 6,007 and 48,003 frames at 48 kHz, and 12,001 and 96,006 frames at 96 kHz. A valid late-timeline trim from 500.3 to 500.4 seconds produced a larger arithmetic error than a tolerance based only on its small source offset would cover.

`sample-bounds.js` is now the single covering-frame conversion for crop planning, persisted lineage validation and original-source recovery. It canonicalizes coordinates only within the arithmetic bound of the supported 600-second timeline: `4 × Number.EPSILON × 600` seconds (less than 0.000000052 sample at 96 kHz). Meaningful fractional boundaries keep floor/ceil and their exact residual seconds; explicit ±0.000001-sample tests remain fractional at short and long positions. A canonical integer start has zero generated residual, preventing `.35 - .25` from turning into a negative replacement offset. The exact captured original seconds remain in lineage and are restored unchanged.

The two strict duration upper-bound checks use that same numerical allowance, so `32.2 - 2.2 = 30.000000000000004` does not create a planner/lineage disagreement. The canonical crop-frame limit stays at exactly 30 × sampleRate; true excess duration or fractional coverage beyond that bound still rejects. No stored timeline duration, original offset, gain or envelope is rewritten.

Regressions cover all 5,643,000 integer frame lengths from one sample through 30 seconds at 44.1/48/96 kHz, broader integer-offset crops, all six reported full-source examples, genuine fractional starts on both sides of boundaries, late-timeline trim/split, near-zero residuals, exact 30-second acceptance and full Float32 ZIP/original-recovery round trips. This correction does not change DSP, add browser execution, or establish listening quality.

Correction validation: the full two-worker suite passes **1,337 tests, 1 existing skip**, across 71 files; syntax checks pass for 202 JavaScript files, production build and diff checks pass. The independent workflow reviewer passed **210 focused tests** and an additional seeded 600 real-command trim/split/recovery/re-render cases across the three source rates and timeline positions up to 598 seconds, observing exact original-offset recovery. Browser/audio-device/layout/listening validation remains pending.

## Integrated candidate and release gates

The lead integration includes the current compact UI, lyric-resampling ownership and ordinary-import/ZIP/native-render reservations. Its code checkpoint `7bbce0a` passes **1,357 unit tests, 1 explicit skip**, syntax checks for 203 JavaScript files, the production build, fixed vendor/WASM hashes, isolated worker bundling and independent ffmpeg Float32 round-trip checks. These are local results, not browser or listening results.

The shipping decision remains blocked until the new source and built-site browser suites verify genuine Worker/WASM loading; cancellation and stale-source isolation; actual original/processed audition; unchanged duration/rate/channel data; safe refusal of overloaded mixes; one-result acceptance; Undo/Redo; WAV/ZIP round-trip; and fresh-session original recovery/re-render. New UI tests are enabled in both development and built-site configurations. No assertion is removed because a browser differs.

The advertised scope is constant short-clip transposition **for audition**, not note snapping or professional correction. The hard supported API limits are 120 ms–30 s for nonzero processing, mono/stereo, 44.1/48/96 kHz, and combined pitch within ±2 semitones. Zero-setting bypass remains exact. Separate formant shift/compensation is approximate, and the UI says the timbre can still change. Unsafe pending audio has a Cancel → lower gain → regenerate path; adopting it is not required to audition safely.

Functional DSP gates include finite/owned output, unchanged exact frame count/rate, source immutability, genuine frequency change rather than playback-rate change, no fabricated silence-channel content, no clipping/normalization, and bounded/cancellable processing. The existing 220 Hz semantic frequency check uses a coarse 2% relative bound; it must not be represented as a precision-tuning guarantee.

Quality observations are retained rather than relabelled as passes: default mono-grid error reaches 21.90 cents, close-frequency stereo reaches 26.96 cents; the one CC0 singing fixture has p95 paired-voiced error up to 6.60 cents (maximum 18.76). The 210-case impulse matrix reaches −3.446 dB retained edge energy and one-sample peak movement. These diagnostics include expected spectral/crop tradeoffs and are not a perceptual severity certification. Consonants, attacks, glides, stereo detail and formants may change. Source preservation and explicit A/B/Cancel/original recovery mitigate an audition workflow; they do not establish naturalness. Representative listening and broader material remain unverified, and any newly observed severe artifact in the advertised scope blocks release or requires an actual restriction.
