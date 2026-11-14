# Phase 2: live iOS renderer implementation

The branch now implements the Rust renderer in the actual development player's
current-track path. This is more than a generic development-client build. It is
still experimental. The coordinator reports that the baseline linked and rendered
on a phone, with choppy motion and controls overlap. The phone-fix changes below
still require independent review, macOS compilation, re-signing and device tests.
No phone performance or runtime leak-free claim is made.
No push, dispatch or Metro server operation was performed by the implementing
agent. Coordinator independent review precedes the authorized one CI build.

## Select and exercise it

In a rebuilt arm64 Debug development client, open the existing player with a
current track and timed lyrics. Tap **Try Rust renderer** at the upper right.
The same toggle switches back to the existing renderer. Default selection is
unchanged and the toggle is development-only. The module's Expo Apple config is
also Debug-only. Onboarding demos explicitly mark Rust unavailable. Android,
web, Expo Go, missing native registration and ABI mismatch display unavailable
states rather than silently substituting the old renderer.

The Rust view receives the actual playback store's track ID, immutable lyrics
and stable timing anchors. It does not load a fixture or fetch another song.
Existing pause/resume and scrub/seek controls update anchors. The view includes
a labeled **visual rate** control for 0.5/1/1.5x renderer-clock testing, which does
not change audio speed. **Recreate Rust surface** explicitly disposes/recreates
the native view after an error. **Show metrics** opts into the diagnostic panel above the canvas. The panel scrolls within at most 45% of
the measured lyric viewport; it does not cover glyphs.

Track replacement sends a generation, UTF-8 atom text and source timing once.
Native code reconstructs byte ranges after decoding, shapes whole lines, caches
Vello glyph scenes and independently fills timed atoms. Literal spaces are
preserved and explicit word-end flags add missing gaps. Invalid/untimed tracks,
oversized packets and missing glyphs produce explicit errors. Lead-line overlaps
are now highlighted/protected together, including the phase-1 88.2-second case.
This is not a complete port of translations, background voices, duet alignment,
word glow/syllable spring motion, drag scrolling, lyric press/credits or accessibility
semantics. Existing player seek controls still work. System Apple fonts replace
the Linux Noto stack. Phone font and visual acceptance are pending.

## Clock, stale updates and ownership

JS subscribes only to changes in anchor position/time, playing state and track
identity. A position-only UI tick does not send a native command. It projects
the store's position at a one-time sample, samples native `CACurrentMediaTime`
through a synchronous Expo function, and sends that anchor. JS sends no display
frame calls and has no animation/timer loop for Rust. Foreground and renderer
readiness trigger occasional resynchronization. Native CADisplayLink scheduling
and the shared Rust timeline project elapsed native time, pause, seek and rate.
ABI version 3 carries explicit seek-snap intent, separate display-target/sample
clocks and 152-byte capability/motion/presentation metrics. Both JS and Swift reject an older native ABI. This requires a rebuilt
IPA; a Metro-only update cannot install the Rust/Swift changes.

The display link requests preferredFrameRateRange with a hardware-capped maximum
and preference up to 120Hz (minimum up to 30Hz). This is a best-effort hint, never
a 120fps guarantee. Hardware, thermal state, Low Power Mode, accessibility frame
rate limits and system policy determine delivered cadence. Generated app plist,
built app plist, source app and packaged IPA must all contain Boolean true for
CADisableMinimumFrameDurationOnPhone; existing app.json already supplied it.

Each callback passes targetTimestamp in the CACurrentMediaTime clock domain to
Rust. Actual worker sample time remains separately reported. The JS comparison
projects the native position from the target time, and reports sample delivery
age from the actual sample. No display-frame calls cross JS. Visual rate changes
capture accumulated visual time; ordinary pause/resume/reanchors preserve it.
Scrub previews, release from preview, track replacement and source discontinuities
over 250ms intentionally snap scroll. Small source corrections stay continuous.

Rust integrates a critically damped scroll using the closed-form solution and
actual native dt. Focus changes retarget without resetting position or velocity;
active/syllable fill and the protected blur band follow the moving text each
frame. Pause freezes lyric time while residual scroll settles, then stops the
display link. Resize remaps the relative scroll offset into the new layout. Track
replacement resets motion; explicit seek anchors snap rather than traversing the
intervening song. Tests cover regular/irregular dt, long gaps, pause settling,
resize, target-time projection and protected-band continuity.

Portrait clipping derives from the player's actual root height and dock top
(onLayout of the entire SafeAreaView containing scrubber, transport and utility
icons), using the existing lyric top. Initial/stale-orientation measurements
collapse the surface until valid. Hidden controls conservatively retain their
reserve. Landscape already puts controls in the left pane and lyrics in the
right safe pane. The diagnostic header consumes normal layout space; the actual
remaining native view size drives Rust layout. The portrait dock-sized gradient
is omitted for Rust because its viewport already ends above the dock and the
GPU compositor supplies its own edge fade.

Track generations and anchor sequences reject stale updates in Swift and Rust.
JS also rejects callbacks/promises from an older track or recreated surface.
One native view persists across track replacements. An explicit recreation or
orientation layout replacement retires its old handle. `kr_create` returns a
registry ID rather than a raw Rust object pointer. Unknown/disposed handles are
rejected and destroy is idempotent.

The Expo view contains a CAMetalLayer-backed UIView. A serial native owner keeps
that layer strongly alive while Rust owns a wgpu Metal surface. Create, track,
anchor, resize, frame and disposal operations are serialized on one shared worker
queue, which also orders retirement before a rapid remount's creation. Latest
track/size and anchor inputs coalesce into one pending drain; seek intent survives
coalescing. One CPU draw request may be outstanding, with no target backlog;
two GPU application frames may be in flight. Per-work-item
autorelease pools bound temporary Objective-C objects. No per-frame image pixels
cross Swift/JS. Vello writes an offscreen GPU texture, shared compute passes blur
it, a GPU blit writes the acquired surface texture and wgpu presents it.

Layout/visibility changes occur on main. Zero-size, background and inactive
views stop rendering. Reactivation marks dirty and flushes the latest stored
track, size and anchor before resuming, including initial attachment while
inactive. Background immediately closes a short-lock visibility gate without
waiting on the worker. Detach retires asynchronously: queued inputs are rejected,
the worker drains the bounded frame, destroys Rust and then releases its retained
layer. A frame already executing can finish; backgrounding does not synchronously
cancel submitted GPU commands. Display-link targets are weak and notification
registrations are removed on deinit. A session/revision guard
rejects stale completions and retry work.

The ABI returns 0 after a present call (not scanout), 1 while waiting for
track/anchor, 2 for retryable acquisition failure, 3 for full GPU capacity, and -1
for failure. Capacity retry leaves dirty work armed for the next fresh vsync;
it does not use surface-error backoff or retain an old display target. Paused first frames, seeks
and resizes retain/re-arm dirty work on Timeout/Occluded/Outdated. At most four
retries run after 100/200/400/800 ms with no active display link during backoff.
Exhaustion hides the stale surface and reports waiting until a new anchor,
activation, foreground, resize or explicit recreation rearms it. Waiting for an
anchor does not spin a frame loop. New input invalidates old retry work.

Ordinary Rust panics are caught before crossing C, panicking handles are retired,
and wgpu uncaptured/device-loss errors are recorded and surfaced. The ABI trusts
Swift's buffer/layer lifetime contract. Invalid foreign pointers, OOM aborts,
Objective-C exceptions and fatal driver failures are not made recoverable by
`catch_unwind`. Surface loss requires explicit recreation. There are no main-thread queue.sync GPU/lifecycle barriers. Device loss, long
worker stalls and actual app lifecycle responsiveness still require device
validation; an indefinitely stalled driver can retain retired resources.

## Metrics and interpretation

Native metrics are emitted at most once per second of successful rendering, and
cadence windows must span at least one real second after start/resume before they
are exposed. Hidden diagnostics retain them in a JS ref without metric React
state updates. Counters are per view: callback total, submitted, idle, busy,
inactive and retryable no-drawable outcomes. No-drawable is a submission outcome,
not an additional callback category. Busy rejects a delivered callback while one
frame is outstanding; it is not a missed display interval. Observed interval
misses are explicitly an estimate from callback timestamp gaps divided by the
previous reported interval; system refresh-rate changes can also affect it.
Requested Hz is a hint. Delivered callback Hz and `presentCallRate` use count
deltas and real elapsed window seconds. Present calls are CPU returns from
Queue.present, not drawable presentation or measured screen scanout. `submitted`
counts worker requests, including capacity retries; `frames` counts present calls. No nominal-120 extrapolation or tiny
first-frame window is used. Idle/background pauses reset the next cadence window.

GPU Metal Vello and compute blur activity are reported independently of timestamp
profiling. Successful rendering runs Vello compute, a half-resolution downsample,
four shared blur passes and full-resolution composition even without queries. Adapter TIMESTAMP_QUERY and
TIMESTAMP_QUERY_INSIDE_ENCODERS flags and enabled bracket features are separate.
Locked wgpu-types 30.0.1 documents encoder timestamps as unavailable on Apple GPUs;
wgpu-hal Metal checks stage and blit boundary counters separately. No unsupported
features are forced. The sampled RGBA8 Vello output feeds write-only RGBA16Float
half-resolution storage filters, then RGBA8 full-resolution composition. These
formats need no adapter-specific storage read/write feature. The UI reports the exact missing
profiler feature, or that live timestamp readback is disabled.

The live path has no explicit GPU completion wait or timestamp readback. It polls
with PollType::Poll and admits at most two application frames. Safe Queue
completion callbacks record final blit GPU completion; they neither prove
presentation nor include Metal's separately committed present command buffer.
Three OS drawables (latency hint 2) separately bound display resources. When full,
no animation state is advanced and no display target is stored. Acquisition can
still block in nextDrawable; after acquisition Rust refreshes its native clock
from the separately retained sample plus elapsed monotonic time, keeping a
future display target when applicable. Resize/destruction wait on the worker;
UIKit never waits for that worker. Completion counts are observations from the
last poll/submit and can lag while idle.

`cpuSceneMs`, `cpuEncodeMs`, `cpuBlitMs`, `acquireMs`, `blitSubmitMs`,
`presentCallMs`, `pollMs` are CPU wall spans. `cpuBlitMs` includes final encoder,
submit, callback registration and present-call cost. `blitSubmitMs` covers only
the final explicit blit submit; Vello's internal submits and filter submit remain
in `cpuEncodeMs`. Driver submit/acquisition can stall; none of these are GPU
execution time. There is no per-frame explicit wait in the live path (`waitMs`
remains zero). Headless profiling retains timestamp brackets/readback, includes
submission gaps and excludes the final surface blit.

### Transparent composition

ExpoUIView, its child MetalHost and CAMetalLayer are clear/nonopaque. FIFO is
retained. The surface copy writes premultiplied encoded sRGB to a supported
sRGB-color-space non-sRGB RGBA/BGRA unorm surface. Prefer advertised PreMultiplied.
Locked Metal HAL 30.0.1 (also inspected 30.0.2 without changing the lock) incorrectly
advertises PostMultiplied while Core Animation actually composites premultiplied
content. Upstream confirmed/corrected this in
[wgpu #9922](https://github.com/gfx-rs/wgpu/pull/9922/files). Only on Metal, select
that advertised transparent option and supply the actual required premultiplied
content. No unsupported mode, registry patch, dependency upgrade or unsafe HAL
access is used. Other backends must advertise PreMultiplied or initialization fails.

Vello clears alpha0 and writes straight sRGB RGBA8; box downsample converts to
linear premultiplied RGBA16Float. Cached normalized Gaussian weights operate on
that representation with transparent zero padding. Bilinear reconstruction
mixes near/far only outside the full-resolution sharp protection band; viewport
fade scales alpha and RGB together. The final copy unpremultiplies only for
linear-to-sRGB color conversion, then multiplies encoded RGB by alpha exactly
once. Blending is disabled and the attachment clears alpha0. No final alpha1
override or double premultiplication occurs. Empty/initial and resized resource contents are fully
written before presenting. Backgrounding retains the last transparent frame.

This accounts for the locked Metal backend's mislabeled alpha capability;
actual CAMetalLayer/RN compositor behavior and color matching still need phone proof. Half-resolution filtering,
3-sigma truncation, RGBA8 final quantization and linear-light blur differ from
Skia's exact filter implementation. Off-viewport content is clipped before blur;
zero padding does not invent offscreen glyph coverage. The viewport fade hides
that boundary; no clamp-to-edge color smear is introduced.

## Device build and proof

See [the CI guide](../../docs/ios-development-ci.md). Rust is enabled in
`scripts/ios-dev-ci/config.json`: toolchain 1.97.0, aarch64-apple-ios, Cargo dev
profile with opt-level 1 and debug-info 1, unwind panics, iOS deployment 16.4 and
explicit flags/features. The app remains Debug and unsigned. The source-exact
XCFramework cache includes code, WGSL, header, lockfile, producer/validator,
configuration and Xcode identity. A verified hit skips Cargo, including after a
JS or Swift-shim-only change. The native build identity still changes for shims.

The producer runs before Expo prebuild/Pods, builds `liblyrics_renderer.a`, checks
arm64, creates one device-only XCFramework with a Clang module map, seals a hash
manifest and verifies the public ABI symbols. Cache restore validates that same
manifest and architecture before copying into the module's ignored Frameworks
directory. Swatinem/rust-cache stores registry and target work on a prebuilt miss.
No simulator or x86_64 Rust slice is produced.

CI then compiles a development JS path bundle using the installed Expo
`export:embed` export/mock-server path without a listening Metro server. The
implementing agent does not run or restart the caller's Metro. The proof bundle
is an audit artifact, not a claim that the caller's running Metro already serves
this branch or that the debug client has launched it.

The final app must provide `rust-link-proof.json` proving all `kr_*` symbols are
defined in the host Mach-O, the app link map contains the Rust archive/render
symbol, ExpoModulesProvider registers KineSyncRustLyricsModule, and the compiled
JS/source map includes the player selector and Rust view. Debug dylib indirection
is disabled so proof targets the host executable. Merely finding a `.a` is
insufficient. Registration discovery on Linux is not this final link proof.

Before packaging, the helper sets bundled Mach-O and CFBundleExecutable files
to 0755. `validate_ipa.py` independently rejects non-executable/missing code in
the source app and IPA, even when source and archive both have identical 0644
modes. Normal source-to-ZIP byte/type/mode and CRC checks also remain. Repair
paths, source validation, IPA entry manifest and full IPA hash are artifacts.
The opaque IPA is uploaded without recompressing. It is unsigned and not
LiveContainer launch-tested. Re-signing/rebuilding a custom client is required.

## Feasible local validation and next acceptance

See [phone-fix-diagnosis.md](evidence/phone-fix-diagnosis.md) for frozen pre-fix
source evidence and [phone-fix-verification.md](evidence/phone-fix-verification.md)
for this change's commands, results and remaining acceptance. Local checks cover
Cargo fmt/test/strict Clippy, iOS-target Rust type checking,
headless shared-engine GPU rendering, TypeScript, touched-file ESLint,
Expo Apple autolinking discovery, Node CI/protocol/negative-proof tests, shell
syntax and actionlint. The lifecycle test is explicitly a source-level harness,
not compiled Swift or an iOS runtime test. Linux has no UIKit/Xcode SDK for
compiling the Swift shim or linking/running the final iOS app.

After final independent review, the coordinator pushes only this branch via the
approved DEFAULT-host bundle route and dispatches one integrated build. Inspect
all final-image/link/provider/JS and executable-mode artifacts. Only then attempt
a signed device client: live track replacement, pause/seek/rate, inactive updates,
first attachment inactive, retryable paused-frame acquisition, rotation/resize,
background/foreground and repeated mount/unmount/recreation. Capture native
metrics and actual screenshots while checking memory and callback cleanup. No
phone-performance, launch or leak-free acceptance is inferred from Linux checks.

API contracts were checked against the official
[Expo native view tutorial](https://docs.expo.dev/modules/native-view-tutorial/),
[Expo module API](https://docs.expo.dev/modules/module-api/) and installed
ExpoModulesCore ViewDefinitionBuilder/ViewFactories sources, plus the pinned
wgpu 30 registry source for CoreAnimationLayer, CurrentSurfaceTexture,
Queue completion callbacks, transparent surface formats and Queue.present.
