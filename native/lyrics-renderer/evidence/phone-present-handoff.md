# Phone presentation retest fix: coordinator handoff

Baseline cbb467f40e6473632b64efd04ecc483c64da9c01, rescue branch
`rust-renderer-spike`. No push, app build, CI dispatch, Metro operation or
other-worktree change. All implementation edits made here; independent
coordinator review remains pending. Native **ABI 3 needs a new IPA**.

## Behavior and evidence

- Diagnosis was committed before implementation as `b04705c`, with frozen-source
  reproduction [phone-present-baseline.cjs](phone-present-baseline.cjs). Source
  references, official APIs and the final alpha research are in
  [phone-present-diagnosis.md](phone-present-diagnosis.md). Current exact code
  locations: [phone-present-source-map.json](phone-present-source-map.json).
- `8571317` removes the final live GPU wait, polls completion without blocking,
  bounds GPU application frames to two and CPU requests to one, keeps FIFO and
  selects three OS drawables through latency hint 2. Full-capacity opportunities
  return status 3 without a drawable, queued target or motion update; the next
  vsync supplies a fresh target. Acquisition precedes scene sampling; an elapsed
  native clock refresh prevents replaying a target made stale by nextDrawable.
  Worker-only resize/destruction waits and retained-layer retirement stay safe.
- `61cff93` corrects a confirmed locked Metal alpha metadata bug. Prefer supported
  PreMultiplied; locked Metal advertises PostMultiplied but Core Animation actually
  expects premultiplied content, confirmed by maintainers in
  [upstream #9922](https://github.com/gfx-rs/wgpu/pull/9922/files). Only that Metal
  path selects the advertised transparent mode while writing encoded premultiplied
  sRGB. No unsupported feature/mode, unsafe HAL access, registry modification,
  dependency upgrade or vendoring. Cargo.lock is unchanged. Inspected 30.0.2 also
  has the old metadata; it was not adopted. This supersedes the initial
  straight-surface implementation in `8571317`.
- ExpoUIView, MetalHost and CAMetalLayer clear/nonopaque; Vello alpha0 clear;
  premultiplied linear blur/masks; final premultiplied sRGB copy without blending.
  Nonlinear color conversion unpremultiplies then premultiplies once. No alpha1
  override or double premultiplication. Require a supported sRGB color space and
  non-sRGB unorm surface format. Physical compositor behavior still needs proof.
- Full-size sharp Vello/composite images are retained. Only blur is half size:
  one 2x2 box, four separable RGBA16Float filters, bilinear reconstruction and
  transparent zero padding. Gaussian weights are cached per resize/scale. No
  per-sample shader exp, per-line blur or per-frame filter texture allocation.
  [Pass/format/extent/byte inventory](phone-present-pass-inventory.json) describes
  logical work, not measured bandwidth. At scale 3 the four filters perform 160
  taps per half-size pixel instead of 312 per full-size pixel. Full-size sharp
  glyphs and the protected active/next band are preserved. Additional OS drawable
  memory offsets some intermediate memory savings; Vello/driver memory is excluded.
- HUD reports **present calls/s**, not presented fps. Worker requests, callbacks,
  busy/idle/inactive/noDrawable, GPU-capacity retries, observed blit completions
  and outstanding GPU work are distinct. Acquisition, final-blit submit, present
  call, nonblocking poll, scene, encode and blit are CPU wall costs. Vello internal
  submits remain inside encode. GPU work completion is not drawable presentation
  or scanout; completion observations can lag while idle. No per-frame live
  timestamp query/readback or explicit GPU wait. GPU rendering/blur capabilities
  remain independent of unsupported encoder timestamp profiling.
- Existing player clipping, motion integration, scroll, timing and layout files
  are unchanged from baseline and explicitly checked. Seek snap intent, pause,
  rate, generation, reanchor, resize remapping and retirement rules remain.

## Reproduce on this rescue host

From repository root:

```sh
node native/lyrics-renderer/evidence/phone-present-verify.cjs /tmp/phone-present-final
```

The script records exact commands/arguments, working directories and exit codes
in [phone-present-verification.json](phone-present-verification.json), plus
`phone-present-*.log`. It uses already installed Rust 1.97.0, Vulkan llvmpipe,
Node/npm dependencies, `/tmp/rust-bash32-src/bash-3.2.57/bash` and
`/tmp/rust-spike-actionlint/actionlint`. It compiles local Rust test/check/capture
programs; it does not build the native app, run Metro or dispatch CI.

All 16 command checks exited 0: fmt; **17 Rust tests**, including the actual
Vulkan two-in-flight resource ordering test; strict all-target host and
`aarch64-apple-ios` library Clippy; TypeScript; touched-view ESLint; **23 Node
CI/protocol tests** under Bash 3.2/5.2; actionlint; repository; frozen baseline;
actual alpha proofs at 1x/3x; host benchmark; diff; unchanged lock; unchanged
clipping/scroll sources. The Node suite compiles C11 assertions for 152-byte
KRMetrics, offsets 80/88/120/144 and the two-clock kr_render signature, and
executes the actual JS ABI rejection condition. Rust checks the matching layout.
Swift source contracts are tested but Swift itself is not compiled on Linux.

Actual Vello + compute + production surface-copy shader readback covers three
moving-lyric frames at 390x640 and 1170x1920, premultiplied RGB<=alpha both before
and after surface encoding, alpha0 outside glyphs, saturated red blur without
chroma darkening, real blur changes, sharp protected rows, empty-after-content
clear and the exact shared resize path at odd landscape extent 257x193. The
independent Vello sharp comparison allows 2/255 channel tolerance; observed max
was 1/255. The two-in-flight test checks distinct saturated colors/alpha after
shared image/buffer reuse. Deterministic tests cover 10,000 capacity opportunities,
completion ownership after retirement, stale/future target clocks, pause/seek/
resume/rate and existing analytic motion continuity.

PNG exports are straight RGBA for PNG viewers; shader readback assertions run on
raw premultiplied bytes first. Checkerboard images CPU-composite **actual linear
GPU readback** against backgrounds whose color/phase changes each frame. They
are not a UIKit/Metal compositor recording. Proof results:
[1x](phone-present-alpha1.json), [3x](phone-present-alpha3.json).

Fourteen PNGs are published under `/files/rust_spike_phone_present_*` with exact
paths, sizes and SHA-256 in [phone-present-png-manifest.json](phone-present-png-manifest.json).
Examples:

- `/files/rust_spike_phone_present_3x_transparent_1.png`
- `/files/rust_spike_phone_present_3x_checkerboard_1.png`
- `/files/rust_spike_phone_present_benchmark_landscape.png`

The significant milestone was appended to
`/home/kit/rust-renderer-milestones.jsonl`; the final entry supersedes the initial
straight-surface host proof. Its tracked copy is
[phone-present-milestone.json](phone-present-milestone.json).

During iteration the host ran out of disk while recreating a Rust archive; only
this crate's generated Cargo outputs were cleaned with `cargo clean -p
lyrics-renderer`, then checks passed. Initial exact sharp-byte comparison exposed
one-LSB variation across separate Vello rasterizations; tolerance and observed
max are documented above. A Clippy checked-division finding in PNG export was
fixed before the final passing run. No phone acceptance is inferred from these
local checks.

## Host proxy timing and limitations

[Raw 30-sample/orientation benchmark](phone-present-benchmark.json), six warmup
frames, nearest-rank p50/p95/p99. **Default dev opt0**, Vulkan llvmpipe CPU adapter;
not the phone's Metal device, opt1 profile or display scheduler. Synchronous
headless completion and timestamp readback differ from the asynchronous live
path. See raw JSON for all CPU/GPU bracket numbers; CPU submit may itself stall
on this software driver. No before/after speedup, phone GPU-time or 120fps claim.

The phone pipeline already sets `CARGO_PROFILE_DEV_OPT_LEVEL=1` and debug info 1
from source/config keyed CI inputs. No blind full-release or extra dependency
optimization change was added; profile actual CPU attribution before a targeted
opt2/3 experiment. Filter/readback texture memory excludes Vello and driver
allocations. Blur is an approximation: half-size reconstruction, finite 3-sigma
kernel, linear-light filtering and final RGBA8 quantization differ from Skia.
Off-viewport glyph coverage is clipped before blur, with transparent padding and
viewport fade, so this is not an infinite offscreen filter domain.

Fixture provenance is unchanged:
`DesktopBridge/test/fixtures/lrc-red/ZZA0P2622376.ttml`; no downloaded song assets
or external lyrics were introduced. Source versions/hashes inspected are in
[phone-present-locked-sources.json](phone-present-locked-sources.json).

## Required coordinator / phone checks

1. Independently review the complete baseline-to-final diff, especially Metal
   alpha compatibility, two GPU frames sharing one ordered queue, resource
   lifetime, target refresh and C ABI 3. Build on macOS only after review; verify
   Swift compilation/imports, Mach-O/Expo registration, generated/built/packaged
   ProMotion key and JS/native ABI guards. This agent did not build an IPA.
2. Install ABI 3 IPA through the caller-owned delivery/Metro path. Verify dynamic
   RN background through the actual native lyric surface, including pause/idle,
   resize, foreground, portrait/landscape and high-contrast changing backgrounds.
   Inspect edge/chroma/alpha halos and compare to these host reference PNGs.
   Confirm measured controls clipping and the non-overlapping debug pane remain.
3. Measure real presentation/scanout with device Instruments/Metal/Core Animation
   traces. Compare callback Hz, present-call rate, GPU completions/capacity and
   acquisition/CPU costs over real windows. The 120Hz request and deeper queue do
   not establish 120fps; physical GPU/display/system limits may prevent it. The
   earlier 11.44ms was a CPU worker tail, never GPU time. Timestamp profiler remains
   unavailable on the reported adapter and must stay labeled independently.
4. Stress pause/resume/seek/rate/reanchor, track replacement, focus/background,
   rotation/resizing, detach/remount and rapid owner retirement with two frames
   in flight. An acquisition can still block for an OS drawable; a stalled driver
   may retain retired resources. No lifecycle/latency/leak-free phone claim.

[DESIGN.md](../DESIGN.md) and [INTEGRATION.md](../INTEGRATION.md) describe the final
boundary. [phone-present-files.sha256](phone-present-files.sha256) inventories all
changed source/evidence files, excluding itself. No remaining local test failure;
independent review, native app compilation and device acceptance remain pending.
