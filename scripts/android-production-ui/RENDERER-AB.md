# Android renderer A/B evidence

Use the signed 1.2.8 release with Skia selected and the verified 1.3.0 release
with Rust. Record the SHA-256 of both APKs. Use the same physical model,
preferably Pixel 8a, with the same Android build, API level, refresh mode,
portrait orientation, locale, and test driver.

Measure steady autoscroll after setup and the player tour are dismissed.
Use the order AMLL translations on, AMLL translations off, Spicy translations
on, then Spicy translations off. Match the song, source lyric packet,
translation, playback rate, starting position and capture length across
both arms. Keep the player visible with no input during each measured
window. Preserve the device recordings or logs used to verify the style,
translation visibility, and uninterrupted playback.

Use the same Perfetto SurfaceFlinger FrameTimeline capture and export for
both APKs. Select the displayed app surface carrying the lyrics in each
arm. Use actual display presentation timestamps linked to that surface
and FrameTimeline jank classifications. Keep one entry per presented frame.
Retain the trace and the exact extraction inputs. FPS uses presented frames
over the full measurement window. Intervals are between adjacent presented
frames with nearest-rank percentiles. Jank percentage is among presented
frames. If scheduler trace data identifies the JS thread in both runs, use
its running time clipped to each window. Record unavailable JS CPU as null.

The offline comparator accepts one JSON file per arm. Each file includes
`version`, `renderer` (lowercase), `debuggable`, `apkSha256`,
`driverSha256`, `traceSha256`, `capture` set to
`surfaceflinger-frame-timeline`, and `device` with `physical`, `model`,
`apiLevel`, `buildFingerprint`, and `refreshHz`. Include four `windows`
in order. Their `scenario` values are `amll:on`, `amll:off`,
`spicy:on`, and `spicy:off`. Each window includes `trackId`,
`trackStartMs`, `lyricsSha256`, `startNs`, `endNs`, and `presents` with
ordered `{ "timestampNs": 0, "jank": false }` records. Use actual timestamp
values from the trace. `jsThread` carries `name` and `runningNs` when measured.

```sh
node scripts/android-production-ui/compare-renderer-runs.cjs skia.json rust.json > comparison.json
```

Firebase submission stays outside this tool. Before spending either free
physical execution, confirm the live quota and rehearse a driver that can
export the required traces and drive the same playback source on both
release APKs. Firebase's built-in FPS metric is for Game Loop tests and
does not supply these presentation intervals. Use one matched execution per
APK, with no retries or additional devices under the two-run cap.
[Firebase Test Lab command reference](https://docs.cloud.google.com/sdk/gcloud/reference/firebase/test/android/run)
