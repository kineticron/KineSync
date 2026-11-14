# Phase 2: live iOS renderer implementation

The branch now implements the Rust renderer in the actual development player's
current-track path. This is more than a generic development-client build. It is
still an experimental integration pending macOS CI, re-signing and device tests.
No iPhone, LiveContainer, phone performance or runtime leak-free claim is made.
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
the native view after an error. **Show metrics** opts into the diagnostic overlay.

Track replacement sends a generation, UTF-8 atom text and source timing once.
Native code reconstructs byte ranges after decoding, shapes whole lines, caches
Vello glyph scenes and independently fills timed atoms. Literal spaces are
preserved and explicit word-end flags add missing gaps. Invalid/untimed tracks,
oversized packets and missing glyphs produce explicit errors. Lead-line overlaps
are now highlighted/protected together, including the phase-1 88.2-second case.
This is not a complete port of translations, background voices, duet alignment,
word glow/spring motion, drag scrolling, lyric press/credits or accessibility
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

Track generations and anchor sequences reject stale updates in Swift and Rust.
JS also rejects callbacks/promises from an older track or recreated surface.
One native view persists across track replacements. An explicit recreation or
orientation layout replacement retires its old handle. `kr_create` returns a
registry ID rather than a raw Rust object pointer. Unknown/disposed handles are
rejected and destroy is idempotent.

The Expo view contains a CAMetalLayer-backed UIView. A serial native owner keeps
that layer strongly alive while Rust owns a wgpu Metal surface. Create, track,
anchor, resize, frame and disposal operations are serialized. Per-work-item
autorelease pools bound temporary Objective-C objects. No per-frame image pixels
cross Swift/JS. Vello writes an offscreen GPU texture, shared compute passes blur
it, a GPU blit writes the acquired surface texture and wgpu presents it.

Layout/visibility changes occur on main. Zero-size, background and inactive
views stop rendering. Reactivation marks dirty and flushes the latest stored
track, size and anchor before resuming, including initial attachment while
inactive. Background/detach use a serial barrier so old GPU work is drained
before disposal releases the surface/layer. Display-link targets are weak and
notification registrations are removed on deinit. A session/revision guard
rejects stale completions and retry work.

The ABI returns 0 for presentation, 1 while waiting for track/anchor, 2 for
retryable acquisition failure, and -1 for failure. Paused first frames, seeks
and resizes retain/re-arm dirty work on Timeout/Occluded/Outdated. At most four
retries run after 100/200/400/800 ms with no active display link during backoff.
Exhaustion hides the stale surface and reports waiting until a new anchor,
activation, foreground, resize or explicit recreation rearms it. Waiting for an
anchor does not spin a frame loop. New input invalidates old retry work.

Ordinary Rust panics are caught before crossing C, panicking handles are retired,
and wgpu uncaptured/device-loss errors are recorded and surfaced. The ABI trusts
Swift's buffer/layer lifetime contract. Invalid foreign pointers, OOM aborts,
Objective-C exceptions and fatal driver failures are not made recoverable by
`catch_unwind`. Surface loss requires explicit recreation. Main-thread disposal
barriers can wait for a frame/GPU completion. Device loss, long stalls and actual
app lifecycle responsiveness require device validation.

## Metrics and interpretation

Native metrics are emitted at most once per second of rendering. With the
metrics overlay hidden they are retained in a JS ref without metric React state
updates. The overlay shows native frames, scene/encode wall spans, GPU timestamp
interval or explicit unsupported, presentation plus completion-wait time, UI
scheduling callback time, display interval and skipped busy display callbacks.

GPU timestamps bracket Vello and blur/composition across submissions. They can
include queue gaps and exclude the final surface blit. `presentWaitMs` includes
submit/present/completion wall time, not pure CPU work. `uiTickMs` measures main
callback scheduling work, not compositing or presented-frame latency. Skipped
callbacks are not a measured dropped-frame count. These last-frame diagnostic
samples are not percentile benchmarks or a whole-frame GPU profile.

JS comparison includes anchor calls, React renders, anchor-construction/JSI work
and a delivery-age-adjusted native-minus-store clock delta. Visual rate previews
intentionally diverge from audio/store speed. These diagnostics are not an audio
sync measurement, an instrumentation-free Skia benchmark or evidence of phone
performance gains. Switching renderers provides an in-app comparison path, but
a proper matched device capture/profiling protocol remains necessary.

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

Local checks cover Cargo fmt/test/strict Clippy, iOS-target Rust type checking,
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
TextureBlitter and Queue.present.
