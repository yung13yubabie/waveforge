# Vocal tools: browser checkpoint, 2026-10-06

This is a historical development checkpoint, not a deployment certificate. The latest exact-head outcome belongs to [PR #4](https://github.com/yung13yubabie/waveforge/pull/4) and its Actions artifacts. Production remained `d3c4a339` during this check.

## Measured browser result

[Run 37426840382](https://github.com/yung13yubabie/waveforge/actions/runs/37426840382), head `626274e1241bdf5487ca7266b74736c6b738aba8`:

- 1,357 unit tests passed; one explicit opt-in test skipped
- Development Chromium: 122 passed, one engine-harness test failed; account and built-site suites were not reached because the development command failed
- Actual replacement recording, all six 44.1/48/96 kHz mono/stereo transpose combinations, independent formants, A/B, Accept, Undo/Redo, original preservation, exact Float32 archive data, WAV parity and fresh-session original recovery passed
- Real overloaded B audition was refused before a realtime source started; Cancel → explicit mix-gain reduction → regeneration then played safely before acceptance
- Six real post-DSP-start cancellation/retry/native-audition-cancellation/Clear cycles completed. Final owned Worker, connected source, pending native-render and Object-URL counts were all zero; no unexpected network requests or page errors were observed
- The separately labelled injected Worker ErrorEvent after real DSP progress also recovered through an untouched Worker retry. This is not evidence of a naturally occurring crash or an actual timeout
- Existing real Whisper browser verification passed independently despite the overall failed job. It used the already approved fixed model and licensed fixture; no user recording was used

Artifact `11394604507`, SHA-256 `612f31922393a225ab541bdc2d6cb98a8f5ae2d126c4416bd2436d104cb1448a`, contains path-backed PCM, lineage, overload, lifecycle and model JSON plus actual screenshots. The PCM identity observers intentionally retain buffers; they are not leak measurements. The separate lifecycle observer uses scalars and WeakRefs. Its final pre-explicit-GC snapshots still observed three AudioBuffers / 2,304,000 PCM bytes in the six-cycle test and two / 1,536,000 bytes in the injected-error test. These are not proof of retained leaks or proof of complete memory release.

## Two test-harness defects and the retained gates

The first run reached its 20-minute limit. A line reporter then identified the replacement spectral check: eight 48,000-sample scans each called a Playwright WAV-format assertion per sample, creating 384,000 synchronous reported assertions. The format check now runs once per scan, with identical sample reads, scaling, trigonometry and thresholds. Independent pure-helper checks at 44.1/48/96 kHz produced numerically identical magnitudes and still rejected the wrong format. The corrected real-browser case completed in about four seconds; no application audio path was changed for this fix.

The remaining failed harness first rendered correctly in a real Worker, then attempted to run a direct-core oracle on the main page. The existing `script-src 'self'` CSP correctly blocked that main-page WebAssembly compilation. The repaired test runs the approved direct core in the Node test runner, transfers identical synthetic Float32 input bytes, and compares complete input/output SHA-256 hashes and dimensions with the genuine browser Worker. It also explicitly requires a valid minimal WASM module to remain blocked by the main-page CSP. No CSP relaxation, `bypassCSP`, main-thread production fallback or weaker audio threshold was introduced. This repaired harness still requires the subsequent CI result.

## Remaining verification at this checkpoint

The next run must pass the repaired harness and the complete source, account and built-site suites. New captures must show the candidate A/B and acceptance controls fully above the fixed transport at 390×844 and desktop size, including original recovery; earlier detail crops alone did not establish this visual state. The next lifecycle probe additionally records Chromium GC/heap diagnostics after strict ownership settlement, with two warm-up and four measured rounds. Heap deltas remain non-gating because the observer accumulates scalar records and cannot measure all native memory.

This trial remains bounded constant transposition, not note snapping or professional vocal correction. Representative listening, other browser engines and broader singing material remain unverified. Preserve the measured pitch, transient and formant limits in [the workflow report](CLIP_TRANSPOSE_WORKFLOW_2026-10-06.md) and [Signalsmith measurements](signalsmith/README.md). The current unpatched dependency advisory is documented separately in [the security addendum](security/DEPENDENCY_ADVISORY_ADDENDUM_2026-10-06.md); it must not be reported as zero or as fixed.
