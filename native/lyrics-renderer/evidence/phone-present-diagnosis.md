# Phone presentation retest diagnosis (before implementation)

Frozen HEAD cbb467f40e6473632b64efd04ecc483c64da9c01. Reproduce:
`node native/lyrics-renderer/evidence/phone-present-baseline.cjs`.
Output: phone-present-baseline.json. This harness inspects frozen source and a
synthetic ownership trace; it does not simulate a Metal driver or predict fps.
User phone report: Vello + compute blur active, callbacks/request 120Hz, HUD
present calls ~40/s, CPU encode 2.47ms, worker present+wait 11.44ms,
1990 callbacks / 620 submissions / 1370 busy. 11.44ms is NOT GPU time.

## Exact frozen source evidence

- gpu.rs:518–554 acquires a drawable before encoding, submits blit, calls present,
  then explicitly waits indefinitely for completion on the only Rust worker.
  Swift:169–205 holds the main-side busy gate until that entire call returns;
  :403–414 rejects callbacks while busy. This serializes CPU work and GPU wait.
  Returned present calls do not measure scanout (:314, component :115–119).
- gpu.rs:480–489 selects FIFO, latency hint 1; locked wgpu-hal 30.0.1
  metal/surface.rs:330 sets maximumDrawableCount = maximum_frame_latency + 1,
  so the old hint creates two OS drawables. Metal adapter.rs:459–471 exposes
  FIFO on iOS and ONLY Opaque/PostMultiplied alpha, **not PreMultiplied**.
- Locked hal metal/surface.rs:348–380 calls nextDrawable; timeout argument is
  ignored. It can block for drawable availability. metal/mod.rs:802–826 creates
  a separate present command buffer and commits it. With presentsWithTransaction
  false it schedules presentDrawable asynchronously; true waitsUntilScheduled.
  Queue completion of the blit is not drawable presentation or scanout.
- gpu.rs:360 sets an opaque dark Vello base. Surface default alpha stays opaque;
  hal surface.rs:269–273 resets CAMetalLayer.opaque true for that mode, overriding
  Swift's earlier false. Swift :275–278 clears only the child UIView/layer;
  ExpoUIView itself is not explicitly clear/nonopaque.
- Locked vello_shaders 0.12.0 shader/fine.wgsl:1397–1404 writes **straight** RGB
  (divides by alpha), despite premultiplied internal rendering. Existing blur
  averages that output as if opaque. blur.wgsl:14–23 runs exp for every sample
  at full resolution: at scale 3 near sigma7.5/radius23, far18/radius54,
  312 texture loads per full-size pixel over four blur passes. Six full-size
  RGBA8 images include sharp/final/four intermediates. Composite adds one pass.
  Blindly changing only clear color produces halos and incorrect transparency.

Local registry root: /home/kit/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f.
Cargo.lock pins wgpu 30.0.0, hal 30.0.1, Vello 0.12.0. Line references above
are baseline/local registry references, not assumptions about latest APIs.

## Official API research

chub searches `wgpu Queue on_submitted_work_done` returned unrelated queue docs;
`CAMetalLayer nextDrawable` returned no results. Read locked registry source and:
- https://docs.rs/wgpu/30.0.0/wgpu/struct.Queue.html#method.on_submitted_work_done
  callback tracks previous submit completion; submit/poll drives callbacks.
- https://developer.apple.com/documentation/quartzcore/cametallayer/nextdrawable().md
  acquisition can wait up to one second when drawables are exhausted.
- https://developer.apple.com/documentation/quartzcore/cametallayer/maximumdrawablecount.md
  pool supports only 2 or 3 drawables.
- https://developer.apple.com/documentation/quartzcore/calayer/isopaque.md
  opaque backing may omit alpha and requires opaque content.

## Implementation decision and limits

Use two outstanding application frames with safe Queue completion callbacks,
nonblocking Poll, FIFO and latency hint 2 (three OS drawables). Keep one worker
request, drop busy opportunities without storing targets, sample a fresh clock
when a queued request executes. No HAL access or raw lifetime tricks. Same-queue
texture writes/reads are ordered; completion gates bound queued full frames.
Wait only on worker-side resize/destruction. Input coalescing/retirement and
known clipping/scroll behavior remain. Acquisition can still stall; measure it
separately, never promise nonblocking nextDrawable or physical 120fps.

Downsample only blur to half resolution with a 2x2 premultiplied box, linear
premultiplied blur and bilinear reconstruction; keep sharp glyphs full size.
Precompute Gaussian weights once per resize. Transparent zero padding, including
image edges. Preserve radii in physical pixels with scaled sigma. Actual GPU
readback tests must inspect alpha/halo/compositing over changing checkerboards.

Initial implementation followed the advertised PostMultiplied contract, but
follow-up upstream research found a confirmed metadata bug: Core Animation
actually expects premultiplied content. See the final correction below; the
initial straight-surface decision was superseded before handoff.

Inspect Debug Rust CPU cost before adding narrow dev package optimization;
no full-release switch. Linux measurements are host proxies only. Native app
build, Swift compilation, physical presentation/transparency, Instruments GPU
profiling and independent coordinator review remain coordinator/device actions.


## Refinements while implementing

Vello shader package is **0.12.0** (the earlier draft version label was corrected).
The actual filters use RGBA16Float half-size intermediates to preserve low-alpha
color instead of repeatedly quantizing blur to RGBA8. The final composite is
RGBA8. After nextDrawable, the render clock is max(display target, separately
sampled native clock + elapsed monotonic acquisition/poll time), so a blocked
acquisition cannot replay an old lyric position. GPU-capacity denial occurs
before acquiring a drawable or changing scroll state.

Debug optimization evidence: scripts/ios-dev-ci/config.json already specifies
rust.optLevel=1/debugInfo=1. ci.cjs:121–122 exports CARGO_PROFILE_DEV_OPT_LEVEL
and CARGO_PROFILE_DEV_DEBUG; rustIdentity includes that config, Cargo.toml,
Cargo.lock, all Rust/WGSL/header sources and producer scripts, so changes invalidate
the prebuilt device artifact. The 2.47ms reported encode span is below one 120Hz
interval, whereas the 11.44ms serialized worker tail spans more than one. No new
blanket release or dependency optimization override was added: existing phone
profile is already opt1, and a targeted opt2/3 change needs measured CPU attribution
on device first. Host default-dev benchmark is opt0 and is labeled accordingly.


## Confirmed Metal alpha metadata bug: final correction

Primary upstream research found https://github.com/gfx-rs/wgpu/issues/9896 and
https://github.com/gfx-rs/wgpu/pull/9922/files . Maintainers confirmed Metal's
PostMultiplied advertisement was wrong and changed both adapter capability and
surface configure matching to PreMultiplied. Locked 30.0.1 still contains the old
two lines. `cargo info wgpu-hal@30.0.2` and inspection of its metal adapter/surface
showed the same old two lines; Cargo.lock was NOT changed. We do not request a
mode that the locked backend rejects. We prefer advertised PreMultiplied, otherwise
only for Metal select its advertised PostMultiplied transparency option and write
**premultiplied encoded sRGB**, matching actual Core Animation and the confirmed
upstream fix. This is a shader/selection compatibility workaround, not a HAL
lifetime trick, raw API mutation, vendoring or dependency upgrade. Initialization
fails for other backends without advertised PreMultiplied.

Linear premultiplied intermediates are unpremultiplied for the nonlinear transfer
function, then encoded RGB is multiplied by alpha once at surface output; blend
is disabled. GPU readback asserts RGB<=alpha on both linear intermediates and
encoded surface output, plus saturated chroma and alpha values across two real
in-flight frames. Exported PNGs remove encoded premultiplication because PNG
viewers expect straight RGBA. Physical iOS compositing/color proof remains pending.
