# Current audio graph

Source PCM → HP/LP (explicit bypass) → ten-band EQ → Dynamic EQ → M/S → de-esser → MBC → saturation → limiter (explicit bypass) → master output gain.

MBC wet: subtractive three-band crossover → native compressors → makeup → wet gain. Dry: sample-aligned delay → dry gain. MBC bypass sets dry delay to zero and mutes wet.

Realtime master output joins the original comparison branch at `monitorBus`, then feeds spectrum/LUFS/correlation and monitor gain. The original branch bypasses master output gain and compensates active native compressor/limiter delay. Saturation latency remains uncalibrated. Offline render connects master output directly to the render destination and allocates no monitoring nodes.

Final deliverable adds watermark, optional true-peak limiting, measurements, then integer headroom gate and encoding. Preview/master/album use `renderFinalMaster`; album assembly has another overload check after sequencing.

Stem input routes through EQ and compressor only when explicitly enabled, then pan and effective mute/solo/volume. Preview and Bounce use the same builder. Track processing has no independent persisted session yet.
