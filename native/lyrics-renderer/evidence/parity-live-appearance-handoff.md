# ABI5 live fill/motion checkpoint — independent review handoff

The actual iOS `kr_render` path now calls separately owned source timing and the
new glyph renderer. **Live policy is Motion (fill + scale/float), for distinct
Spicy and AMLL settings. Glow remains OFF.** Its actual-glyph prototype uses the
existing near/far Gaussian bases, with two-radius mixing/clamping; it is not an
exact Skia variable-radius glow. No visual-parity or physical120fps claim.

## Implementation / source trace

- `ExpoLyrics/lib/rust-lyrics-preparation.ts` transports actual `buildNativeVoice`
  emphasis, pivot, RTL, last-word and AMLL group start/end/index/count/last.
  Source: `native-lyrics-model.ts:84-91,132-148`, `spicy-text-policy.ts`.
  Schema/ABI5 guards agree in JS, Swift, Rust and C tests; metrics stay152 bytes.
  Rust validates finite/bounded pivots/groups and existing ICU UTF16/UTF8/grapheme
  mapping. Actual AMLL whitespace can make group index+letters exceed count;
  preserving that source behavior is intentional, with absolute size bounds.
- `src/appearance.rs` owns mutable per-native-owner word/letter springs, AMLL
  scale/brightness/release clock and source outer-opacity easing. Geometry caches
  contain no mutable playback history. Track/seek-snap/resize reset appearance;
  ordinary pause permits finite source release/settling. Timing math is pinned
  by `style-timing.json`; reveal-only now checks the same80 source frames.
- `src/timed_scene.rs` records immutable glyph IDs/positions/font runs only when
  near-active geometry is prepared; active/overlapping + next2. It draws source
  Spicy word/letter reveal/scale/lift and AMLL continuous word advance, group
  emphasis/float, line scale and filtered brightness. Expected draw behavior:
  `native-glyph-picture.tsx:282-382`; reveal extent/row continuation:
  `native-glyph-layout.ts:28-51`; timing: `reference-word-motion.ts` and
  `reference-motion.ts`. Plain inactive rows append cached static paragraphs.
  This is geometry ownership, not the rejected animated glyph-picture cache.
- Owned glyphs retain ink overhang without a redundant slice clip; shared
  ligatures/marks retain clips. Exact complex-script ink bounds, overlap union
  and color/emoji glyph behavior remain incomplete; no same-font/native parity
  is claimed. Spicy reveal uses each letter extent; AMLL letters share their
  syllable-row reveal origin, including continuation widths.
- `src/composite.wgsl` decodes packed sharp-opacity/emission channels to white
  linear premultiplied RGBA. Same full-resolution sharp, half-resolution blur,
  two strengths, single shared moving active/next envelope, same textures and
  passes. No per-line filters, global resolution reduction, GPU completion wait,
  deeper queue, active-picture cache or epsilon redraw gating. Uniform update
  uses16 stack bytes. Stable source scene/updater frames allocate zero on the
  invoking application thread; preparation on window changes is explicitly not
  covered by that zero-allocation claim.

## Performance gate / rejected experiments

[Raw final90-sample pairs](parity-live-appearance-budget.json),
[human table](parity-live-appearance-table.md). One Vulkan llvmpipe adapter,
identical actual song/helper/font inputs per pair, portrait390×640 and
landscape844×390, DPR1, both styles;8 warmups,90 samples per stage, alternating
before/after order. Separate Baseline→Fill, Fill→Motion, Motion→Glow. Baseline
bypasses all appearance-state work. Fixed thresholds: scene p50 <= before*1.25
+0.01ms; encode p95 <= before*1.25+0.5ms; zero steady scene allocations.
All12 final pairs passed; enabled stages are Fill and Motion. The final full
release test run also passes the gate. Live policy remains conservatively Motion.

Earlier30-sample measurements rejected redundant-clip fill cost and later showed
inconsistent llvmpipe encode outliers (including Spicy motion/glow). Those raw
results are retained as `parity-live-appearance-rejected-preclip.json` and
`parity-live-appearance-rejected-30-sample.json`; they are not discarded as passes.
Clip removal was a runtime optimization. Increasing to a fixed90 samples was a
measurement change to reduce sparse tail instability, **not** a threshold change.
A first90-sample run passed, then the final current-source release run passed.
Glow is still a prototype awaiting exact appearance/numeric work and review.

Final scene p50 is0.009–0.012ms for the enabled Motion cases; encode p95 is
16.63–23.19ms on this CPU Vulkan adapter. These release-opt3 host numbers do not
predict the accepted phone opt1 baseline. Raw explicit wait/readback, wall and
optional timestamp intervals are reported separately. Timestamp brackets include
queue gaps and are not isolated GPU execution times. Native present-call rate is
null offscreen; no actual presentation/120fps proof is available here. Phone
optimization/configuration and capability labels were not changed.

## Checks / actual pixels

[Verification ledger + SHA256](parity-live-appearance-verification.json):
35 dev regression/GPU tests;36 release tests including all12 performance pairs;
strict all-target host and aarch64-apple-ios Clippy; fmt;24 Node ABI/C/cache/font
resource tests; TypeScript; zero-warning ESLint; repository check; existing
workflow actionlint. Host incremental/debug output disabled. No Swift/macOS build
was performed. No device-only slice/cache rules were changed.

Actual GPU readbacks: [pixel receipts](parity-live-appearance-pixels.json),
including actual selected font faces. Both styles show nonzero motion differences
and advancing-time differences, transparent corners, RGB<=A, and byte-identical
replay from identical timing histories. Disabled glow prototype adds944/438 halo
pixels outside sharp coverage. PNGs:

- `/files/rust_parity_live_motion_Spicy.png`
- `/files/rust_parity_live_motion_Amll.png`
- `/files/rust_parity_live_appearance_Spicy.png` (disabled glow prototype)
- `/files/rust_parity_live_appearance_Amll.png` (disabled glow prototype)

Existing GPU ownership/completion tests and the legacy pipeline's actual
alpha/premult/blur/sharp/resize/checkerboard proofs at1x/3x also pass. New timed
pixel receipts are DPR1, not a claim of full DPR/orientation native coverage.
All16 pixel-file SHA256 values and actual release binary/input hashes are in the
ledger. Existing Latin SF Bold bytes are registered; Linux Korean uses Noto JP
Bold, differing from the earlier Skia JP Regular reference. Do not silently
replace that reference or label Korean same-font parity.

## Reproduce / remaining acceptance

From repository root, with `CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0
CARGO_PROFILE_TEST_DEBUG=0` in the environment:

```sh
cargo +1.97.0 test --release --locked --manifest-path native/lyrics-renderer/Cargo.toml --lib -- --include-ignored --skip host_typography_effect_budget --test-threads=1
cargo +1.97.0 clippy --locked --manifest-path native/lyrics-renderer/Cargo.toml --all-targets -- -D warnings
cargo +1.97.0 clippy --locked --manifest-path native/lyrics-renderer/Cargo.toml --lib --target aarch64-apple-ios -- -D warnings
BASH32=/tmp/rust-bash32-src/bash-3.2.57/bash node --test scripts/test/ios-dev-ci.test.cjs
npm --prefix ExpoLyrics run typecheck
```

No comparison JS/Python/CLI was edited or merged. Parent's reviewed numeric tool
is still pending. Existing `examples/parity-capture.rs` remains legacy baseline
only: do not call it a new two-style comparison. This checkpoint provides actual
Rust output, not new Skia-vs-Rust side-by-sides or numeric parity acceptance.
Full-native deterministic Skia capture remains unimplemented/unverified here.

Remaining matrix explicitly includes BGV/aux transport/layout, translations and
romanization, full duets, source-style scrolling, finite interludes, attribution
links/touch/accessibility, exact overlap/color-glyph handling, full native fonts /
packaging and actual Skia numeric acceptance. Foreground overlap protection
already present is not BGV parity. See `parity-matrix.md`.

Latest override: use weekly budget, begin feature wrap-up around10%, aim for
passing checkpoint/review and coordinator preparation of ONE parity-so-far IPA
by about5%. This supersedes all15% stops and near-complete-only IPA rules.
Latest available coordinator file read is weekly19% remaining, primary68%.
No reset credits, high/Ultra, extra Codex, push, CI dispatch, Metro operation or
IPA was used. Coordinator owns independent review and the sole build; ABI5
physical phone HUD/performance remains UNVERIFIED until the user's final test.
