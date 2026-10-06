# Compact editor: alternate-recording replacement

Date: 2026-10-06. Local branch: `feat/compact-recording-replacement`.

Base: compact editor `66ddb9f8c254ea276c652175382251b5997df213`, plus the narrow lyrics focus fix cherry-picked as `0bc7f05efda0a5ed0d1b6811946c5b42f420659c` (patch-identical to `0233819199620a444d29f60be5c37910a5bff50d`).

## Integrated behavior

- Replacement stays collapsed in the selected-clip inspector. Empty selection hides the entire inspector, so there are no orphan replacement controls. Existing timeline-first layout, grid/output disclosures, automation, and fades remain intact.
- Select another authorized recording, set its source offset, inspect its native source rate and exact source/timeline ranges, audition A/B, then explicitly confirm or cancel. The candidate waveform is generated from the selected candidate interval.
- Only source identity and source offset change. Clip ID, name, timeline position, duration, gain, fades, cropped fade envelope, and volume automation stay unchanged. Short or invalid ranges fail atomically.
- Ordinary playback, WAV, ZIP, and mastering transfer continue to use the accepted project until confirmation. A/B audition uses the selected time interval of the full mix, including other tracks. Source buffers and original files are retained for undo/redo.
- Confirm/cancel returns keyboard focus to a visible chooser; cancellation during an audition returns focus to the disclosure while its chooser is disabled. Deleting the selected clip still returns focus to the timeline.
- ZIP full-file warnings remain visible beside Save and beside replacement confirmation. Archives can contain complete new/old recordings, unused assets and trimmed-away content, but do not serialize undo history.
- No upload, model download, voice cloning, time stretching, or inferred source alignment is added.

## Retained validation and regression fix

This integration retains the reviewed replacement implementation and all its tests from the alternate-recording branch, including the post-decode import check that counts `pendingReplacementBytes`. A cancelled uncancellable read continues reserving memory until it settles. The regression rejects an approximately 626 MiB combined operation against the 512 MiB budget, preserves the accepted three-asset project, then successfully retries the same import after the reservation is released.

New integration tests check contextual disclosure, linked privacy warnings, keyboard focus after confirm/cancel and pending-audition cancellation, accepted-only mastering transfer, and successful import retry after the memory reservation retires.

## Checks on the final combined code

- Full Vitest: 64 files passed; 1163 tests passed, 1 existing skipped
- Focused replacement/panel/project run before the unrelated lyrics cherry-pick: 123 tests passed
- Syntax lint: 176 JavaScript files passed
- Production build: passed; existing >500 kB chunk-size warning remains
- Audio-trust synthetic PCM / finite-buffer / 4× peak checks: passed
- `git diff --check`: passed
- Playwright discovery: 4 replacement cases; 29 cases across the seven targeted replacement/editor/automation/transfer/lyrics files

## Browser verification still required

No local Chromium was launched, and the browser cases have not executed in this environment. The prepared real-browser tests cover native OfflineAudioContext/rendered WAV/playback sample parity, 220 Hz → 660 Hz source change, 48/44.1 kHz source rates, accepted-only ordinary Play/WAV/ZIP before confirmation, undo/redo and ZIP reload, invalid offsets and interruption/selection/navigation safety, plus 1440/390 px contextual layout, touch targets, overflow and keyboard focus.

Suggested permitted CI command:

```sh
npm run test:e2e -- tests/e2e/daw-replacement.spec.js tests/e2e/daw-editor.spec.js tests/e2e/daw-automation.spec.js tests/e2e/daw-automation-render.spec.js tests/e2e/daw-transfer.spec.js tests/e2e/lyrics.spec.js tests/e2e/lyrics-auto-alignment.spec.js --workers=1
```

Mock/recipe unit checks do not substitute for native browser DSP or screenshot evidence. No dependency install, remote push, merge, deployment, or audio upload was performed.
