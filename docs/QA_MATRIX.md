# Current regression matrix

| Surface | Verification | Limits |
|---|---|---|
| Slider/number/reset | Native UI, invalid/empty input, pre-load setters, screenshot | No touch-device hardware run |
| Source upload | Chinese filename, visible waveform, corrupt replacement recovery | WAV fixture; real user audio not provided |
| Four stems | Chinese four-file import, missing files, EQ enable/edit, live preview, Bounce/download, source invalidation; deployed Demucs returned four decodable stems | Cloud checked with a 0.5-second synthetic WAV only; musical quality/long-file throughput not verified |
| Master parity | 135 signal/state combinations, WAV preview/download sample residual | Shared builder cannot establish independent algorithm correctness |
| Native rate | 96 kHz WAV containing a 30 kHz component retains expected RMS/rate | Non-WAV formats remain browser-rate fallback |
| Bypass | Independent impulse residual for all modules bypassed | Saturation processing latency not calibrated |
| MBC latency | 44.1/48/96 kHz impulse at five mix values | Chromium only |
| Monitor | Export impulse unchanged at 100/50/10% | No physical monitor-loop measurement |
| Delivery | Overload blocks download; explicit hard-clip opt-in; actual WAV/MP3 download | Post-codec QC and independent true-peak reference pending |
| Production | Same real UI paths against built `dist` | No dev-only graph imports in production tests |

Final command results are recorded in [the checkpoint](AUDIO_TRUST_CHECKPOINT_2026-09-20.md). Firefox/WebKit, long sessions, external devices, saved projects and true vocal reference datasets are NOT RUN / not implemented; this matrix is not full DAW acceptance.
