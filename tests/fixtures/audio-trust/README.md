# Synthetic audio-trust regression fixtures

All signals in `signals.js` are original, deterministically generated Float32 PCM.
There are no user recordings, licensed voices, externally uploaded files or model outputs.
Keeping generators in the repository preserves exact input construction without large binaries.

Cases and intent:
- `lateMajorChord`: 3 seconds silence, 27 seconds C-major triad; analysis must sample beyond the intro
- `terminalImpulse`: positive/negative impulse in the last 12 samples; detects unflushed FIR state
- `interSampleSine`: fs/4 sine with 45-degree phase and adjustable amplitude; exercises ISP overshoot
- `tonalBalance`: identical 500/1000/2000/4000 Hz components at 44.1/48/96 kHz; catches wrong-rate analysis

`npm run test:audio-trust` runs the no-dependency Node regression runner.
Vitest and browser tests also import these generators. The limits are explicit:
same-estimator peak checks establish a software invariant, not independent ITU/EBU certification;
pure chords do not prove accuracy on real singers, harmony, modulation, or noise.
