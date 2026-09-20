# Persisted state currently implemented

There is no complete saved Project/Session format yet. Do not treat a mastering preset as a saved DAW project.

AudioEngine snapshot v2 contains `params`, `bypassed` and `abMode`. Canonical compressor state is `mbcThresh[3]` / `mbcRatio[3]`; canonical master gain is `masterOutputGainDb`. Monitor gain is not serialized into processing snapshots. v1 global compressor threshold/ratio and linear `masterVol` are migrated by `restore()`.

The existing History holds processing snapshots and user presets use localStorage. Audio File/PCM, stems, album media, current file ownership and waveform objects are not persisted or copied into History. Full Project/Track/Clip/Asset, relinking, autosave and recovery remain Phase B work, with missing asset references required to remain explicit.
