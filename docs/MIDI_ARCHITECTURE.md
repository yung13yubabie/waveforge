# MIDI / instruments status

Not implemented. Current transport plays a single audio master or a synchronized four-stem preview. There is no MIDI recording, piano roll, synth, sampler, tempo map or MPE support.

These require the Project/Track/Clip foundation first. MIDI events need stable timing, note/channel identity and per-note expression; instrument and plugin state must be saved and shared by realtime and render. Web MIDI device support and permission are browser-dependent and have not been tested in this checkpoint.
