# Lyrics resampling cancellation and resource ownership

Validation date: 2026-10-06. Base: `02dbb1a5ae197db39638a6275b7a2fa957d459d0`.

## Reproduced defect

`prepareAlignmentWindow()` awaited non-abortable native rendering while Cancel
immediately retired the service request. Ten rapid run/cancel cycles could start
ten native contexts before any settled. A native rejection also skipped the
source's `disconnect()` call.

Two newly written regression assertions failed on the unchanged base:

- Expected one pending native context; observed ten
- Expected one source disconnect after rejected rendering; observed zero

For the synthetic 20-second, 48 kHz mono case, each attempt sliced 960,000 Float32
frames (3,840,000 bytes) and requested a native mono buffer of the same length.
The ten-attempt reproduction therefore made ten JS input copies and requested
9,600,000 native mono frames. These are deterministic copy/allocation counters,
not browser heap measurements. They show avoidable overlapping work and missed
failure cleanup, not a proven permanent memory leak or a measured peak RSS.

## Changed behavior

- A shared native-resampling owner is claimed before PCM slicing or native
  allocation, including across alignment-service instances
- Cancel/dispose disconnects the source and rejects the cancelled preparation
  promptly, while retaining native ownership until the render promise settles
- A retry requiring resampling during that interval fails before copying PCM,
  with “上一段音訊仍在完成取樣轉換，請稍候再試”
- Success, rejection and synchronous setup failure disconnect any source and
  release ownership appropriately; a late rejection after Cancel is consumed
- A new 16 kHz request needs no native resampling and can proceed. Retired work
  cannot clear its active service state or dispose its recognizer
- Existing source data and lyrics remain unchanged

The same ten-attempt test now creates one native context, slices PCM once and
requests 960,000 native mono frames. Its source disconnects once on Cancel.
There is no retry queue retaining more inputs. This guard applies to lyrics
resampling, not every other Web Audio operation in the application.

Native offline work is not forcibly stopped or claimed to be immediately freed.
If a browser never settles a native render, another native resampling request
stays blocked until page reload. Manual lyrics work remains available; reloading
can lose unsaved state, so save the project first.

## Retained checks

`tests/audio/lyrics-resampling-lifecycle.test.js` adds 18 synthetic lifecycle
tests covering repeated cancellation, prompt rejection with delayed settlement,
late resolve/reject, synchronous failure stages, disconnect failure, invalid
PCM, pre-aborted input, cancellation before listener installation, separate
service instances, and a valid newer request surviving old completion.

Local results on the changed source:

- Focused resampling/service/panel suite: 73 passed across 3 files
- Complete unit suite: 1,136 passed, 1 existing skipped, 64 files passed
- Syntax lint: 175 JavaScript files passed
- Production build passed; existing large-chunk warning remains
- Backend Python tests: 4 passed
- Synthetic audio-trust checks and capability-registry structure checks passed
  (the registry check does not establish implementation of proposed features)

The additional Playwright test in `lyrics-auto-alignment.spec.js` uses real Web
Audio with controlled promise delivery and the existing mock-ASR/no-model-
download harness. It checks the cancellation message, unchanged saved project,
blocked repeated allocation and successful retry after settlement. It was
collected successfully with `playwright test ... --list`, but **not executed**
here: this task does not permit launching the locally blocked browser. It is
ready for the permitted browser CI workflow, and no browser or deployment pass
is claimed by these local results.

No dependencies were installed, no models were downloaded, no user audio was
used, and no repository changes were published by this validation task.
