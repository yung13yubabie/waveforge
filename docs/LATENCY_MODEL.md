# Native processing latency — current scope

The native DynamicsCompressor pre-delay is modeled as `floor(0.006 * sampleRate)` samples: 264 at 44.1 kHz, 288 at 48 kHz, 576 at 96 kHz. Chromium impulse tests validate equal dry/wet peak positions for MBC mix 0/25/50/75/100. An inactive compressor removes its compensating delay.

The original realtime A/B path compensates the sum of active MBC and limiter pre-delays. This is not a general plugin delay compensation engine. Bypass changes can change timeline latency; musical timeline/clip compensation and render tail preservation are not implemented.

WaveShaper 4x oversampling delay is implementation-dependent and not yet calibrated across browsers. No claim of full sample alignment when saturation is active. See [W3C processing details](https://www.w3.org/TR/webaudio/#DynamicsCompressorNode) and [WaveShaper oversampling](https://www.w3.org/TR/webaudio/#WaveShaperNode).
