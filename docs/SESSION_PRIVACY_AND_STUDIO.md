# Studio refresh and audio lifetime

## File handling

Selecting a file for ordinary mastering does not upload its bytes. The source File,
decoded audio, album sources and previews remain in this page so editing can continue.
Audio is not written to localStorage or IndexedDB. Saved presets contain DSP settings.

The header's **檔案與隱私** panel provides a single clear action for the mastering
session: stop playback, destroy waveform players, release source and stem references,
clear the album, revoke preview Blob URLs, and disable actions requiring audio.
The same file can be selected again. This is reference/resource cleanup, not a promise
of secure memory erasure. Downloaded files, saved presets, account sessions and the
separate copyright works library are not deleted.

**單曲輸出後清除母帶工作階段** is opt-in. It runs after a successful single-track
download is initiated; failed exports preserve the session. It also clears any album
and stems in the session, as indicated by the adjacent clear button. Processing blocks
manual cleanup to avoid stale async results restoring cleared data.

Cloud separation uploads the full file to the configured Hugging Face Space; copyright
scanning sends raw WAV audio samples through the configured Supabase Edge Function to
ACRCloud, not only fingerprints. Both require their separate processing buttons; ordinary
mastering does not invoke either upload. Quick scanning sends one up-to-15-second sample;
complete scanning sends up to eight such samples from across the song.
Clearing this page does not retract those requests or delete cloud files.

Adding a copyright-library work while signed in saves its name, file size and user ID
in Supabase. Its full source File remains in the current page; after reload the library
entry has no source audio and asks the user to select it again. Scanning also saves
matched metadata, the raw ACR response and scan timestamps. These records have no
automatic retention limit in this repository, survive closing the page, and are outside
the mastering clear button. Deleting a work separately requests deletion of the work and
its cascading scan-result rows; it does not retract samples already sent to ACRCloud,
provider logs, backups or notification emails.

Leaving the page is not a reliable erasure or cancellation mechanism. Current pagehide
handlers stop stem preview, invalidate stem results, destroy stem waveforms and revoke
master-preview URLs; they do not call the full mastering clear action. Browser history
may retain a page, and browsers do not guarantee exit handlers run. The app has no
service worker or IndexedDB audio store. Original files and downloaded exports remain
on the user's device. JavaScript reference cleanup cannot promise secure memory erasure.

## Cloud cleanup

`hf-space/app.py` and the previously deployed Space both left unmanaged temporary directories.
The local source now follows the deployed Demucs CLI pipeline, returning exact WAV bytes
for Gradio to cache. Its work directory is removed on both success and failure. Returning
bytes also avoids Gradio peak-normalizing each stem independently. On the pinned Gradio 6.19.0,
`delete_cache=(300, 3600)` checks every five minutes for cached files older than one hour.
This is periodic expiry, not immediate deletion after a browser download. Errors expose
a generic message rather than a server path. Local service-boundary tests mock the model
and Gradio; they do not prove the external Space runs this patch.

The Space source patch was deployed separately at revision
`a0af4d04accd15321a65fd8cf4d3bb8d54581441`. A GitHub Pages deployment does
**not** deploy `hf-space/`; future backend changes require a separate Space deployment.
Do not promise deletion of files from earlier deployments or provider backups.
The pinned [Demucs CLI](https://github.com/facebookresearch/demucs/blob/v4.0.1/demucs/separate.py)
prints input and output paths. Generic UI errors and disabled Gradio analytics do not
redact those service logs; their provider retention is not configured or verified here.

The network client's deadlines cover response bodies: upload/submission JSON and each
stem download have a 60-second deadline, and the SSE prediction response has a 600-second
deadline through its completion event. The SSE reader is cancelled and unlocked on
completion, error or abort. The client accepts a caller AbortSignal, but the current UI's
generation invalidation does not send server cancellation or deletion requests. A client
timeout therefore does not prove that Demucs stopped or that uploaded files were deleted.

Retention tests in `tests/audio/hf-demucs.test.js` use fake clocks, mocked fetch responses
and synthetic streams only. They cover stalled headers/body reads, completed streams,
caller aborts and reader/timer cleanup. `tests/hf_space/test_app.py` mocks Gradio and
Demucs to check working-directory ownership. Neither suite proves deployed Gradio cache
expiry, provider HTTP caches, logging retention, crash recovery or deletion from backups.

## Module ownership

- `ui/album-panel.js`: album list, alignment and CD package export.
- `ui/demucs-animation.js`: separation progress canvas, independent of account/scanning.
- `antitheft/scan-audio.js`: decode and encode audio samples for identification.
- `antitheft/evidence.js`: existing report generation and ISRC interpretation.
- `antitheft/results-view.js`: safe result links, result rows and report download UI.

Account/settings coordination remains in `antitheft.js`; source/transport/render
coordination remains in `main.js`. These are incremental extractions, not a completed
full DAW rewrite. Report claims and classification semantics were preserved.

## UI references and implementation

The studio uses graphite surfaces, mint active states, horizontal range controls with
numeric entry/reset, visible focus, mobile flow and reduced-motion-aware transitions.
No React component library was added to the vanilla Vite app.

- [beUI](https://beui.dev/): range controls and concise state transitions.
- [Rare UI](https://www.rareui.com/): restrained component surfaces.
- [Transitions](https://transitions.dev/): interaction transition reference.
- [shadcn/ui](https://ui.shadcn.com/): consistent form/control treatment.
- Beautiful UI could not be retrieved with the available web tool.
- [Gradio 6.19.0 implementation](https://github.com/gradio-app/gradio/blob/gradio%406.19.0/gradio/blocks.py): pinned cache-expiry behavior; Context Hub's package guide was for 6.9.0.

Visual review also found and fixed a pre-existing layout error: the guest banner was
a full-width child in a horizontal flex row, pushing the works/results offscreen.
It is now a sibling above the columns.

## Integrated lyrics workspace

The lyrics workspace adds localStorage recovery for accepted lyric text, timing and source identity only. It does not persist audio. Source loading, recovery, undo and clear preserve ownership of pending backups; an untouched source-only load never overwrites an unopened previous backup. Manual audio cleanup retains the lyric project and its backup. Text typed into the original-text field must be explicitly applied before it becomes part of the saved lyric project. Sudden process/device termination can still lose edits; download the JSON project for a separate copy.
