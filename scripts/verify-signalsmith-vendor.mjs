// Offline verification; --write regenerates the single audited export patch.
// No compiler, install script, network, or external toolchain is invoked.
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const directory = new URL('../src/js/pitch/vendor/signalsmith-stretch/', import.meta.url)
const original = readFileSync(new URL('upstream/SignalsmithStretch.mjs', directory))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const blob = createHash('sha1').update(`blob ${original.length}\0`).update(original).digest('hex')
if (original.length !== 113867 || blob !== '7d5cae72e77a84143ed91ba12fc91b806dc4d9d1' || sha256(original) !== '97530b11d5bc01015af4cde40d6aa55ff10c40aa1294ca4c8c5762027d517a46') throw new Error('Signalsmith upstream bytes changed')
const marker = 'SignalsmithStretch = ((Module, audioNodeKey) => {'
const patch = '// WaveForge adapter patch: expose the bundled low-level factory; WASM unchanged.\nexport const createSignalsmithModule = SignalsmithStretch;\n'
if (original.toString().split(marker).length !== 2) throw new Error('Expected one export patch location')
const patched = Buffer.from(original.toString().replace(marker, patch + marker))
if (process.argv.includes('--write')) writeFileSync(new URL('SignalsmithStretch.mjs', directory), patched)
const actual = readFileSync(new URL('SignalsmithStretch.mjs', directory))
if (!actual.equals(patched)) throw new Error('Signalsmith derivative differs from the approved export-only patch')
const embedded = s => Buffer.from(s.toString().match(/data:application\/octet-stream;base64,([^\"]+)/)[1], 'base64')
const wasm = embedded(original)
if (!wasm.equals(embedded(actual))) throw new Error('Embedded Signalsmith WASM changed')
console.log(JSON.stringify({ upstreamBytes: original.length, upstreamGitBlob: blob, upstreamSha256: sha256(original), derivativeBytes: actual.length, derivativeSha256: sha256(actual), embeddedWasmBytes: wasm.length, embeddedWasmSha256: sha256(wasm), patch: 'Named export only; upstream wrapper is never called' }, null, 2))
