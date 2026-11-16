# Phone fix verification and handoff

Baseline `4bcfe6e29c200965013b6165546d69b8e1189a50`. Work stayed on rescue
`/home/kit/rust-renderer-spike`, branch `rust-renderer-spike`. No push, app build,
CI dispatch, Metro operation, other-worktree edit or phone-performance claim.
All implementation edits were made by this agent; coordinator review is pending.

## Diagnosis and implemented behavior

Read [the pre-edit diagnosis](phone-fix-diagnosis.md), with frozen source harness
[phone-baseline.cjs](phone-baseline.cjs) and output [phone-baseline.json](phone-baseline.json).
The source already scheduled playback continuously; the old busy callback count
did not prove missed intervals. Confirmed defects were missing explicit rate
preference, worker-time animation sampling, line-index scroll snaps, portrait
surface under controls, overlay diagnostics and misleading timestamp support label.

- `6d9838b`: display target clock, hardware-capped preferred range up to 120Hz,
  analytically integrated scroll, latest-input coalescing, one draw outstanding,
  asynchronous ordered retirement, capability/profiler separation, visual-rate
  anchor continuity and ABI v2. Shared blur remains GPU compute. Live rendering
  removes the intermediate completion/readback wait and retains one final worker
  wait to bound GPU work. Metal surface latency hint is 1 (two OS drawables).
- `6ebc0b2`: measured root/dock bounds clip portrait lyrics above all controls;
  initial/stale orientation bounds collapse the surface; landscape uses its
  existing separate safe pane. Diagnostics occupy normal scrollable layout space.
  Generated/built/source-app/IPA plist guards require Boolean true for
  CADisableMinimumFrameDurationOnPhone. Rate windows require at least one second.

Native changes require a rebuilt IPA; ABI 2 rejects an older native client.
The caller-owned Metro instance was left alone. JS delivery/transfer is a
coordinator action and has not been verified here. No new PNGs or phone captures
were produced by this job. Existing phase-1 PNGs are not evidence for this fix.

## Feasible checks

Run from the repository root unless a working directory is specified. Captured logs
and per-command exit codes are persisted as `phone-fix-*.log` and
`phone-fix-checks-{rust,js,ci}.json` in this directory. File content hashes are in
[phone-fix-files.sha256](phone-fix-files.sha256), excluding that manifest itself.

```sh
cargo +1.97.0 fmt --check --manifest-path native/lyrics-renderer/Cargo.toml
cargo +1.97.0 test --locked --manifest-path native/lyrics-renderer/Cargo.toml
cargo +1.97.0 clippy --locked --manifest-path native/lyrics-renderer/Cargo.toml --all-targets -- -D warnings
cargo +1.97.0 clippy --locked --manifest-path native/lyrics-renderer/Cargo.toml --lib --target aarch64-apple-ios -- -D warnings
npm --prefix ExpoLyrics run typecheck
# Working directory ExpoLyrics:
./node_modules/.bin/eslint 'app/(tabs)/index.tsx' components/lyrics/rust/rust-lyrics-view.tsx lib/rust-lyrics-protocol.js lib/rust-lyrics-protocol.d.ts
# Root; BASH32 names the existing real Bash 3.2 interpreter on this rescue host:
BASH32=/tmp/rust-bash32-src/bash-3.2.57/bash node --test scripts/test/ios-dev-ci.test.cjs
node native/lyrics-renderer/evidence/phone-baseline.cjs
/tmp/rust-spike-actionlint/actionlint .github/workflows/ios-development-build.yml
node scripts/check-repository.cjs
git diff --check
```

Also checked the public header with C11 `_Static_assert`s for KRMetrics size 88
and capability/animation offsets 80/84. The Rust ABI test checks the same layout.
Cargo.lock and dependency versions are unchanged. No app or release build ran;
Cargo tests/type-checking necessarily compile local test/check targets.

Results: 12 Rust tests; 22 Node CI/protocol tests with Bash 3.2.57 and 5.2.21;
fmt, host and iOS-target strict Clippy, TypeScript, touched-file ESLint, C header,
actionlint, repository and diff checks passed. Node regressions execute the
actual JS anchor/viewport functions and translated simple Swift source contracts,
including a 10,000-input burst retaining one pending drain and seek-snap intent.
They do not compile Swift or simulate a Metal/iOS runtime. Numerical Rust tests
exercise real scroll, timeline and scene/protected-band code. The measured layout
assertion covers geometric non-intersection and source wiring, not UIKit pixels.

## Remaining coordinator and phone checks

1. Independently review all code. Build the updated native client on macOS and
   inspect actual generated/built/IPA plist proof, final Mach-O symbols, link map,
   Expo provider registration and compiled JS path. Existing proof gates remain.
   Linux iOS-target Clippy proves Rust typing, not Swift compilation or linking.
2. Install/sign/launch the updated ABI 2 client and use the existing Metro path.
   Verify caption/diagnostics and lyric clipping in portrait and landscape, small
   screens, controls hidden/shown and debug panel expanded. Measure active canvas
   bounds and inspect screenshots; no overlap acceptance is inferred here.
3. Capture callbacks/submitted/busy/idle/inactive/noDrawable, interval estimates,
   requested Hz, delivered callback Hz and completed-present fps over real windows.
   Presented means acknowledged present calls, not measured screen scanout.
   Compare Low Power Mode, thermal state and accessibility Limit Frame Rate.
   A 120Hz preference cannot force 120fps. Actual reveal/scroll smoothness and
   GPU blur cost still need matched device capture/profiling.
4. Exercise ordinary line boundaries and gaps, overlapping leads, pause while
   settling, resume, visual rates 0.5/1/1.5, small/large scrubs, source reanchors,
   rapid track changes, foreground/background, focus, rotation and rapid remounts.
   Explicit scrub seeks snap intentionally; source jumps >250ms also snap.
5. Check background responsiveness and resource retirement. Main never waits for
   the worker, but a frame already submitted may finish and a driver stall can
   retain retired resources. One final worker GPU wait remains by design; these
   changes establish no sustained phone speed or leak-free claim.

Official Apple contracts and exact locked wgpu registry paths are recorded in
the diagnosis. Details of the implemented boundary are in
[INTEGRATION.md](../INTEGRATION.md) and [DESIGN.md](../DESIGN.md).
