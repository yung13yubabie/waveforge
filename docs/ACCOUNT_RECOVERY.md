# Account outage and code cleanup — 2026-09-20

## Confirmed incident

The deployed account hostname returned NXDOMAIN. The linked Supabase project's management status was `INACTIVE`; normal `supabase.com` DNS worked. Resuming that existing project returned HTTP 200, followed by `ACTIVE_HEALTHY` and working project DNS. No project migration, replacement credentials, paid upgrade or user-session deletion was performed.

The app constructed the SDK client during module evaluation despite a “lazy init” comment. With an expired stored session, the real SDK repeatedly requested `/auth/v1/token` against the unreachable host. The browser regression reproduced the user's `Failed to fetch` stack before the fix.

## Repairs and cleanup

| Finding | Change | Verification |
|---|---|---|
| Configuration presence was treated as service readiness | Rename the flag to `SUPABASE_CONFIGURED`; abortable Auth settings probe before SDK construction, shared concurrent connection attempt, visible failure and manual retry | Expired-session/DNS-failure browser test; 401 and stalled-probe tests |
| Token refresh reloaded settings and the library on every event | Load only on account identity changes, outside the SDK auth lock | Real SDK refresh after advancing browser time; exactly one profile/library read |
| Logout retained account data and late reads could refill it | Clear account state on identity change and reject profile/library results for an old user | Logout and delayed-response browser regressions |
| Duplicate sign-in/sign-up wrappers and incomplete error handling | Call the appropriate SDK operation in one guarded submit handler; expose OAuth/logout errors | Incorrect-password UI test; OAuth completion itself not exercised |
| Two implementations of preset-to-control synchronization | Built-in presets use the existing shared UI synchronization function | Warm/Balanced presets assert each compressor band's exact values and EQ |
| Redundant configured-service branch and button assignments in stem separation | Keep the early guard and centralized busy-state update | Existing stem import/preview/Bounce regressions; live integration checked separately |
| Source-text regex tests could pass without a working login flow | Replace them with real SDK browser behavior tests | `npm run test:account` |

The deployment workflow now gates publishing on build, syntax, unit, account and audio browser checks. The stale June `.ai/HANDOFF.md` was replaced with current entry points and explicit remaining scope.

## Verification and limits

Build, syntax (100 JS files), 458 unit tests, 41 audio/UI browser tests, four configured-account browser tests and 14 production-build tests passed. Browser suites ran sequentially. Build retains the existing >500 kB chunk warning. The two old source-text assertions were removed and three connection unit tests added; test counts are not a quality score. Public-site verification artifacts are kept under ignored `outputs/account-release/` after deployment.

This is a scoped cleanup, not a claim that the entire repository is clean. `antitheft.js` remains large. Existing timeout wrappers in settings do not abort writes; account-scanning cancellation and later-in-session outages need further focused work. Startup preflight deliberately preserves the stored session and does not fabricate a signed-in state. A backend outage after successful initialization retains the SDK's normal retry behavior. Google OAuth, new-account email delivery and third-party browser extensions were not validated.

## Documentation used

Context Hub `supabase/client` was consulted first, but its fetched body describes an older SDK than this repository's 2.108.2. Implementation follows the installed SDK and official [client initialization](https://supabase.com/docs/reference/javascript/initializing), [project resumption](https://supabase.com/docs/guides/platform/free-project-pausing) and [restore API](https://supabase.com/docs/reference/api/v1-restore-a-project) references.
