# Native lyric renderer: phase 1 spike and proposed mobile boundary

This design began with the Linux offscreen spike using plain wgpu, Vello and
Parley. The branch now includes an experimental Expo iOS Metal module; see
[INTEGRATION.md](INTEGRATION.md) for the implemented boundary and phone-fix
semantics. The coordinator reports baseline phone rendering. Updated native
behavior still needs macOS compilation and device validation; Linux software
Vulkan measurements establish no phone performance. Android remains proposed.

## Shared Rust core

Own the parsed track, immutable timed atoms, font resources, cached whole-line
Parley layouts, Vello glyph scenes, GPU textures and frame state in Rust. Shape
once per track/font/width/scale revision, not per syllable and not per frame.
Byte ranges map timing atoms to shaped clusters; wrapped atoms can have multiple
visual fragments. Keep font fallback, bidi, ligatures and grapheme policy in the
shared engine. This fixture exercises Korean and Latin; arbitrary bidi and
cross-atom ligatures need additional fidelity work before production.

The headless path uses the same intended pipeline as a view: Vello produces a
sharp RGBA texture; shared separable compute filters produce near/far blur;
a GPU compositor preserves the complete active and next-line band and applies
progressive blur elsewhere. No CPU pixel blur or JS frame work is involved.
Surface presentation adds a final blit to the platform's supported format.
Rebuild physical-size textures on resize, but reuse device, pipelines and font
resources. Keep a bounded visible row window for scene construction.

## Compact JS interface and native clock

Send a track once, with a revision, UTF-8 strings, atom byte ranges, start/end
milliseconds, alignment/voice flags and optional translation. A typed packed
buffer is preferable to thousands of bridge calls. Track replacement is atomic;
all queued commands carry a generation so stale work is ignored.

JS sends occasional anchors `{generation, positionMs, playing, rate, sequence}`.
Stamp receipt with the native monotonic clock (or explicitly synchronize clocks
if carrying a JS monotonic timestamp). Rust projects
`positionMs + elapsedNativeMs * rate` while playing. Pausing freezes position;
seeking replaces the anchor; changing rate first captures the current position
then installs the new rate. Reject non-finite inputs and unsupported negative
rates. Never use wall time for playback. A reconnect/newer sequence supersedes
old anchors. A CADisplayLink/Choreographer callback schedules rendering using
native time; JS does not deliver animation frames. On iOS, use display
`targetTimestamp`, retaining actual sample time separately, and request the
hardware-supported range up to 120Hz without assuming delivery. Guard the actual
generated and packaged `CADisableMinimumFrameDurationOnPhone` Boolean key. Use
native dt for continuous scroll; preserve position/velocity across ordinary
reanchors and pause/resume, and intentionally snap explicit seeks. Stop requesting frames when
paused and visually settled, detached or backgrounded; redraw once on seek or
resize. Production needs display/audio latency calibration and correction tests.

## Thin platform shims, written once per platform

**iOS:** an Expo view wraps a UIView whose backing layer is CAMetalLayer. On the
main thread configure layer size, contentsScale, drawableSize and visibility.
Create a wgpu Metal surface from a retained layer/view handle with a lifetime
that outlives the Rust surface. A serial render queue owns GPU operations and
acquires a drawable only while attached. The main thread forwards lifecycle and
size changes; it does not mutate Rust scene resources concurrently. Coalesce
input snapshots and bound outstanding draws to one. Gate visibility immediately,
then retire the worker/surface asynchronously while retaining the layer; do not
block UIKit with queue.sync waiting on GPU completion. Order rapid remounts after
retirement. Derive the lyric viewport from measured player/control geometry and
reserve diagnostic space in layout instead of painting it over glyphs. Render into
the common RGBA storage texture, then blit to the surface's configured format
and present. This is a thin persistent Swift/Objective-C layer, not a separate
Swift text/animation implementation. Validate the raw-window-handle and wgpu
Metal ownership contract in a small native harness first.

**Android:** an Expo view wraps SurfaceView, with SurfaceHolder callbacks.
Transfer/retain ANativeWindow through JNI and build a wgpu Vulkan surface tied
to that lifetime. Choreographer supplies vsync; a dedicated serial render thread
owns the device and surface. SurfaceView avoids a JS-driven texture upload.
On surfaceCreated configure; surfaceChanged queues physical pixel size and
layout generation; surfaceDestroyed synchronously stops presentation, drains
work that uses the old surface, drops it, then releases ANativeWindow. Never
access a destroyed Java Surface. Test alpha/composition, insets, rotation and
background behavior on actual Android versions.

Both shims are small platform-specific lifecycle adapters around one Rust layout,
timing and rendering implementation. They are not literally identical source.
Expose explicit create/setTrack/setAnchor/resize/dispose operations across a
narrow C ABI/JNI boundary. No unwinding across FFI: translate Rust errors to
structured events. Avoid retaining JS objects on the render thread.

## Lifecycle and failure handling

All renderer mutations use one owner thread and a command queue. Coalesce resize
and clock updates; prioritize disposal and track generation changes. Width,
font scale or device pixel ratio invalidates layout; height-only changes can
reuse shaping. Resize only after old in-flight work is safe; ignore zero-size
surfaces. Keep CPU geometry on surface loss, reconfigure on Lost/Outdated,
skip/retry on Timeout, and report OutOfMemory/device loss with an explicit reset
path. Device loss may require all GPU resources to be recreated. Backgrounding
stops the display link and invalidates elapsed visual transition deltas, while
playback projection follows the authoritative anchor policy.

Disposal detaches callbacks, rejects queued older-generation commands, waits for
or safely retires GPU submissions, drops surface before platform handles and
releases native references exactly once. Export no raw pointers to JS. Repeated
mount/unmount and rotation tests must check leaks and use-after-free on devices.

## Expo and distribution

Create a local Expo module with a native view definition and config plugin.
Swift/Kotlin shims call the Rust C ABI/JNI library; module methods send track and
anchor events. Build a custom Expo development client with this module linked.
Expo Go cannot load an arbitrary new native Rust renderer. Fast Refresh can
update JS but changing Rust or the shims requires rebuilding the native client.

Use cargo-ndk on Linux/Android CI to build arm64-v8a (plus emulator ABIs as needed)
cdylib artifacts and package them as jniLibs in the Expo module. Pin the NDK,
Android API floor, Rust version and Cargo.lock. Validate Vulkan/compute support
and Vello limits on each target; a supported fallback or clear unavailable state
is needed for unsupported devices. Do not assume desktop feature availability.

Use macOS CI with Xcode for aarch64-apple-ios and simulator targets. Produce
static libraries with a C header, then an XCFramework with separate device and
simulator slices, linked by the module's podspec. A Linux run cannot build,
sign or validate the iOS Metal client. Pin deployment target and linker flags
and test actual app lifecycle, not only library compilation.

A phone using LiveContainer still needs an appropriately signed/rebuilt custom
development client containing the Rust library and Expo module. LiveContainer
does not make a JS-only bundle acquire new native code or establish App Store /
JIT / entitlement compatibility. Signing, provisioning, OS/container constraints
and launch support depend on the actual device setup and must be verified there.
This phase makes no claim that the current stock client can load this renderer.

## Phase 2 acceptance

Build the thin views; validate Korean fonts and timed fills at phone scale,
background/resume, seek/pause/rate, track replacement, rotation, memory disposal
and surface/device loss. Capture matching current Skia frames using the same
track, time, font and dimensions. Compare typography, reveal feather, shared
blur masks and scrolling by eye. Measure frame CPU/GPU distributions, dropped
vsyncs, memory and power on iOS Metal and Android Vulkan before judging adoption.
