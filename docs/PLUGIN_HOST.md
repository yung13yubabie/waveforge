# Plugin hosting status

Not implemented. Current processors are built-in Web Audio nodes and bundled worklets. There is no external plugin loading button or claimed VST compatibility.

Online plugin hosting should use WAM 2 with explicit URL consent/allowlist, parameter and MIDI ownership, saved state, latency reporting and failure placeholders. Native VST3/ARA requires an optional native bridge; ordinary browser hosting cannot load arbitrary installed binary plugins. These are architecture constraints, not completed abstractions.
