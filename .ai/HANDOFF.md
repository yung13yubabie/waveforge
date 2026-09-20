# WaveForge — current handoff

Updated 2026-09-20. This replaces the obsolete June handoff (old password gate, mirrored render chain and test counts no longer apply).

- Online Vite/Web Audio app. Production: https://yung13yubabie.github.io/waveforge/
- Current audio/control work and remaining Full DAW scope: `docs/AUDIO_TRUST_CHECKPOINT_2026-09-20.md`.
- Account incident and cleanup: `docs/ACCOUNT_RECOVERY.md`.
- Build configuration is public `VITE_*` data, injected in GitHub Actions; never put service-role or management keys in client code.
- `SUPABASE_CONFIGURED` means URL/key are present. `backend-connection.js` checks Auth settings before creating the SDK client. Outage at startup retains stored sessions and requires explicit retry.
- Auth callbacks stay synchronous, defer database reads and load only on identity changes. Logout clears account data; late profile/library reads check identity before applying results.
- `main.js` uses one `syncUIFromEngine()` for presets/history. Real-time and offline rendering share `audio/processing-graph.js`.

Verification: `npm run build` → `npm run lint` → `npm test` → `npm run test:e2e -- --workers=1` → `npm run test:account` → `npm run test:production`. Browser suites run sequentially. Account tests use a fake endpoint with the real Supabase SDK and test-only sessions.

Remaining: full DAW phases are not complete; see checkpoint. `antitheft.js` still combines account UI, settings and scanning; further extraction needs behavior tests. This fix prevents startup-outage refresh storms; a service that fails after successful initialization still uses the SDK's normal retry behavior. Real Google OAuth and musical-quality evaluation are not covered by mocked account tests.
