# Manual lyrics integration: actual scope and checks

## Inputs and preservation

- Foundation: local commit `d17a8fc4d8c83d0da96613d66ba1c16b8cb50ff3`, based on remote `3c838187e45635efbaffc4a83a3d38b4c867bdf9`
- Additional delivery: `WaveForge_Update_2026-10-05.zip`, whose manifest names local implementation commit `3846c0495a07347e856e2c99648a2c5585d94600` and the same remote baseline
- Its archive has 23 changed files, seven overlapping our foundation. The original archive and both source snapshots remain unchanged
- Integration was built on a separate local branch. After authorized publication, the exact tested tree was uploaded to `fix/audio-trust-foundation` and [PR #1](https://github.com/yung13yubabie/waveforge/pull/1), initially as a draft. Main and the deployed site were unchanged at that initial publication

The incoming archive contains source and a patch, but no raw browser test report supporting its stated 471/52/25 result counts. Those counts are not treated as validation of this integration. Its old audio-analysis, peak and HF-client files were not copied over our verified foundation. Its reconstructed planning registry and stale build assets were not adopted.

## Real UI → operation → save/export paths

- `index.html` adds an actual lyrics tab; `src/js/lyrics/panel.js` binds apply, timing, confirmation, playback, save/open/recover, undo/redo and four export commands
- `lyrics/session.js` keeps exact source text, stable line order, time fields, confirmation and source identity in a validated versioned JSON format
- `AudioEngine.playRange` uses the audio clock and source-loop boundaries. Sentence and full-song looping have separate settings; ending a sentence retains its end position
- `lyrics/export.js` produces actual LRC/SRT/ASS/TXT text downloads. TXT preserves raw text; timed formats require valid, confirmed boundaries. LRC rejects overlap and control characters; SRT/ASS allow overlap only when requested
- The master loader locks lyric timing while replacing audio, then accepts the new identity or reconnects a restored source. It does not apply old timings to a different file
- Existing final preview is invalidated when its processing/output recipe changes, and unavailable effects have an explicit bypass recovery path

This is manual sentence-level alignment. There is no automatic alignment model, second-pass recognition, word-level karaoke, voice conversion, full DAW project or 100% accuracy guarantee.

## Reproduced before fixing

The integration review added failing regressions before applying repairs:

1. A stale hash failure could disconnect a newer accepted file
2. A pending backup could save the replacement's empty timing instead of the edited source
3. A restored project was not always backed up
4. Clear/pagehide could miss the latest edit, and BFCache return stopped the clock display
5. Rebuilding lyric rows lost focus between consecutive Alt+[ and Alt+] actions
6. LRC accepted overlaps it could not preserve and emitted invalid control characters
7. An untouched startup/invalid offset followed by a new file could overwrite an unopened prior backup
8. Sentence looping changed the full-song loop setting; a one-shot range reset position to zero at completion

Backup failure now keeps previous timing in the in-page undo history and reports the failure. Invalid edits are validated before changing revision/backup ownership. Pure source binding does not count as a lyric edit. Imported-project changes can be undone within the current page.

## Current verification

- Integrated unit suite: 47 files / 580 tests PASS
- Syntax check: 127 JavaScript files PASS
- Production build: PASS; >500 kB bundle warning remains visible
- Proposed capability structure: 136 IDs / 862 detail groups PASS; this checks documentation structure, not completion of 136 features
- Mocked HF Python boundary suite: 4 tests PASS
- Independent lyrics-focused review: source and JSDOM regressions checked; it did not rerun the browser suite
- FFmpeg 7.1.5 independently parses the new SRT/ASS synthetic fixtures. Four start/duration pairs match expected values; ASS→SRT preserves Chinese, English, Japanese and Arabic text. Reports are under `docs/validation/lyrics/`

The original source archive's browser results are not inherited. This local environment blocked Chromium launch and local cloud-browser access; no security flags, alternate host or service were used to bypass that restriction. After the authorized PR publication, GitHub-hosted CI independently ran the integrated browser suites successfully.

### GitHub-hosted browser verification

- Source HEAD: `d049ce1218885eb035c0f0f71dad8dce974f3e39`; tree `b21c293a4dffabca9d88c0da695065fdab3a860f`, identical to the locally tested integration
- [Run 37318408329](https://github.com/yung13yubabie/waveforge/actions/runs/37318408329): all steps PASS on 2026-10-05
- Browser E2E: 60 PASS; account flows: 4 PASS; built-site regressions: 33 PASS
- The same run also passed all 580 unit tests, syntax checks, mocked HF Python tests, proposed-spec validation, independent synthetic DSP checks and production build
- Synthetic artifact `11348234987` includes desktop/mobile screenshots and DSP output; archive SHA-256 `501547bf8483437db5300f2b3bd5cef890ef0172738ea61ef39c2dfb51dca309`
- Built-site desktop and 390-pixel lyrics screenshots were downloaded and visually inspected; controls and export actions remain within the viewport
- Actual audio-device listening, long-file stress, other browser engines and independent standards certification are not covered by these results

The install log reports seven dependency advisories (four moderate, three high). A green functional test run is not a clean security audit; dependency impact must be assessed separately.

## Test data and limits

All retained material is synthetic: multilingual text with hand-assigned timings, generated audio and mocked services. No user's song or lyrics were uploaded, no voice model was invoked, and no external paid service was used.

Key files:
- `tests/ui/lyrics-panel-regressions.test.js`
- `tests/audio/lyrics-export-regressions.test.js`
- `tests/audio/lyrics-playback-range.test.js`
- `tests/lyrics.test.js`
- `tests/fixtures/lyrics/`
- `tests/e2e/lyrics.spec.js` and `foundation-recovery.spec.js`

Remaining checks include broader browser/device coverage, long-file hashing/memory cost, all target subtitle players, automatic alignment quality, persistent undo beyond this page and the broader DAW roadmap.
