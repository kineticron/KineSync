# Phone fix diagnosis — before implementation

Baseline: `4bcfe6e29c200965013b6165546d69b8e1189a50`, rescue spike branch.
Instructions checked: no ancestor/root CLAUDE.md or AGENTS.md; the sole tracked
AGENTS.md is website/AGENTS.md, outside this change. No dependency files edited.
Phone observations supplied by coordinator: Rust renders and foregrounds promptly;
808 frames / 4711 skipped callbacks, teleporting focus, choppy reveal, controls
and debug overlay intersect lyrics. No phone trace, screenshot file or packaged
Info.plist is available in this checkout; these observations are not reproduced
hardware measurements here. No root cause is inferred from the counters alone.

## Reproducible source evidence

All line references below are to the frozen baseline (use `git show <baseline>:<path>`).
`phone-baseline.cjs` executes the actual baseline JS protocol and asserts the
source contracts; `phone-baseline.json` records its output. A synthetic 120-callback
trace with a 40ms worker has 24 submissions / 96 busy rejections / zero absent
callbacks. This proves why the busy count cannot mean missed display intervals;
it does not model this phone's speed. Baseline Cargo tests: 7 passed.

- `ExpoLyrics/modules/kinesync-rust-lyrics/ios/KineSyncRustLyricsModule.swift:280-287`
  already keeps the display link running while playing at positive rate. There
  is no dirty-only playing gate to fix. `:294-300` bounds draw work with `busy`.
  However no preferredFrameRateRange is requested, `:137-139` samples time on
  the worker, and `:295` counts busy rejections as undifferentiated skipped.
  `:126-130,162-168` synchronously drain the worker from lifecycle/main.
- `native/lyrics-renderer/src/gpu.rs:390-413` synchronously waits after Vello/blur
  and timestamp readback; `:560-563` waits again after surface blit/present.
  These waits bound GPU work but lengthen the serial worker's busy period.
  Actual phone GPU cost, completion latency and blur cost need device profiling.
- `native/lyrics-renderer/src/scene.rs:188-201` assigns the focused line directly
  to 37% of height each frame. Each focus change shifts every row by the previous
  line's cached height plus gap in one frame. There is no scroll animation state.
  Timed fill already evaluates the native projected clock per rendered frame.
- `ExpoLyrics/lib/rust-lyrics-protocol.js:39-47` subscribes only to anchor,
  playback and track changes; ordinary position ticks do not drive frames.
  `components/lyrics/rust/rust-lyrics-view.tsx:64-76` forwards real isPlaying and
  pauses while previewing a scrub. Rate UI changes currently reconstruct the
  position from the store, discontinuously losing accumulated visual-rate time.
- `ExpoLyrics/app/(tabs)/index.tsx:1287-1299,1653-1673` makes the portrait lyric
  viewport end at bottom 0. Controls are separately positioned at `:2029-2042`.
  Rust does not receive measured controls bounds. Landscape uses a separate safe
  right pane (`:1433-1440`), with controls on the left. Debug content is absolutely
  overlaid on the canvas (`rust-lyrics-view.tsx:100-133`).
- `native/lyrics-renderer/src/gpu.rs:271-283,323-337,383` gates timestamp brackets
  on TIMESTAMP_QUERY plus TIMESTAMP_QUERY_INSIDE_ENCODERS, **not rendering/blur**.
  Vello defaults to GPU compute (`vello-0.12.0/src/lib.rs:382,413`); our four blur
  passes and composite are unconditional sampled rgba8unorm input / write-only
  rgba8unorm storage output (`gpu.rs:208-233`, blur.wgsl, composite.wgsl).
  No adapter-specific read/write-storage feature is needed for those shaders.

## Exact locked implementation and official contracts read

Cargo.lock pins wgpu **30.0.0**, wgpu-core/hal/types **30.0.1**, Vello **0.12.0**.
Read local registry sources, not an unrelated latest release:
`wgpu-hal-30.0.1/src/metal/adapter.rs:676-692,1203-1215` tests stage, dispatch and
blit boundary counters separately. `wgpu-types-30.0.1/src/features.rs:700-721`
documents encoder timestamps as unavailable on Apple GPUs; stage-boundary timing
can still be available. We must not enable unsupported encoder queries. The
existing whole-Vello bracket cannot simply use a compute-pass timestamp because
Vello owns its own submissions. Report adapter and enabled profiler flags plus
reason separately from successful GPU rendering/blur. No CPU pixel blur fallback.

Apple official documentation fetched/read 2026-11-13 (Markdown links available
from each page):

- https://developer.apple.com/documentation/quartzcore/cadisplaylink/preferredframeraterange
  Range is a preference; hardware/system policy arbitrate actual cadence.
- https://developer.apple.com/documentation/quartzcore/optimizing-iphone-and-ipad-apps-to-support-promotion-displays
  Use best supported preference, adapt to variable dt, drive animation from
  targetTimestamp. Thermal, Low Power Mode and system policy can limit cadence.
  CADisableMinimumFrameDurationOnPhone must be Boolean true for >60Hz hints.
  The existing Expo app.json already sets it true; generated and packaged values
  are not yet guarded and are not locally known.
- https://developer.apple.com/documentation/quartzcore/cadisplaylink/targettimestamp
  Next-frame deadline, in the Core Animation time domain. Preserve actual worker
  sampling time separately from the target used to project animation.

## Implementation acceptance

Keep one outstanding draw, never wait on worker/GPU on main, retain the layer
until asynchronous retirement completes, close visibility immediately on main.
Request hardware-capped up-to-120Hz, pass target time, keep pause/seek/track/rate
anchors authoritative. Use analytically integrated continuous scroll with native
dt; intentional seeks/track replacements snap, ordinary reanchors/pause/resume
preserve motion. Run while playing or settling; freeze idle work. Separate
callback totals, submissions, busy, inactive, idle and no-drawable, observed
interval estimate and window rates; present calls are not scanout proof.
Use measured player/control geometry for clipping, reserve diagnostic layout in
normal flow. Guard generated and packaged ProMotion key. Test numerical curves,
clock/gating, viewport intersection and packaging failures. Native compilation,
phone presentation, thermal behavior and performance remain coordinator checks.
