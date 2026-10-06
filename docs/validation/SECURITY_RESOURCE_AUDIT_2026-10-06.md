# Security and resource audit · 2026-10-06

## Scope and status

Read-only baselines: current `02dbb1a5ae197db39638a6275b7a2fa957d459d0` and replacement candidate `2debf63b85a6333bea0840020d4a01351a287801`. Fixes were made in an isolated worktree from the current baseline. No browser was launched in the restricted executor, no model was fetched, no user audio was transmitted, and no dependencies changed.

This is an adversarial-input and resource-ownership review of DAW import/restore, lyrics, pitch and associated workers. It is not a blanket security certification or proof that all browser/native memory is leak-free. The 512 MiB policy is a conservative budget for DAW-owned data and reservations, not a whole-tab memory cap; mastering, models, native codecs and browser/GPU internals can allocate separately.

## Name → test → finding

| Name | Test / evidence | Finding |
|---|---|---|
| Cancelled ordinary import ownership | Delayed `file.arrayBuffer()`, ten Import/Cancel attempts with declared 64 MiB sources | Both baseline SHAs started ten outstanding reads, representing 640 MiB before any accepted asset or decoder call. This was in-flight accumulation, not demonstrated permanent leakage. Fixed: ordinary imports share a durable load lease with ZIP restore; retries are refused until actual read/hash/native settlement. |
| Cancelled ZIP entry-read ownership | Valid store ZIP containing a 64 MiB source; delay its media read and cancel ten restores | Ten outstanding 64 MiB reads reproduced against baseline archive code. Fixed at the panel entry point with the same lease; the importer reports its source/decoded/transient working estimate before reading media. |
| Native decode outliving Cancel | `daw-decode.test.js` + `daw-panel.test.js`: cancelled caller, pending native promise, Clear, retry/render/restore | Caller cancellation stays prompt. `whenIdle()` separately signals actual native settlement. Input/PCM reservations survive cancellation; an unknown native output reserves the maximum accepted PCM allowance against other work until settlement. Late rejection is consumed and late success cannot commit. |
| Accepted-project integrity | Cancelled restore with delayed success; failure and malformed ZIP cases | Project metadata and accepted PCM contents/identity stay unchanged. Only validated, current completion atomically replaces project/files/buffers. |
| ZIP bombs and path names | `daw-archive.test.js`: method 8/huge declared size, traversal, duplicate paths, symlinks, ZIP64, split/overlapping/hidden records, CRC and SHA failures | Rejected. Import supports only stored method 0; allowed internal paths are `manifest.json` and `media/NNNN.bin`. Display filenames are not extraction paths. Hash all sources before decoding any. |
| Project allocation bounds | Archive/project/history/render tests; callback-refusal test before media read | Header/directory/manifest sizes, item counts, rates, timeline duration and metadata complexity are checked. Reservation refusal occurs before source-entry reads. Native decoder output is necessarily checked after the browser creates it; see limits below. |
| Metadata and lyrics XSS | DAW and lyrics UI tests import `<img onerror>` / `<svg onload>` payloads in names, lyric text and diagnostics | Rendered as text/value. No injected executable elements or global side effects appeared in jsdom. This does not replace real-browser CSP/network review. |
| Pitch and Whisper worker ownership | Each client: 100 cancelled mock jobs with worker termination, AbortSignal add/remove and timer accounting | 100 workers created/100 terminated; zero remaining job timers; matching abort-listener removals every round. Original PCM is copied before transfer. No real Whisper runtime/model executed. |
| Lyrics resampling ownership | Ten run/abort calls while native resampling is delayed; rejected native render | Baseline created ten native contexts/connected sources (9.6 million copied frames at 48 kHz/20 s); render failure skipped disconnect. Reported to the separately owned alignment fix; not altered by this commit. |
| Local-analysis network contract | Existing `whisper-client.test.js` request-fence tests + source review | Model GETs have fixed pinned destinations, no request body, omitted credentials and no referrer; runtime fence refuses non-GET, bodies and other URLs. No network transmission claim is made for separate explicitly-cloud features such as Demucs/ACRCloud. |
| Dependency advisory lookup | Lead's successful npm audit; unchanged lockfile SHA-256 `725927bac091e38be141324007c197e8e93cee5faf84c9ace93fc0e3c1940098` | Zero known advisories returned on 2026-10-06. This is advisory-database evidence only; the query was not repeated here. |

## Boundaries and measured limits

- ZIP: at most 256 MiB total, 1 MiB manifest, 64 media files, 64 MiB per source; at most 65 entries and 11,310 bytes of central-directory metadata under the strict profile
- Project: 16 tracks, 256 clips, 64 assets, 600-second timeline; decoded PCM and a single stereo render each capped at 256 MiB for accepted data
- Metadata history: at most 100 snapshots, 8 MiB serialized history, 1 MiB per snapshot; graph depth 32 / 100,000 visited nodes; runtime objects and dangerous prototype keys rejected
- Pitch input copy: at most 60 s × 192,000 samples/s × 4 bytes = 46,080,000 bytes (43.95 MiB), one channel
- Lyrics resampling: per-window input at most 20 seconds, output at most 320,000 mono samples at 16 kHz (1,280,000 bytes); supported input rates reach 384 kHz, so a single input copy may be 30,720,000 bytes before additional native copies
- Download URLs intentionally survive 1,000 ms (DAW) / 1,500 ms (lyrics) for browser download handoff, then revoke
- Native audio decoding cannot be reliably aborted. A compressed file below 64 MiB can expand beyond accepted limits before the browser returns an AudioBuffer. Manifest duration/size claims cannot make that native allocation safe by themselves. The fix prevents canceled jobs from admitting further unaccounted work; it does not sandbox or cap a browser codec
- If native decoding/file reading never settles, new source loads remain blocked rather than queuing additional allocations. Saving accepted work and refreshing may be needed. This is a resource-safety tradeoff, not a successful decode

## Retained regression and browser probe

`tests/ui/daw-panel.test.js` covers read/hash/native cancellation, ten refused retry reads, Clear, render competition, ZIP cancellation, cross-import/restore exclusion, original PCM identity and XSS. `tests/audio/daw-decode.test.js` tests the distinction between caller and native settlement. `tests/audio/daw-archive.test.js` checks pre-media reservation refusal in addition to existing adversarial ZIP cases.

`tests/e2e/resource-lifecycle.spec.js` is a retained **CI browser probe, not locally executed evidence**. It uses synthetic PCM and blocks unexpected HTTP request bodies/model URLs. One test holds a real file read and checks ten refused retry reads. The other uses 3 warm-up + 7 measured rounds through master import, pitch Worker cancellation, DAW import/render/download, failed restore, successful restore, clear and navigation.

Strict ownership tolerances after cleanup: 0 connected source nodes, 0 object URLs, 0 active Workers and no growth in persistent window/document listeners relative to the warmed baseline. AudioBuffers returned by createBuffer/decode/render are observed using WeakRef, with live PCM bytes recorded after two GC requests; those observations are incomplete for native-only allocations. The probe attaches per-round `Runtime.getHeapUsage` plus warmed delta. There is deliberately no arbitrary heap/RSS pass threshold: inspect trends and retaining paths if counts grow; a single RSS drop is not evidence of no leak. Browser-internal caches, native audio allocation, GPU memory and worker runtimes are not fully represented by V8 heap size.

Run in an authorized browser-capable CI environment:

```sh
npx playwright test tests/e2e/resource-lifecycle.spec.js
```

## Verification

- Read-only focused baseline: current 369 passed / 1 skipped; replacement 414 passed / 1 skipped
- Final focused security/lifecycle suite: 243 passed / 1 skipped (6 files)
- Final full suite: 1,131 passed / 1 skipped (63 files); production build passed (existing >500 kB chunk warning); syntax check passed for 175 JavaScript files; `git diff --check` passed
- New browser tests pass syntax and Playwright collection (2 tests); execution is pending in permitted CI
- The existing one skipped model/browser test remains skipped; it is not counted as a pass

## Current-release native-render follow-up

A focused follow-up reproduced a DAW-owned budget gap on `3ccf123`: after cancelling a delayed native render and clearing the project, its source AudioBuffer and pending output remained owned by the native render, but panel accounting no longer included them. The render single-flight guard still prevented a second render; this was one bounded overlap with new import work, not unbounded render accumulation or demonstrated permanent leakage.

The retained regression uses the real `renderProject` wiring with a delayed native-context double. A 600-second stereo render at 48 kHz plus its 4-second mono source reserves 231,168,000 bytes (220.46 MiB). After Clear, a five-file import had a 448 MiB source/read-copy reservation and was incorrectly admitted, giving 668.46 MiB combined before its decoded PCM. File-size/context doubles test allocation admission without allocating that much memory or running a browser.

The narrowly ported fix exports `getPendingNativeRenderBytes()`, retains its source/output estimate until actual native settlement (including cancellation and timeout), and adds it to the panel's common `retainedBytes()` budget. The same regression now refuses all fresh reads, preserves the old source PCM, and accepts the import only after the native promise settles. This is known DAW-owned data and is explicitly accounted, rather than classified as unspecified browser overhead. Transpose UI, generated takes and replacement workflow were not ported with this fix.

Follow-up validation: 146 focused tests passed; full suite 1,150 passed / 1 skipped across 64 files; syntax checked 176 JavaScript files; production build and diff-whitespace checks passed. No browser execution or remote action was performed for this follow-up.
