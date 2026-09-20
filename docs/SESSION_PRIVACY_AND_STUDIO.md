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
scanning sends audio samples through the configured Supabase Edge Function to ACRCloud.
Clearing this page does not retract those requests or delete cloud files.

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
