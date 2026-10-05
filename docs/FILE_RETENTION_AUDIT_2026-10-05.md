# File-retention audit — 2026-10-05

Audited baseline: `3c838187e45635efbaffc4a83a3d38b4c867bdf9`.
This was a source audit plus local synthetic/mocked tests. No user recordings, live
Hugging Face uploads, ACRCloud calls, account changes, pushes or deployments were used.
Line references below describe the baseline unless stated otherwise.

## Direct answer

- Ordinary mastering reads audio into the browser. It does not upload the recording.
  The page retains source audio, album sources and previews for editing; explicit clear
  releases its mastering references. Original files and downloaded exports remain on
  the user's device.
- Starting cloud separation uploads the complete file and filename to the configured
  Hugging Face Space. Closing the page is neither a server-delete request nor a reliable
  way to stop the server job. The repository configures periodic cache expiry, not
  immediate deletion on exit.
- Adding a copyright-library work while signed in saves metadata to Supabase. Clicking
  scan sends raw audio excerpts through its Edge Function to ACRCloud; it does not send
  only an extracted fingerprint. Stored work and scan records survive closing the page.

## Evidence and certainty

### Browser mastering: CONFIRMED in source

`src/js/main.js:350–423` reads `File.arrayBuffer()`, makes a decode copy and gives a
local Blob to WaveSurfer. `src/js/audio/engine.js:126–139` retains the decoded buffer
and source-asset metadata. `src/js/album.js:14–27` retains File references, with lazy
decoding for album rendering. `src/js/main.js:1274–1321` owns original/final preview
Blob URLs. A search of application source found no audio IndexedDB, Cache API or
service-worker persistence; presets store DSP snapshots in localStorage
(`src/js/user-presets.js:1–32`). This does not assert that the browser/OS has no caches.

`src/js/main.js:513–550` clears mastering sources, preview URLs, waveforms, stems and
album entries, but refuses while loading/processing is busy. It retains presets,
account sessions and the separate copyright works library. Single-track export can
opt into cleanup after initiating the download (`1409–1421`); it does not prove the
download was saved successfully. Album export does not use that opt-in.

Pagehide clears preview URLs and selected timers/resources (`main.js:1291,1443`;
`stems-mastering.js:443,492`), rather than calling the full clear action. The leave
warning (`main.js:1434–1440`) warns about loss; it does not erase data or cancel jobs.

INFERRED/browser-dependent: closing a destroyed document normally makes its references
eligible for browser cleanup, while history may preserve a page. Neither JavaScript
cleanup nor navigation demonstrates secure memory erasure. Exit handlers are not
reliable on every device; see [MDN pagehide documentation](https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event).

### Hugging Face separation: CONFIRMED configuration, UNKNOWN deployed retention

The explicit separation button calls `separateStems`
(`src/js/stems-mastering.js:484–488`), which uploads the full File via FormData
(`src/js/audio/hf-demucs.js:70–91,129–162`). The 50 MB limit is a client check, not a
server-enforced storage/duration quota.

`hf-space/app.py:21–33` uses a TemporaryDirectory for Demucs working outputs and reads
the four WAVs into bytes before that directory is removed. The original upload is
outside this working directory. At `40–45`, Gradio owns the input/output cache and is
configured with `delete_cache=(300, 3600)`. Gradio 6.19.0 is pinned in
`hf-space/README.md:6–9`. Its [Blocks contract](https://github.com/gradio-app/gradio/blob/gradio%406.19.0/gradio/blocks.py)
describes a 300-second sweep of files older than 3,600 seconds, subject to the server
running and cleanup succeeding. This is not an exact one-hour deletion receipt.

The frontend has no server cancellation/delete call. Its generation invalidation
discards stale results only after network/download/decode work
(`stems-mastering.js:60–70,219–229`). Client disconnect or timeout is not evidence that
the synchronous server inference stopped.

UNKNOWN from this audit: actual deployed revision/configuration, earlier uploads,
crash remnants, provider/proxy/browser HTTP caches, backups, and provider log expiry.
The [pinned Demucs CLI](https://github.com/facebookresearch/demucs/blob/v4.0.1/demucs/separate.py)
prints input/output paths. A generic UI error and `analytics_enabled=False` do not
redact CLI logs. The Pages deployment workflow does not deploy the separate HF Space.

### Copyright library and scanning: CONFIRMED in source

- Selecting a library file stores a local File reference. With a signed-in backend,
  it inserts `user_id`, work name, file size and fingerprint status into `works`
  (`src/js/antitheft.js:333–368`); it does not upload the full song there
- Scan buttons are separate user actions (`antitheft.js:640–652`). Quick scan extracts
  one up-to-15-second, mono 16 kHz WAV; complete scan uses at most eight excerpts
  (`antitheft/scan-audio.js:16–61`; `antitheft.js:398–411,449–463,527–534`)
- The Edge Function decodes the base64 WAV and sends its bytes as `sample.wav` to
  ACRCloud (`supabase/functions/acr-scan/index.ts:150–167`)
- It stores results, match count, the raw ACR response and scan time
  (`index.ts:298–310`; `supabase/migrations/001_init.sql:25–51`). No audio database
  column or Supabase Storage audio-write path was found. Result notifications may
  also be emailed (`index.ts:313–333`)
- Reload restores the metadata with `file: null` (`antitheft.js:158–171`). The schema
  has no automatic TTL for work/scan records. Separate work deletion requests a row
  deletion with cascading results; the UI currently ignores the database deletion
  error (`antitheft.js:660–666`). That should not be treated as verified erasure

UNKNOWN: ACRCloud/Supabase/provider request-log, sample-cache, backup and email
retention. Deleting an application record cannot retract copies already transmitted.

## Local fix and verification

The baseline's `fetchWithTimeout` cleared its timer as soon as fetch returned response
headers. SSE and download bodies were read afterward. A no-network reproduction with
a 10 ms deadline was still waiting at 40 ms with `signal.aborted === false`.

The local patch keeps timers active through upload/submission JSON, stem bodies and
the SSE completion event; cancels/unlocks SSE readers; releases timers/listeners; and
allows an optional caller AbortSignal. The existing UI does not yet pass that signal
or request server cancellation. Privacy copy now states the different retention scopes.

Verification on the isolated retention branch:

- `npm run lint`: PASS, 107 JavaScript files
- `npm test`: PASS, 39 files / 475 tests, including 44 HF-client tests
- `npm run build`: PASS; existing non-blocking >500 kB bundle warning remains
- Python service-boundary tests: PASS, 4 tests
- `git diff --check`: PASS
- Independent read-only patch review: no remaining actionable findings after hardening
  cancellation cleanup against a never-settling transport hook
- Five local Chromium privacy/session/layout tests: BLOCKED before assertions, because
  Chromium could not create its process socket (`Operation not permitted`). A permitted
  sandbox-escalation retry had the same launch failure. These are not passing browser
  tests; the new disclosure assertion remains to be run in a supported browser environment

The HF tests use fake clocks, mocked HTTP and synthetic streams. Python tests mock both
Gradio and Demucs. They prove client lifecycle/work-directory behavior, not model quality,
live uploads, deployed cache expiry or server cancellation.

## Smallest next cleanup design

1. Give the UI's current separation job one AbortController. Abort on explicit cancel
   and source replacement, invalidate its generation and allow local clear. Pagehide
   can best-effort abort client work, but must never be the retention guarantee
2. Keep authoritative server expiry independent of browser state. Record job ownership,
   status and expiry with private per-job storage. Sweep abandoned/failed/orphaned inputs
   and outputs, including after restart; retain only files still needed by active jobs
3. For actual remote cancellation, use an ownership-checked job identifier and a
   terminable worker/subprocess with a deadline. An HTTP AbortSignal alone is insufficient
4. If explicit remote deletion is added, make it idempotent and ownership checked; never
   accept arbitrary filesystem paths from the client. Show completion only after server
   acknowledgement. Use appropriate `Cache-Control: no-store` on private audio responses
5. Minimize/redact filenames in logs, set backend size/duration/queue limits, and specify
   provider retention separately. Keep work-library deletion distinct from mastering
   clear, and surface deletion errors before claiming a record is gone

These are design recommendations, not implemented or deployed features.

## Retained test-data plan

The repository contains four small WAV fixtures (0.5, 2, 4 and 8 seconds; 48 kHz stereo
16-bit) and deterministic signal generation at `tests/audio/render-parity/signals.js`.
There is no Colab notebook in this revision. The Vocal Drift evaluation manifest is
explicitly empty and awaits authorized audio; it is not a model-quality result.

For reproducible privacy/resource testing, retain generators and a fixture manifest
with seed, duration, channels, rate, amplitude, SHA-256 and a synthetic/public-use origin.
Use sine/impulse/seeded noise/silence/transients, mono/stereo/antiphase, 44.1/48/96 kHz,
clipped/truncated/corrupt files, Chinese/hostile filenames and mocked size boundaries.
Do not commit private songs, real account tokens, downloaded results or provider logs.

Add a real pinned-Gradio local integration suite with the model stubbed and short test
TTLs: upload-only abandonment, success, failure, partial output, retry, expired download,
active-job protection, restart/orphan recovery, ownership denial and log redaction.
Assert actual files and served URLs disappear, not merely that `delete_cache` was passed.
Keep those tests separate from mock contracts and any opt-in real-model listening tests.

Browser coverage should include repeated load/clear/reload, closed preview URLs, no audio
writes to browser storage, source replacement during an in-flight request, late result
rejection, downloads surviving local clear, and back/forward restoration. A BFCache test
must deliberately enable that browser behavior rather than rely on Playwright defaults.
