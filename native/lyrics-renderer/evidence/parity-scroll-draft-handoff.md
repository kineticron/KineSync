# Run18 Spicy scroll draft — disabled, not an accepted feature

## Resumed compact checkpoint, 2026-11-14

User authorized lean checks after coordinator-only cleanup. The gate remains
**false** and ABI6 approved runtime behavior remains selected. Corrected one
disabled-candidate mismatch: interrupted snapped-command duration now uses
the distance between command targets, as `applyScrollCommand` does, while
position continuity still samples the interrupted tween. This does not port
manual drag, geometry-command springs, command serials or target ownership.

`test/scroll-timing.json` records 24 duration and 7 easing samples obtained by
transpiling and calling the actual bundled `reference-motion.ts` exports with
the installed TypeScript compiler (CommonJS, esModuleInterop). The source SHA256
is embedded and checked by the Rust test. Inputs cover interval100/430/800ms,
interlude true/false, logical distances0/100/600/900 and easing endpoints plus
60/120Hz and irregular progress samples. These are helper samples, **not**
60/120Hz trajectory, Reanimated runtime or actual-Skia goldens. A regression
test distinguishes command distance from the remaining animated distance.

Fresh release library tests: **39 passed, 6 ignored**, including all5 draft
scroll tests. The ignored tests are opt-in GPU/performance gates. Strict host
release all-target Clippy, cargo fmt and23 Node ABI/client contract tests pass.
Strict `aarch64-apple-ios --lib` Clippy also passes (cross-check only; no iOS
link, package or device run). Final free space:8.3GB. No builds remain running.
Fresh logs use `parity-scroll-checkpoint-*.log`. Historical disk-stop results
below remain the record of Run18; this section supersedes their final-source
compilation status only. No render, GPU/performance or physical-phone result
is carried forward as validation of this draft.

Checks select `RUSTUP_TOOLCHAIN=1.97.0`, `CARGO_INCREMENTAL=0`,
`CARGO_PROFILE_DEV_DEBUG=0`, `CARGO_PROFILE_TEST_DEBUG=0`, `CARGO_BUILD_JOBS=2`.
Cargo uses `--locked --offline` and the existing target directory. Release
tests reuse release dependencies; host Clippy checks release targets. No new
dependency, duplicate target directory, cleanup or deletion was introduced.

Reproduction from repository root with the environment above:

```sh
cargo test --manifest-path native/lyrics-renderer/Cargo.toml --locked --offline --release --lib
cargo clippy --manifest-path native/lyrics-renderer/Cargo.toml --locked --offline --release --all-targets -- -D warnings
cargo clippy --manifest-path native/lyrics-renderer/Cargo.toml --locked --offline --target aarch64-apple-ios --lib -- -D warnings
cargo fmt --manifest-path native/lyrics-renderer/Cargo.toml -- --check
node --test scripts/test/ios-dev-ci.test.cjs
git diff --check
```

Coordinator comparison script at `4386429` remains **unfinished/unmerged**:
replay CLI, manifest provenance and build preflight still require fixes and
independent kitten PASS before coordinator merge. Cached numeric diagnostics
are not proof. Latest user steering resumes LOW for those fixes; this MEDIUM
checkpoint made no comparison-script edits or LOW turns.

Fresh live helper at this batch boundary: weekly14% remaining / primary98%
remaining; final fresh read: weekly13% / primary94% remaining.
Wrap at approximately10%; one IPA at approximately5% remains solely
coordinator-owned. No push, merge, CI, Metro, IPA, extra agent or reset credit.
All remaining enablement requirements below still apply.

Parent approved runtime checkpoint: `5fcb29b` (ABI6). Coordinator reports its
independent ABI6 review approved with no blockers. This new source checkpoint
is a **draft**, with `SOURCE_SPICY_SCROLL_ENABLED = false`. It retains the old
critically damped scroll and height*.37 anchor for both providers. Glow remains
OFF. No ABI/schema/C/JS/Swift layout change or phone architecture change.

## Source work saved

`src/motion.rs` adds a fixed-size, allocation-free Spicy viewport tween candidate
from the actual `ExpoLyrics/components/lyrics/native/reference-motion.ts`
`spicyScrollDuration` / `spicyScrollEasing` and `reference-scroll.tsx`
`applyScrollCommand`. It uses the existing Rust 24-iteration cubicBezier port,
logical-point distance (physical distance / DPR), 240–440ms duration, and
samples the previous tween before retargeting from its current position.
Native milliseconds continue while playback pauses; explicit seek/generation
reset uses the existing native owner reset; geometry remap preserves relative
position and velocity for the legacy path and affine endpoints for the draft.

`scene.rs::scroll_anchor` drafts the actual non-preview Spicy native FlashList
anchor from `native-lyrics-view.tsx::scrollTo`: portrait0 / landscape32 logical
points. `timed_scene.rs` uses the same anchor for drawing and the single shared
protected envelope. The false gate retains the old anchor everywhere.
`ffi.rs` wires a SourceScroll owner that delegates to the exact old Scroll when
the gate is false. No scene/cache/GPU pass, half-res blur, two-inflight bound,
GPU wait, frame JS message or preparation ownership changes.

This is native Spicy source behavior, not the DOM center-scroll helper.
AMLL retains its old behavior: its actual current source uses
`simple-amll-motion.ts` history segments and delayed row samples. A single
viewport spring cannot claim that parity. No substitute AMLL delay was added.

## Disk stop and validation limits

The user ordered all Cargo/build/test/Clippy/render work stopped due to rescue
space (~909MB then908MB free). The single already-started local Cargo command
had completed in3.46s before the stop check; no Cargo/rustc process remained.
It compiled the initial *ungated* draft and ran2 **existing** motion tests.
See `parity-scroll-draft-initial-compile.log`. It did not run new source-scroll
tests and is NOT proof that this final gated draft passed compilation/checks.

After the disk instruction, only source inspection/editing, direct rustfmt,
`git diff --check`, the existing lightweight Node contract suite and the live
budget helper ran. Direct rustfmt checks and whitespace checks pass. Node:
23 tests passed,0 failed (`parity-scroll-draft-node.log`). New Rust draft tests
are saved for retarget continuity, pause settling, seek reset, DPR distance,
geometry remap and the disabled gate; **not run**. No post-stop Cargo, Clippy,
GPU render, benchmark, dependency install, cleanup or deletion. Final source
has NOT passed host/iOS strict Clippy, regression/GPU/performance gates or TS
in this run. Existing approved ABI6 results belong only to its prior commit.
No PNG/milestone/acceptance receipt was produced for this unvalidated draft.

## Required before enabling

Generate numeric goldens using the actual bundled production scroll helpers,
including cue retarget, 60/120Hz irregular histories, native pause, explicit
seek and rotation. Verify first-cue/top-padding/FlashList first-item semantics
and exact source-selected target ownership with overlap and gaps. The current
Rust latest-start focus is not full source playback-window/overlap policy;
this draft does not resolve BGV or finite-interlude ownership. The interlude
flag only selects the source440ms duration; it is not an implemented interlude
or the DOM dot-line240ms delayed scroll. Do not enable on that basis.

Then run complete Rust tests, strict host+iOS Clippy, ABI/C/JS/TS contracts,
source alignment/protection pixel checks and interleaved90-sample effect gates
with zero warmed invoking-thread scene allocations. Do not use the parent
comparison script4386429 as a gate (unreviewed/provenance incomplete).

## Remaining matrix and coordinator boundary

Unfinished: accepted Spicy scroll; AMLL delayed trajectory/history; finite
interludes; BGV/duet/group focus; independent romanization; exact complex/color
glyphs; native footer/touch/accessibility; source font/raster equivalence;
actual Skia numeric acceptance and full native capture; ABI6 physical phone
HUD/performance. No actual-Skia or physical performance claim is made.

Latest direct live helper: weekly14% remaining / primary37% remaining.
Start wrap at~10% weekly. Coordinator owns the one IPA preparation by~5% and
disk-space decisions. No push, merge, CI, Metro, IPA, extra threads, comparison
edits, reset credits or cleanup by this worker. This draft must not be
represented as an accepted new runtime effect in that build.
