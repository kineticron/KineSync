# Phase 1 report

## Result and scope

The Linux headless spike renders **seesaw (Feat. IU), Crush** from the existing
repository TTML fixture with Vello 0.12.0, Parley 0.12.0 and wgpu 30.0.0. It
caches whole-line shaping and Vello glyph scenes, applies independent timed
syllable reveals, and uses shared GPU near/far blur while protecting the complete
active and next lines. Both 390×844 portrait and 844×390 landscape render real
Korean glyphs: **42 lead lines, 671 glyphs, zero glyph ID-zero replacements**.

Everything here is an exploratory **Linux host proxy**, on llvmpipe software
Vulkan. It is not a phone benchmark, a production renderer, a deployed view or
an app change. No push, merge, release task or running dev server was used.
All changes stay under `native/lyrics-renderer` on the requested branch and base.

## Visual evidence

The following PNGs are absolute paths on the rescue host:

| Evidence | Path |
| --- | --- |
| First meaningful frame, historical initial 40 px type | `/files/rust_spike_first_frame.png` |
| First working fill and blur, portrait | `/files/rust_spike_fill_blur_portrait.png` |
| First working landscape | `/files/rust_spike_fill_blur_landscape.png` |
| Early fill, same active syllable sequence | `/files/rust_spike_fill_17300.png` |
| Later fill | `/files/rust_spike_fill_17700.png` |
| Final gallery | `/files/rust_spike_portrait_{11077,17300,17500,17700,21200,33400}.png` |
| Final gallery | `/files/rust_spike_landscape_{11077,17300,17500,17700,21200,33400}.png` |
| Sharp compositor control, same layout/time as 17500 | `/files/rust_spike_sharp_control.png` |
| Final benchmark frame, portrait | `/files/rust_spike_benchmark_portrait.png` |
| Final benchmark frame, landscape | `/files/rust_spike_benchmark_landscape.png` |
| Host benchmark chart | `/files/rust_spike_benchmark_chart.png` |

The gallery braces describe six separate files per orientation, not one literal
filename. Final typography is 34 raster px, bold Noto Sans CJK KR. The first
milestone preserves the initial 40 px exploration rather than overwriting it.
Milestone notifications are in `/home/kit/rust-renderer-milestones.jsonl`, with
`milestone`, `png_paths`, and `note` on every line.

I visually inspected the first frame, Korean fill/blur portrait, landscape,
completed-line capture at 21.2 s and mixed Latin/Korean capture at 33.4 s. These
show real Hangul forms, white sung fragments, dim unsung fragments, a sharp next
line, and progressively blurred distant text. PNG pixel verification compares
actual outputs with the sharp control: the protected interior band is identical,
inactive text changes, time advances the fill, and unrelated lower rows stay
identical. The counts are in [evidence/image-checks.json](evidence/image-checks.json).
This is a renderer check, not a Skia pixel-diff gate.

## Comparison with the existing renderer

Inspected the current `native-skia-voice.tsx`, `native-shared-blur.tsx`,
`use-reference-line-motion.ts`, `spicy-native-layout.ts`,
`native-lyrics-fonts.ts` and the native renderer documentation at the base commit.
There are no committed current Skia raster snapshots in this worktree. The
paragraph harness mocks native paint boundaries rather than producing a current
Skia screenshot; the browser preview script launches a server, which this task
explicitly excludes. I did not access the running dev server or manufacture a
claim of visual parity with unavailable captures.

The spike keeps the existing aesthetic: bold white lyrics on a very dark field,
dim unsung/inactive text, progressively blurred rows away from the protected
active/next region, and roomy left-aligned text. Its 60/100/60 px distance profile
is taken from the shared spicy blur configuration. The line inset is 32 px in
portrait, and landscape uses a centered 67% text lane; these are exploratory
composition choices rather than a port of every current Skia layout policy.

Known visible differences:

- Noto CJK bold replaces the app's SF Pro Display/fallback stack. Wrapping,
  baseline, metrics and weight therefore differ. No fonts were downloaded or
  added to the repo.
- The Gaussian near/far tiers use sigma 2.5/6 px. They are not calibrated to
  `expo-blur` intensity 10/24 or native material/tint behavior. The compositor
  mixes opaque sharp/near/far images with complementary weights; the app's
  masked native blur passes use source-over alpha, so transitions differ.
- Reveal edges are hard clips per source atom, rather than the Skia gradient
  feather, word float, glow, emphasized-letter scaling or spring animations.
- Focus snaps to the latest started line at a fixed 37%-height anchor. There is
  no spring scrolling, gesture handling, kinetic settling, interlude or duet
  layout. Focus persists through gaps and before/after the song; a completed
  focus line remains filled until the next start. This policy is deterministic
  for captures, not a complete playback-window port.
- **Simultaneous active-line highlighting/protection is omitted.** This is
  stronger than omitting duet alignment: only the latest started line gets a
  timed reveal and active protection. L18/L19 overlap at 88009–88483 ms; at
  **88200 ms**, L18's last atom is still singing, but L19 has already removed
  L18's timed highlight and active blur protection. The same behavior occurs
  for L34/L35 at **136445 ms**, within their 136445–136555 ms overlap. The earlier
  still-singing row becomes dim and eligible for distance blur. Source atom
  times are retained, but simultaneous rendering does not honor all active
  intervals. Future support must separate scroll focus from all active intervals
  used for highlighting/protection. This phase does not claim fixture-wide
  simultaneous timing fidelity.
- Lead spans only; translations and agent/duet alignment are not presented.
  The selected fixture has no nested timed lead/background spans. Arbitrary
  cross-atom ligatures, bidi and broader multilingual fidelity are unvalidated.
- A viewport fade is added at the top and bottom. Output is an opaque RGBA8
  dark-field composition; color-space/HDR/material parity is not established.

## Benchmark methodology

Commands and dependency/font/fixture provenance are in [README.md](README.md).
[evidence/benchmark.json](evidence/benchmark.json) contains every raw sample,
adapter details, layout cost and p50/p95/p99/max values. The standalone chart is
`/files/rust_spike_benchmark_chart.png`.

The release binary was measured on November 11, 2026: Linux
`7.3.1-hako x86_64`, three virtual AMD Hako CPU cores, Mesa
`25.2.8-0ubuntu0.24.04.4`, adapter
`llvmpipe (LLVM 20.1.2, 256 bits)`, wgpu Vulkan device type **Cpu**.
`VK_DRIVER_FILES=/usr/share/vulkan/icd.d/lvp_icd.json` selects that software ICD.
No compiler or other spike renderer was run concurrently with the measurement;
the shared host and existing dev server were not stopped or altered. Other host
activity can affect this run.

For each orientation: **12 warmup frames, 120 measured frames**, all with blur
enabled. The measured logical track times advance by 16.667 ms from 16.6 s;
the final measured time is 18.583 s. This short window does not sample the
overlaps above or establish worst-case whole-song cost. Execution is unpaced
and not synchronized to vsync. One frame is in flight, with
a blocking completion wait and a 16-byte timestamp readback each frame. This
measures synchronous offscreen work, not presentation throughput or dropped
frames. Both orientations contain 329,160 pixels; visible glyph/clip work and
wrapping differ.

- **CPU scene:** assembling visible cached scenes and atom clips; excludes
  initial font discovery, whole-track shaping and layout.
- **CPU encode:** Vello render preparation/encoding/submission plus shared blur
  and compositor encoding/submission. Software driver queue submission can do
  synchronous work here; this is not pure application encoding time or an
  isolated Vello CPU-stage measurement.
- **Wait/readback:** completion poll and timestamp mapping; recorded separately.
- **GPU interval:** real supported wgpu timestamp queries before Vello and after
  shared blur/composition. Brackets cross submissions and include GPU queue gaps.
  On llvmpipe these are software Vulkan timestamps, not hardware GPU execution
  evidence. This is not the sum of instrumented kernel durations.
- **Wall frame:** scene through completion and timestamp readback. CPU and GPU
  intervals overlap and must not be added together.

Pipeline/device initialization, shaping, warmup, PNG texture readback and PNG
encoding are excluded from sample distributions; layout cost is reported
separately. Filters run on the wgpu compute path, with retained textures/bind
groups and no CPU pixel blur. Near/far images are shared across all rows, not
filtered separately per row. The PNG path reads back pixels only for captures.

Percentiles use nearest rank: sorted values at `ceil(p*N)-1`. With N=120, p99
uses the second-largest sample. These are one-run descriptive statistics, not
confidence bounds, a native Skia speed comparison or a claim of phone gains.

| Orientation / metric (ms) | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: |
| 390×844 / cpu_scene_ms | 0.01915 | 0.03011 | 0.03418 | 0.06333 |
| 390×844 / cpu_encode_ms | 108.18749 | 143.91080 | 153.55194 | 155.59164 |
| 390×844 / wait_readback_ms | 0.07089 | 111.21608 | 120.89406 | 168.86843 |
| 390×844 / gpu_interval_ms | 115.64017 | 146.91206 | 155.25126 | 186.57878 |
| 390×844 / wall_frame_ms | 116.11247 | 147.36989 | 155.68273 | 187.05568 |
| 844×390 / cpu_scene_ms | 0.01630 | 0.01930 | 0.04846 | 0.08461 |
| 844×390 / cpu_encode_ms | 96.99007 | 126.75917 | 147.62560 | 150.81141 |
| 844×390 / wait_readback_ms | 0.06994 | 95.85369 | 109.01465 | 124.29862 |
| 844×390 / gpu_interval_ms | 98.55474 | 131.51202 | 147.12761 | 150.23076 |
| 844×390 / wall_frame_ms | 99.00365 | 132.28742 | 147.71434 | 150.89687 |

Initial whole-track font discovery/shaping/layout: 390×844: **17.43 ms**, 844×390: **10.18 ms**. These one-time values exclude device/pipeline setup.

## Validation and remaining work

`cargo +1.97.0 fmt --check`, `cargo +1.97.0 test --locked`, and
`cargo +1.97.0 clippy --locked --all-targets -- -D warnings` pass. The timing tests
exercise clamped/zero-duration reveal, real UTF-8 fixture ranges and focus
boundaries, timestamp formats, pause, seek and rate projection. Headless release
gallery and benchmark commands complete with the Vulkan software adapter.
The image check verifies actual GPU/compositor outputs rather than mirroring
scene-building code.

There is no phase-1 environment blocker after installing the ordinary system
build dependencies and Mesa driver. Phase 2 requires actual mobile views,
macOS/Xcode iOS builds, custom Expo client integration and device measurements;
none can be inferred from this Linux run. See [DESIGN.md](DESIGN.md).
