# Exact-weight Whisper verification, 2026-10-05

## What actually ran

After explicit approval, the seven files in `src/js/lyrics/whisper-config.js`
were downloaded from the immutable `Xenova/whisper-tiny` revision
`5332fcc35e32a33b86612b9a57a89be7906102b1`. All **66,406,756 bytes** matched
the manifest's individual file lengths and SHA-256 hashes before execution.
Weights are retained outside this repository, not committed or published.

- `graph-probe.json`: an actual `onnxruntime-node` CPU decoder session exposed
  all four `cross_attentions.0` through `.3` outputs. This is graph execution
  metadata, not an inference inferred from the model configuration.
- `node-cpu-evidence.json`: real Transformers.js 3.8.1 CPU transcription of the
  rights-verified CC0 singing fixture, a repeated run, its first five seconds,
  synthetic exact silence, and deterministic synthetic noise. Raw outputs and
  validation failures are retained, including failures that must not be hidden.
- `browser-blocker.json`: ordinary local Chromium could not start because its
  process-singleton socket was prohibited. No sandbox or security restriction
  was bypassed. This is the historical VM blocker from 21:54 UTC; the later
  permitted CI browser run passed and supersedes it as the current status.
- `browser-smoke-evidence.json`: exact 75,945-byte CI report, unmodified. Built
  Worker/WASM, live fixed-source download/CORS, cache/repeat/cancel/retry and
  actual application UI all passed. There were no forbidden requests or page
  errors. `singingAccuracyValidated` remains false.
- `browser-smoke-provenance.json`: SHA-256, originating run and tested head.
  Evidence: [run 37384510849](https://github.com/yung13yubabie/waveforge/actions/runs/37384510849),
  commit `67e117742d19ab26fa430d3872c89f536772a7ab`, completed
  2026-10-05 22:49:37 UTC. This is a localhost built-app test, not evidence that
  the production host already serves this commit.

The shared pure `whisper-timestamps.js` adapter is the same instance-level,
version-pinned mel-to-encoder frame correction used by the product Worker.
The 20-second inference supplied 2000 mel frames and used 1000 encoder frames;
the five-second crop supplied 500 and used 250. Each real attention output had
the padded 1500-frame encoder axis. No generated timestamp was scaled or fixed.

## Results and the failure found

The 20-second singing excerpt produced 25 word chunks from 0.34 to 19.98 seconds.
All timestamps were finite, increasing, nonoverlapping, and within the input
window. A second run produced identical text and timestamps. The five-second
crop produced four valid words ending at 4.60 seconds. Inference took roughly
0.8–1.3 seconds on this cloud CPU; these timings do not predict browser speed.

Raw 20-second text, **not a verified transcript**:

> Twinkle, twinkle little star How I wonder what you are Hopper, above the world
> so high Like a diamond in the sky, when the blade

The production matcher was also run on these real ASR words against five
public-domain reference lyric lines, retaining the original reference text:

- `Twinkle, twinkle, little star`: matched candidate [0.34, 4.68], lexical coverage 1
- `How I wonder what you are`: matched candidate [4.68, 9.30], lexical coverage 1
- `Up above the world so high`: partial candidate [11.12, 13.76], coverage 19/21;
  the word `up` has no matching ASR evidence, so this start omits that word
- `Like a diamond in the sky`: matched candidate [13.76, 18.18], lexical coverage 1
- `When the blazing sun is gone`: unresolved; the short crop/raw recognition
  does not supply enough matching words, so both boundaries stay null

Those four candidates and one unresolved line are **matcher behavior**, not
four verified-correct alignments. In particular, a high lexical coverage can
still yield an incomplete line start. The evidence JSON includes every ASR
word, interval, matcher diagnostic, source fixture hash, and UTC run time.

### Real targeted second pass

The partial `Up above...` candidate was fed through the same production
`planAlignmentWindows` with neighboring candidate times as context. It planned
7.30–15.76 seconds. `prepareAlignmentWindow` produced 8.46 seconds of real PCM
with measured offset 7.30; the exact model was run again on this crop.
`joinWindowWords` applied the measured offset once before the production
matcher reran with only that line targeted.

Coverage stayed **19/21**, and `up` was still missing: **no lexical improvement**.
The candidate moved from [11.12, 13.76] to [10.06, 13.64], a start shift of
−1.06 seconds and end shift of −0.12 seconds. This is not evidence of improved
boundary accuracy. The report retains the window, cropped float32 PCM hash,
new raw/absolute words, matching context, original text and before/after
diagnostics under `targetedSecondPass`. No reference word or time was invented
to turn the unsuccessful recovery into a pass.

The fixture still has `transcriptVerified:false` and no manual timestamp gold.
Its recording is by Derrick Coetzee / Dcoetzee under CC0; see the unchanged
fixture provenance for source URLs and rights evidence. No manual listening,
word error rate, boundary median/p95, or multilingual accuracy is claimed.
Do not replace the fixture's transcript with this model output.

The raw model hallucinated **“you” at [0, 1.98] on two seconds of exact digital
silence**. Timestamp bounds alone would have accepted that word. The product now
returns no words before loading the model when every PCM sample is exactly
zero. Both client and Worker guard this case. The guard is not an energy
threshold, voice detector, or a guarantee for background noise, instrumental
audio, or quiet singing; nonzero subnormal samples still reach the model.

The seeded noise produced `(water running)` with a zero-length final word at
[1.3, 1.3]. The existing strict validator rejected the entire result; no clipping,
interpolation, or confidence was fabricated. Thus `timestampContractAllPassed`
is deliberately false in the raw evidence. A synthetic unrelated lyric line
remained unresolved when matched against the valid singing ASR output.

`WHISPER_INFO.modelValidation` is now `browser-smoke-verified-but-quality-uncalibrated`.
The built browser functional route has passed; real lyric-alignment accuracy
is still uncalibrated. The original CI artifact retains the metadata string
from its tested commit and is intentionally not rewritten to reflect later copy edits.

## Reproduce, only with source/execution approval

The runner is not part of default tests, build, or deployment. An explicitly
approved standalone CI validation step may invoke it. It performs no action
without explicit flags. Use a cache directory outside the checkout.

```sh
node scripts/verify-lyrics-model.mjs \
  --approved-revision 5332fcc35e32a33b86612b9a57a89be7906102b1 \
  --download --probe

node scripts/verify-lyrics-model.mjs \
  --approved-revision 5332fcc35e32a33b86612b9a57a89be7906102b1 \
  --infer
```

`--download` alone verifies files without importing or executing a model.
`--probe` inspects real CPU decoder outputs; `--infer` additionally runs the
fixed local fixtures. Every run rechecks all seven hashes before importing the
runtime. After file acquisition, global fetch is disabled and the runtime uses
local-only files, with no audio or lyrics upload, fallback model, or cloud
inference service. The CPU runtime is supplied by the locked npm dependency.

### Separate browser Worker/WASM smoke

The runner additionally implements `--browser` for a permitted environment with
official Playwright Chromium installed and an already-running localhost
server. The built/live mode has passed in permitted CI; it was not relaunched
in the restricted VM. Run it as a
separate explicitly approved validation step, never by enabling the existing
manual-gold accuracy test or making model execution part of deployment:

```sh
node scripts/verify-lyrics-model.mjs \
  --approved-revision 5332fcc35e32a33b86612b9a57a89be7906102b1 \
  --download --browser --live-download --server-mode built \
  --test-url http://127.0.0.1:4173/ \
  --output docs/validation/real-model/browser-smoke-evidence.json
```

Build first with `npm run build` and start the preview server at that URL.
Built mode discovers the actual hashed client module through the served
production HTML and its emitted entry module, then loads that module and its
real hashed Worker/WASM assets. No production test hook is inserted. A separate
`--server-mode dev` targets a running Vite dev server, usually port 5173.

It invokes the real client, dedicated Worker and bundled WASM. It checks the
20-second CC0 fixture's bounds, identical repeat, seven-file browser cache,
new Worker reading and rehashing that cache, cancellation after transcription
begins, and successful cached retry. Exact-silence preflight, real-output
reference mapping and incorrect-text nonmatching are recorded separately.

The same CLI then runs a genuine application UI integration case in the same
browser context and verified model cache. It selects the retained CC0 WAV
through the real file input, opens the lyrics tab, pastes/applies the five
reference lines, chooses English and accepts the model disclosure. It presses
the actual analysis button and requires both matched and unresolved candidate
diagnostics without rewriting the source or applying times prematurely.

It adopts that batch once, exercises first-line confirmation/locking, and
retries only one unlocked line through the actual UI/service/Worker/matcher.
The complete locked first-line record and saved project must remain unchanged
while the new proposal awaits adoption; the retry proposal is then discarded.
First-line confirmation here tests the control/lock mechanism only: it is not
a human-listening or correct-boundary claim, and the fixture stays unannotated.

Real project JSON downloads retain draft/missing/unconfirmed data, and TXT
must match the original lyrics byte-for-byte. Timed LRC/SRT/ASS attempts must
show validation errors and produce no subtitle download while sung lines
remain incomplete or unconfirmed. No missing word or timestamp is filled in
just to enable an export. The UI case must create a real Whisper Worker and
perform zero new model-file GETs, confirming reuse of the preceding cache.
Its saved projects, visible diagnostics, export outcomes and failure stage are
retained under `uiIntegration` in the browser report.

With `--live-download`, the browser really downloads from the fixed seven model
URLs. Body-free HTTPS GET redirect chains must descend from one of those exact
requests; no arbitrary external initial request is allowed. The Worker verifies
every length/hash before execution. A successful run can therefore validate
the browser's live download/CORS path as well as WASM execution. Signed redirect
query parameters are not retained in the evidence artifact.

Without `--live-download`, the exact seven URL GETs are instead fulfilled from
the externally stored bytes that the runner has already verified. The Worker
independently verifies them again. That reproducible fixture transport does
**not** validate live browser CDN redirects or CORS. Both modes require all
HTTP requests to be body-free GETs to localhost or the model allowlist. Vite
HMR WebSockets are blocked, and service workers are disabled in the isolated
test context. No browser security, certificate or CSP bypass is enabled.

A localhost smoke pass is not a deployed-host-header pass: `vercel.json` and
`public/_headers` currently contain worker-applicable `connect-src 'self'` and
`script-src 'self'`, which need a separate deployment/security review before
claiming the remote model source and WASM work on a host enforcing those rules.
Those security policies were not modified by this task. This is a constraint
for hosts enforcing those files, not proof that the current GitHub Pages host
sends those response headers. A normal non-blob dedicated Worker has its own
response CSP rather than inheriting the page's meta CSP.

## Checks and remaining acceptance work

- Focused mocked/source-contract tests: 68 passed, one annotated browser test
  skipped; mocks are still labeled separately from real model evidence
- Exact digital silence produces an empty result without a Worker or download
- The pure timestamp adapter extraction preserves its existing synthetic tests
- Real browser/WASM lifecycle, live downloads/CORS, cache, cancellation, retry,
  network capture and actual UI passed in the recorded CI run. UI produced four
  candidates/one unresolved line, preserved the locked line, reused cache with
  zero new model GETs and enforced timed-export gates
- That head passed 75 browser, 4 account and 43 production tests; local unit
  verification was 916 passed/1 manual-gold skip. The final release commit must
  pass its own functional CI; verify the exact deployed GitHub Pages host and
  version separately before claiming release completion
- Annotated English and Mandarin singing, mixed language, long vowels, rap,
  repeated choruses, intro/interlude, and full-song overlap/retry quality remain
  pending; one short English excerpt is not an acceptance benchmark
