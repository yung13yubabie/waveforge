# Local integrated validation — 2026-10-05

Baseline commit: `3c838187e45635efbaffc4a83a3d38b4c867bdf9`.
Local repair branch: `fix/audio-trust-foundation`.
The retention patch from local commit `877bc06ba6900388ce01d014f005b6ff1e87ccf7` is integrated.
This record describes local checks only. No push, deployment, live service request,
user-audio upload or external-model inference was performed.

## Completed checks

- `npm ci --ignore-scripts --cache /tmp/waveforge-npm-cache --no-audit --no-fund`: PASS; lockfile dependencies, no dependency changes
- `npm test`: PASS, 42 files / 541 tests, including integrated retention regressions
- `npm run lint`: PASS, 116 JavaScript files; syntax checking, not full semantic/style lint
- `npm run build`: PASS; existing >500 kB chunk warning remains visible
- `python -m unittest discover -s tests/hf_space`: PASS, 4 mocked service-boundary tests
- `node scripts/test-audio-trust.mjs`: PASS; [synthetic output](audio-trust-synthetic-results.json)
- `node scripts/compare-audio-foundation.mjs BASELINE_CHECKOUT CANDIDATE_CHECKOUT`: [before/after evidence](audio-foundation-before-after.json)
- `npm run check:capabilities`: PASS for 136 proposed capability IDs, 862 detail groups, dependency graph and proposal contracts; no claim of implemented capability tests
- `git diff --check`: PASS
- Production Playwright test discovery: 26 retained cases parse and are included in configuration; listing tests is not running them

Dependency installation first failed because the default cache home was absent.
The authorized retry using a writable cache succeeded. No package/lockfile version
was changed to get the tests to pass.

## Browser verification: BLOCKED / NOT RUN

The retention branch attempted five Playwright UI tests with the installed system
Chromium. Chromium failed before assertions with `socket() Operation not permitted`,
including a reviewed elevated attempt. This is launch failure, not a failed product
assertion and not evidence of passing UI paths.

The integrated app's Vite server started normally on loopback. A separate supported
cloud-browser tab could not open the local URL: `net::ERR_BLOCKED_BY_CLIENT`.
No flags, alternate host, tunnel or security-setting changes were used to bypass
these restrictions.

Therefore full E2E, account-browser, production UI, actual preview/download PCM parity,
visual layout/screenshots and cross-browser checks remain unverified for these changes.
Seven new audio-foundation UI cases plus the retention disclosure case are retained
for execution in a permitted browser environment. Prior CI success on the baseline
does not validate the modified branch.

## Independent review and limits

Read-only review reproduced an important claim boundary: a seeded 16-bit WAV dither
can move a −1 dB pre-encoding floating-point peak to about −0.99985 dB after decoding.
The patch now labels verification as `pre-encode-float-pcm`, retains that negative
regression, and explicitly excludes WAV quantization and MP3 post-codec guarantees.
Read-only follow-up review reran 66 focused tests and accepted the corrected scope
and boundary logic; no independent browser or full-suite pass is inferred from it.
Key analysis now reports span, window count/duration and total sampled time even
when no key is returned. Short clips are labelled unanalysed.

Additional tests cover 0–11 sample clips, final-12-sample transients, different linked
stereo waveforms, watermark-before-limiter ordering, failed final safety verification,
NaN/Infinity, and equivalent synthetic material at 44.1/48/96 kHz.

These are synthetic DSP invariants and service-boundary tests. They do not establish
licensed singing-model quality, independent true-peak standard compliance, live
monitor/device behavior, delay-tail preservation, long-song throughput, saved-project
recovery, or actual deployed cache expiry. Those remain separate acceptance gates.
