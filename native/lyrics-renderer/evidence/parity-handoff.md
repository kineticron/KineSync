# First actual Skia comparison milestone — review gate

Audit commit `21ab723` precedes capture implementation. Baseline production bytes
remain exactly `a9b6398`: no src/shader/protocol/Swift/JS view/controls/clipping/
Cargo.lock/Cargo.toml/ABI changes. ABI3, two bounded GPU frames, half-size blur,
full-size sharp glyphs, nonblocking completion and premultiplied transparency are
preserved. No push, CI dispatch, native app build, Metro, browser operation or
other-worktree edit. Sole editor; no delegates. Applicable ancestor instruction
files checked before edits; none in scope.

## What is reviewable now

- [Source-linked parity matrix and phased plan](parity-matrix.md) with baseline
  [source hashes](parity-source-manifest.json). Existing Spicy and AMLL are distinct
  targets; no generic hybrid or claim of completed parity.
- [Executable capture](parity-capture.cjs) bundles this checkout's **actual**
  `NativeSkiaVoice` preparation, `buildNativeVoice`, wrapping helpers,
  `shapeGlyphWords`, `drawVoice` and motion equations. It executes those functions
  against real Skia CanvasKit paragraphs, glyphs, pictures, blur filters and shader
  paints. React hooks provide deterministic host state; they do not fabricate ink.
  CanvasKit's unavailable extendedVisit is adapted from real shaped runs/font
  IDs/positions/bounds, as in the repository's existing CanvasKit harness.
- [Rust example](../examples/parity-capture.rs) feeds the **actual** production
  TrackPacket/TrackScene/Gpu renderer. Same original source syllables and timing,
  declared viewport/DPR and final time. Each production model retains its own
  spacing transformation; those are recorded separately, not normalized away.
- Twelve comparisons: both styles, existing fixture lines 1 Korean and 9 Latin,
  portrait 390x640 at DPR 1/3, landscape 844x390 at DPR 1. Eighteen original PNGs
  (12 Skia, six unchanged Rust), 12 three-column zoom/difference PNGs and one contact
  sheet: **31 published PNGs** with [paths and SHA256](parity-png-manifest.json).
  Full-size originals remain available even when a sheet displays logical pixels.
- [Capture manifest](parity-capture-manifest.json) records fixture/source/package/
  WASM/font hashes, actual per-voice Skia family names, original tokens and model
  words, exact timestamps, complete 120Hz warmup/dt history, settings, declared lane
  origins/widths, production font parameters, image paths and hashes.
  [Comparison report](parity-comparison-report.json) contains unregistered same-
  viewport alpha/RGB differences. No registration, tolerance or pixel acceptance
  gate was used to conceal layout/appearance differences.

## Visual inspection and limits

Inspected the portrait contact sheet (all four case/style combinations), individual
portrait Korean/Latin outputs, landscape Latin Spicy and 3x Korean AMLL zoom sheets.
Rust uses visibly heavier Korean strokes. Latin wraps differ substantially: Spicy
puts `Du,` above the grouped remainder; AMLL balances the remainder over two rows;
Rust breaks the sequence at a different point. Baselines/origins, active fill edge,
unsung alpha and glyph widths also differ. Landscape Rust has a large centered-lane
x offset relative to this host-selected reference lane. These are useful starting
observations, not completed parity or native pixel-diff acceptance.

**Scope is isolated active voice.** Lane x28/y0.37H, widthW-56 is explicit host
configuration, not a measured Yoga screen. The component's real paragraph width
adjustments still execute within that lane. Both reference and baseline capture
isolated content, not a whole-screen arrangement. Outer native row/view opacity
and row transforms, next-line/progressive shared blur, attribution/touch and
auxiliary rows are not exercised. AMLL bright/dark/scale are explicit 0.85/0.5/1
inputs, not a replay of the line transition. Full-screen Skia reference remains
blocked on native UIKit/Yoga execution on this Linux host.

The existing SF Pro Regular/Bold assets are read **in place**, never copied or
added. Latin actually uses SF Pro Display; Korean uses explicit Linux fallback
Noto Sans CJK JP (first face of installed TTC), with spaces from SF Pro. The
paragraph boundary appends that fallback family and rejects every glyph 0.
Rust selects system Noto Sans CJK KR with weight 800; candidate system TTC hashes
are recorded, not falsely called per-glyph font attestation. iPhone fallback and
packaged Rust fonts need independent device proof. The first attempt exposed
missing Korean glyphs; explicit fallback and glyph 0 assertions corrected the
harness before publishing accepted evidence.

[Native capture plan and located ci-sim resources](parity-native-capture-plan.md)
describes the next test-only integration. No simulator workflow or native capture
implementation is claimed. Existing ci-sim's screenshot settle advances animation
at a frozen song position; it must be adapted before a moving-state comparison.
Device-only Rust CI slice guards must stay intact. Coordinator owns the next
native integration/review/build/dispatch and one active meaningful run.

## Reproduce and checks

From repository root, using installed dependencies and Rust 1.97.0:

```sh
node native/lyrics-renderer/evidence/parity-verify.cjs /tmp/rust-parity-verified
node native/lyrics-renderer/evidence/parity-publish.cjs /tmp/rust-parity-verified /files
```

The verification script compiles only local Rust checks/examples/headless captures;
no Expo app build. PIL/numpy and fontconfig are existing host tools. Source/PNG
hashes are checked before publication; two independent capture runs must produce
identical renderer PNG hashes. Publication preserves prior phone evidence.

[Verification command ledger](parity-verification.json): all 18 command checks pass,
plus independent byte-identical capture hashes. **17 Rust tests /23 Node tests**;
fmt; strict all-target host and aarch64-apple-ios Clippy; TypeScript; touched-view
ESLint; actionlint; repository checks; production-runtime unchanged check. Actual
GPU alpha/premultiplication/blur/sharp/resize-clear readback still passes at 1x/3x:
[1x](parity-alpha1.json), [3x](parity-alpha3.json). Rust tests include actual two-frame
GPU ownership and deterministic clock/gating tests. Native Swift is not compiled
on Linux. Logs are `parity-*.log`, SHA256 listed in the PNG manifest.

[Raw pre-parity benchmark](parity-baseline-benchmark.json): Linux Vulkan llvmpipe
CPU adapter, default dev opt0, 30 samples + 6 warmup/orientation, nearest-rank
percentiles. CPU scene p50/p95: portrait 0.05569/0.09319ms, landscape 0.05268/0.08592ms.
CPU encode p50/p95: portrait 28.9164/37.2243ms, landscape 26.4833/29.9352ms. This is an
unchanged **host proxy baseline**, not a phone result, speedup, GPU duration or
physical 120fps proof. There is no runtime before/after delta at this milestone.
The prior accepted phone present-call/encode report remains independent.

## Pending matrix and next review

DPR 2, additional CJK/RTL/longword/grapheme cases, timing phases/release, auxiliary
translations/romanization/BGV/duets/overlaps, active-next protection, finite gaps/
interludes, attribution callbacks, settings invalidation, pause/seek/resume and
rotation are **pending**, not implicitly covered by the 12 captures. Existing
runtime regressions are checked independently; that does not establish visual
parity in these unimplemented cases.

Stop here for coordinator review of the first actual screenshot milestone, per
request. Next coherent implementation is distinct style/font/geometry transport
and cached typography/layout, based on these measured gaps. Any ABI/payload change
needs updated Rust/native/JS/C guards and a coordinator-built IPA after review.
