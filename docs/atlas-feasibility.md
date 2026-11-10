# Atlas feasibility gate: STOP

Inspected installed @shopify/react-native-skia **2.13.1**, including native C++ recorder implementation. The required animation path does not avoid picture rerecording. No renderer prototype was implemented, as requested for a failed first gate.

Base: development 5e76f08296ac4a99f4a4e4bcac7d708e69f47084. Isolated branch `perf-atlas`, worktree `/home/kit/.t3/worktrees/repo/perf-atlas`. No application or dependency changes, server starts, pushes, or benchmark/concurrent-task edits.

## Exact evidence

Paths below are relative to `/home/kit/repo/ExpoLyrics/node_modules/@shopify/react-native-skia`. Full inspected sources are preserved under this report's `source/` directory, with SHA-256 hashes in `source-sha256.json`. These are the installed sources, including any existing local dependency patches; this is not a claim about an untouched registry tarball.

1. `src/external/reanimated/buffers.ts:12-17,20-42,49-50`: useRSXformBuffer wraps a mutable shared array. Its mapper changes entries and calls notifyChange(values) on line 33. It is not a GPU transform buffer bypassing the scene recorder.
2. `src/sksg/Recorder/ReanimatedRecorder.ts:67-72,296-298`: drawAtlas registers shared props, including the transforms shared value, as animation dependencies.
3. `src/sksg/Container.native.ts:57-81`: redraw builds the retained command recorder and registers a mapper. On each mapper invocation, applyUpdates runs (79), then nativeDrawOnscreen (80). `nativeDrawOnscreen` calls recorder.play(picture) at line 28 and publishes the picture at line 31.
4. `cpp/api/recorder/JsiRecorder.h:96-113`: applyUpdates executes property conversion callbacks. `play`, lines 73-88, constructs a new SkPictureRecorder, begins recording, replays commands, finishes a new native SkPicture, and replaces the object inside the existing JSI picture wrapper. Reusing the wrapper does **not** reuse the native recorded picture.
5. `cpp/api/recorder/Drawings.h:928-951,954-979`: Atlas stores sprite rectangles and RSXforms as native vectors; its draw method calls canvas->drawAtlas inside that recording. No alternative animated buffer submission is exposed in this path.
6. Web agrees: `src/sksg/Container.web.ts:94-98` schedules drawOnscreen on animation changes; lines 20-28 create and finish a picture after replay.

Precisely: animation does **not** require calling Container.redraw itself every frame or rebuilding the React scene/retained command list. The mapper installed by redraw still calls native Recorder.play for each animation update it processes, producing a new native SkPicture. Multiple updates can be coalesced by scheduling; no fixed frame count is asserted from static inspection.

## Cost interpretation and measurement limits

A single atlas command could reduce command replay work versus many text commands and avoid repeated text rasterization. That remains a possible separate optimization, not evidence of zero rerecords or a measured speedup. Highlight clips/shaders, glow layers, blur variants and multiple textures could add commands and memory.

Read `/home/kit/perf-compare/README.md`, `worker.cjs`, and `replay.cjs` before considering measurements. Its app createPicture counter does not count native Recorder.play picture builds. Its CanvasKit parent replay/raster is a host proxy, not native/UI phone performance. No benchmark run was needed to falsify the API-path hypothesis; no callback timings, native frame counts, texture-memory measurements, or device results were collected. Static call-path evidence above is the proof, not an instrumented native measurement.

## Scope and validation

Stopped at the required gate. Toggle location: none added. AMLL/Spicy implementations, texture caches, scroll scenarios, portrait/landscape/Hindi contact sheets and pixel differences: not produced because the prototype did not proceed. Original visuals and settings are unchanged. Compile/typecheck/application tests and independent prototype review are not applicable to this documentation-only gate result. Source version and call paths were inspected directly; git diff whitespace validation is run before commit.

Git identity for the research commit: kineticrondev <kineticrondev@gmail.com>, supplied per command to avoid altering shared repository configuration.
