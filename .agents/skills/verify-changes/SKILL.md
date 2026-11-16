---
name: verify-changes
description: Select verified KineSync checks by touched paths without repeatedly scanning the repository.
---

Read AGENTS.md for the repo map and exact commands. Run from the repository root with existing dependencies.

For native/lyrics-renderer/ changes, run the three cargo +1.97.0 commands in AGENTS.md for formatting, all-target clippy, and tests. Shader changes also need the relevant GPU or device visual check. Host tests alone are not visual proof.

For ExpoLyrics/ TypeScript, JS, or packet integration changes, run (cd ExpoLyrics && npm run typecheck) and (cd ExpoLyrics && npm test).

For touch handling, scroll behavior, ExpoLyrics/lib/rust-lyrics-gesture.js, or ExpoLyrics/modules/kinesync-rust-lyrics/ changes, additionally run node ExpoLyrics/scripts/check-rust-gestures.cjs. Swift cannot be compiled by the Linux checks. Verify the custom development IPA on iOS.

For an ABI contract change, check all four ABI locations named in AGENTS.md, run both the Rust and Expo checks plus the gesture check, then rebuild the custom development client.

For scripts/ or .github/workflows/ changes, run node --test scripts/test/*.test.cjs, node scripts/check-repository.cjs, and node scripts/release-version.js. These do not validate every workflow runtime. Review changed shell or workflow syntax separately.

For documentation-only changes, run node scripts/check-repository.cjs, node scripts/release-version.js, and git diff --check. Verify every documented path and command. Do not rebuild an IPA or interrupt Metro for docs.

Run git diff --check for every change. Record actual results and blockers. Do not fix unrelated failures or claim unrun checks passed. Keep commits small and never push main.
