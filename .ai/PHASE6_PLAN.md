# Phase 6 Plan — Album Assembly + DDP 2.00 Delivery

> Design locked via grill-me on 2026-06-13. Direction: **deepen into a top-tier mastering tool.** This is the headline mastering differentiator.

## Decisions (locked)
- **Direction**: top-tier mastering tool (NOT a production DAW).
- **Per-track model**: each song carries its OWN chain snapshot (real mastering workflow). Album-wide loudness pass at the end.
- **Delivery format**: **DDP 2.00** (pressing-plant grade). 48k→44.1k handled by rendering each track in `OfflineAudioContext(2, len, 44100)`; dither to 16-bit via existing `wav.js` TPDF.
- **Loudness consistency**: **hybrid** — show per-track integrated LUFS + "align to target" button as a starting point + manual per-track gain trim. NO hard auto-normalize (kills inter-song dynamics).
- **Metadata**: full DDP writer (track markers, CD-frame alignment = 588 samples/frame @44.1k, lead-in pause, IMAGE.DAT, MD5) with **ISRC/UPC/CD-Text as OPTIONAL fields** (filled if provided, omitted if blank — low friction for friends without ISRC).

## Hard dependency discovered
Album mode needs **per-track chain snapshots** → build the "save/serialize chain state" infra first (this is part of Tier-1 workflow; album mode pulls it in). Snapshot = `{ params, bypassed, abMode }` serialized to a plain object; restore = apply to engine.

## Build order (TDD throughout; pure modules tested, integration via Playwright E2E)
1. ✅ **Chain snapshot/restore** (`engine.serialize()` / `engine.restore(snapshot)`) — DONE 2026-06-13. JSON-safe snapshot of params+bypassed+abMode; restore via setters (graph updates); deep-copy, partial-tolerant, null-safe. 7 tests. 222/222 total.
2. ✅ **Album data model + panel UI** — DONE 2026-06-13. `src/js/album.js` (Album class: add/remove/move/update/get/clear, 10 tests). Bottom panel repurposed (was stems placeholder) → "專輯母帶序列" list. Header "＋ 加入專輯" snapshots `engine.serialize()` + File + source LUFS. Per-row: #, title, LUFS, gain-trim input, gap input, ▲▼✕. Rows built via DOM+textContent (filenames user-controlled → no innerHTML, CSP-safe). E2E: add/reorder/remove verified, CSP clean. 232/232.
3. ✅ **Per-track offline render** — DONE 2026-06-13. Extracted `src/js/audio/render-chain.js` `renderMasterChain({engine, sourceBuffer, params, bypassed, sampleRate, linPhaseMag, dynamicsWorkletUrl})` as the SINGLE source of truth for the offline chain (export + album share it → no drift, addresses audit). Export rewired to call it (E2E: no regression, dyneq+linphase OK). `renderAlbumTrack(track)` decodes file at 44.1k (OfflineAudioContext) + folds gainTrim into masterVol + renders via shared chain. E2E: 44100Hz/stereo/non-silent. + `eqMagnitudeFromParams` helper. 5 unit tests + mock copyToChannel. 237/237.
4. ✅ **Album assembly** — DONE 2026-06-13. `src/js/audio/album-assembly.js` `assembleAlbum(tracks, sr)`: frame-aligned (588 samples) concatenation + per-track pre-gaps + PQ markers (startFrame, lengthFrames, startSec, isrc, title). 7 tests.
5. ✅ **Delivery writer — CUE + WAV image (NOT proprietary DDP descriptors)** — DONE 2026-06-13. **Honest scope decision**: WebSearch confirmed DDP 2.00 descriptor byte-layout (DDPID/DDPMS/PQ) is DCA-proprietary & not public → faking it = the exact 交付幻覺 SLOP the user guards against. So shipped the **verifiable** open CD-master interchange instead: `cue.js` (framesToMSF + generateCue, ISRC/UPC/CD-Text optional, injection-safe, 6 tests), `zip.js` (store-only + crc32, 6 tests), `md5.js` (RFC1321, verified vs all 6 spec vectors + node crypto, 6 tests). Album export button → render all tracks @44.1k → assemble → 16-bit dithered WAV image + CUE + MD5 → ZIP download. E2E: valid ZIP / 44.1k-16bit WAV / MD5 byte-matches node crypto / CUE 2-track. 262/262.
   - **Remaining (true DDP)**: proprietary descriptors need DCA spec or a verified open DDP writer to port. CUE+WAV is accepted by ImgBurn/Nero/most duplicators; many plants accept it or convert. Don't fabricate the .DDP fileset.
6. ✅ **Loudness pass** — DONE 2026-06-13. `loudnessTrim(measured, target, maxDb)` (clamped, silence-safe, 6 tests). "⇄ 對齊響度" button + target LUFS input: renders each track @trim0 → measures integrated LUFS → suggests per-track trim toward target (hybrid: starting point, user refines via the gain inputs). Trim folds into **limInput (pre-limiter)** so the true-peak ceiling still protects (no post-gain clipping). E2E: 2 tracks → both ~-14 LUFS, trims +2.3/-2.1 shown + editable. 268/268.

---
## ✅ PHASE 6 COMPLETE (6/6) — 2026-06-13
Album mastering + CD-master delivery. All TDD + E2E. 268/268 tests. New modules: render-chain, album, album-assembly, cue, zip, md5. Bottom panel = album sequencer (add/reorder/gap/trim/align/export). Delivery = CUE+WAV+MD5 ZIP (verifiable open format). **True DDP 2.00 descriptors deliberately NOT faked** (DCA-proprietary; see step 5).

## Risk notes
- DDP byte-exactness: validate against the DDP 2.00 spec; test descriptor byte layout with fixtures. Consider validating output with an open DDP reader if available.
- Memory: many tracks × decoded buffers. Decode lazily per-render, release after. Long albums could be large — render track-by-track, stream into IMAGE.DAT incrementally if needed.
- ZIP writer: store-only (no deflate) keeps it simple and is valid for DDP folder delivery.

## NOT in Phase 6 (later / needs backend)
- Tier-2/3 extras (true-peak limiter, imager, spectrogram, reference overlay) — separate phases.
- Phase-2 backend (Demucs/genre/IRC) — needs cloud platform decision.
