# Artwork loading and fading

The earlier opacity-only change still decoded artwork and ran eight raster blur passes synchronously on RN. It also replaced the native Canvas generation and allocated two shader-backed canvases for each crossfade. Holding a shader's uniforms still is not the same as preparing an image before starting the fade.

The native path now uses one reusable Worklets worker for decode, tint, blur, and full-frame rasterization. A persistent Canvas mounts before artwork arrives. When preparation finishes, that Canvas crossfades actual SkImages using a shared opacity value. The warp shader is absent during the fade, and the motion callback is disabled. Normal shader motion resumes at the same held time after completion. Neither a new native surface nor native rasterization layers are allocated per song.

Interrupted transitions composite the already prepared frames on the worker, preserving partial opacity, including interruption of the first fade. Cancelled downloads and superseded worker results cannot publish stale artwork. Rotation reuses the last encoded artwork rather than downloading it again. Rasterized frames retain the previous shader's bounded physical resolution and filtering overscan.

## Measurements and limits

A temporary native probe ran in the existing Android development client on emulator-5554. One breakdown measured 0.46 ms shader-effect compilation, 15.16 ms decode/blur, and 182.17 ms full-frame CPU rasterization. Full-frame rasterization is new preparation work replacing the shader-backed fading layers, its CPU time is not a measurement of the old load path.

For an equivalent decode/blur/full-frame preparation workload, direct RN execution caused approximately 198–223 ms maximum heartbeat intervals. Worker execution completed in approximately 184–194 ms wall time while the RN heartbeat maximum was approximately 13–15 ms. These exploratory development measurements verify that heavy preparation yields the RN thread. They are not release-build FPS or physical iPhone measurements. CPU bitmap preparation also adds latency before a fade can begin, the old artwork remains displayed during that work.

Repeated native background swaps exercised worker image/effect transfer and fade completion. The emulator emitted `GLConsumer: checkAndUpdateEglState: invalid current EGLContext` and Skia surface-update failures, including before the worker change. Screenshots did not show a reliable Skia background. The attempted before/after presentation captures are therefore inconclusive and must not be used to claim a visual FPS improvement. Physical-device fade smoothness remains unverified.

Temporary native routes, baseline components, and console instrumentation were removed. Probe sources and exploratory artifacts remain under the ignored `.cache/performance/background-*` paths.

## Regression coverage

`check-kawarp-background.cjs` now executes Babel-serialized worker closures against real CanvasKit Skia, checks deferred worker execution and runtime reuse, compares prepared bitmap pixels exactly with the live production shader, and checks interrupted initial opacity. Its lifecycle harness prohibits RN image decode, exercises deferred preparation and stale worker results, requires one persistent Canvas, and requires bitmap-only drawing with no motion callbacks during fades. Existing loading, failure, pause, focus, reduced-motion, and resolution checks remain.

Artwork, lyrics, native lyrics, vault, and performance suites pass. Targeted ESLint and TypeScript checks pass.
