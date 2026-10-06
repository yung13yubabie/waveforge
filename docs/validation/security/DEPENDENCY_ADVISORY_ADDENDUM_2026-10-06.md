# Dependency advisory addendum · 2026-10-06

## Result and scope

The fresh npm registry audit returned **5 moderate affected package nodes, representing one underlying advisory**, with no high or critical findings. The advisory is **not fixed**. Its vulnerable formatter is excluded from the inspected browser bundle, and no attacker-controlled format-string path was found in the installed Node dependency use. This supports a scoped exception for the current static-browser deployment, not a blanket security guarantee.

No dependency, lockfile, application code, installation, commit or publication was changed by this investigation. Only this addendum and the accompanying sanitized audit JSON were added. Earlier evidence remains unchanged.

## Reproducible evidence

- Checked at approximately `2026-10-06T06:53:36Z`; checkout `3c23d27c747040e020d767068abda5479a869f5c`
- Lockfile SHA-256: `725927bac091e38be141324007c197e8e93cee5faf84c9ace93fc0e3c1940098`
- Environment: Linux x64, Node `v24.19.0`, npm `11.9.0`; installed `node_modules` is a symlink to the existing `waveforge-next/node_modules` tree. The five relevant installed versions were checked against the active lockfile
- Command: `npm audit --json --ignore-scripts --package-lock-only --fetch-retries=0 --fetch-timeout=20000`
- Registry: `https://registry.npmjs.org`; exit status `1` because advisories were found
- [Sanitized audit output](npm-audit-2026-10-06T065336Z.json): warning/log text removed and JSON whitespace normalized; advisory fields and counts preserved
- Independently read [CI run 37424205472, job 112140048269](https://github.com/yung13yubabie/waveforge/actions/runs/37424205472/job/112140048269): at `06:31:45Z`, `npm ci --ignore-scripts` reported 199 added / 200 audited packages and 5 moderate findings. CI used Node `22.23.3`. The overall job later cancelled in browser regressions; this audit makes no CI-pass claim

The lockfile audit enumerates 249 dependency nodes, including cross-platform optional packages (64 prod, 159 dev, 60 optional in npm's overlapping categories). A platform-filtered installed inventory is different from a complete lockfile inventory. Crucially, **none of the five affected nodes is marked dev or optional**; `onnxruntime-node` supports Linux, macOS and Windows. The findings cannot be dismissed as optional binaries for another OS.

## Advisory, chain and exploit conditions

[GHSA-hp3w-g68c-fv3c / CVE-2026-97058](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) affects `sprintf-js <=1.1.3`. GitHub records publication on **2026-09-24** and review/update on **2026-10-05**. npm reports CVSS 3.1 `5.3`; the advisory page also displays CVSS 4.0 `6.9`. Both are Moderate.

The exact production dependency chain is:

`@huggingface/transformers@3.8.1 → onnxruntime-node@1.21.0 → global-agent@3.0.0 → roarr@2.15.4 → sprintf-js@1.1.3`

An attacker must control the formatter's **format string**, not merely data being logged. Oversized numeric precision can throw a `RangeError`; an uncaught exception can abort the caller. See the [upstream report](https://github.com/alexei/sprintf.js/issues/237), opened **2026-09-16**. No exploit was executed against an external service.

### Browser path: excluded

- `src/js/lyrics/whisper-worker.js` imports `@huggingface/transformers`
- Its installed `package.json` selects `dist/transformers.web.js` for the default/browser export; the separate Node export selects `transformers.node.mjs`
- The web build contains an explicitly ignored, empty `onnxruntime-node` module. Its two occurrences in the emitted worker are ignored-module/import comments, not an included Node implementation
- Inspected `dist/assets/whisper-worker-tz7eGvin.js`, SHA-256 `ff708681f66edcacf39f0e83fd8f3694ecb4c8b65d0b05204cd1e41873fabc0a`, and all emitted JavaScript: no `sprintf-js`, `global-agent`, `roarr`, `ROARR` or `sprintf` implementation markers. The worker contains the ONNX web backend
- This combines export/stub evidence with bundle inspection; absence of a text marker alone is not treated as proof

### Node/install path: present on disk, no vulnerable input path identified

- `onnxruntime-node/script/install.js:26–31` imports and bootstraps `global-agent` for binary-download proxy support. No `global-agent`, `roarr` or `sprintf-js` reference was found in the package's normal `dist/*.js` runtime
- CI explicitly uses `npm ci --ignore-scripts`, so that install hook is not executed. A regular install without this flag is a different exposure and must not inherit this conclusion automatically
- `roarr/dist/factories/createLogger.js` does call `sprintf`, but the reviewed `global-agent` logging sites use fixed message literals; URLs, headers and errors are passed as structured context. No untrusted format-string path was found
- `scripts/verify-lyrics-model.mjs` uses Node inference separately. Importing that runtime is not the same as executing its postinstall hook

## Why an earlier audit said zero

The retained [earlier audit snapshot](npm-audit-2026-10-06.json), checked at `00:46:21Z`, genuinely records zero findings for the **same lockfile hash and 249-node inventory**. Its underlying saved output and the prior `2026-10-05T14:29Z` patched audit both contain zero findings and identical dependency metadata. The current positive result supersedes zero as the current advisory status.

The advisory's October 5 review/update is consistent with registry/advisory-data propagation changing results, but these records do not prove the exact propagation or caching cause. Platform omission cannot explain this zero-to-five difference because the older and current lock-level inventories match. Do not relabel the old snapshot as a fabricated run, or continue presenting it as current assurance.

## Compatible remediation status

There is **no published patched `sprintf-js` release to pin** as of this check. The official advisory lists no patched version. A read-only npm metadata query confirmed latest remains `1.1.3`, published `2023-09-11T13:12:09.207Z`, with:

- Tarball: `https://registry.npmjs.org/sprintf-js/-/sprintf-js-1.1.3.tgz`
- Integrity: `sha512-Oo+0REFV59/rz3gfJNKQiBlwfHaSESl1pcGyABQsnnIfWOFt6JNj5gCog2U6MLZ//IGYD+nA8nI+mTShREReaA==` (matches lockfile)
- Audit `fixAvailable: false` throughout this chain

Therefore no legitimate narrow version-only override or lock patch is proposed. Do not invent a patched version, downgrade to another affected release, or use `npm audit fix --force` to clear the headline. Preserve the browser export, ignored install scripts and fixed-format logging constraints; re-evaluate when an upstream fix or verified chain-removing compatible release exists. A wider ONNX/Transformers replacement requires its own compatibility and browser-inference validation.
