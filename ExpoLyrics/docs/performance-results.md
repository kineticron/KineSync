# Performance measurements

Report generated 2026-10-09T05:06:24.463Z.

## Before/after lookup microbenchmark

Both implementations receive identical deterministic positions and overlapping ranges. The baseline reproduces the previous first-match linear algorithm on normalized numeric ranges, excluding the old per-frame normalization overhead. The optimized implementation is the production indexed timeline. Every result is checked for equality before measurement. Each workload warms both implementations, alternates measurement order, and reports the median of nine batches of 12,000 queries. Raw JSON includes batch p95 and index build cost.

### BlueStacks WebView engine

| Lyric lines | Linear lookup µs | Indexed lookup µs | Speedup | Lookup CPU reduction |
| ---: | ---: | ---: | ---: | ---: |
| 180 | 0.117 | 0.017 | 7.0× | 85.7% |
| 1000 | 0.858 | 0.058 | 14.7× | 93.2% |
| 5000 | 4.025 | 0.058 | 69.0× | 98.6% |

Runtime: Mozilla/5.0 (Linux. Android 7.1.1. ONEPLUS A3010 Build/NMF26F. Wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.6045.193 Mobile Safari/537.36. Sample: 2026-10-09T04:09:10.153Z.

This is the same pure JavaScript A/B workload running inside the installed WebView engine, without DOM mutations. It measures lookup cost, not the native release app, compositor FPS, or battery drain. Typical-song savings are a fraction of a microsecond per lookup: a large relative speedup here alone does not imply a visible FPS increase.

### Desktop Node engine

| Lyric lines | Linear lookup µs | Indexed lookup µs | Speedup | Lookup CPU reduction |
| ---: | ---: | ---: | ---: | ---: |
| 180 | 0.084 | 0.012 | 6.8× | 85.3% |
| 1000 | 0.437 | 0.024 | 18.5× | 94.6% |
| 5000 | 1.998 | 0.048 | 42.0× | 97.6% |

Runtime: v23.7.0. CPU: AMD Ryzen 9 7900X 12-Core Processor            . Sample: 2026-10-09T04:31:38.062Z.

## Scheduling and allocation budgets

- The actual store tick is exercised for ten virtual playback minutes: 600 timer callbacks/store publications, compared with 6,000 at the previous 100 ms cadence. This is a 90% reduction in that timer's callbacks, not a 90% battery saving.
- Inactive/hidden AMLL scheduling and paused/hidden/ended desktop scheduling are asserted to leave zero pending frame/timer callbacks. Late callbacks and anchor updates cannot restart suspended AMLL rendering.
- 45 static JSX prop objects/arrays moved out of render bodies. Their values are unchanged and no longer allocated on every render. WebView source/whitelist/load-handler identities are checked across option updates.
- Artwork search ranking is checked under reverse completion order, with cancellation on failure. Health checks are tested with a maximum of three concurrent providers and one request per provider.

## Native BlueStacks observation

### Animated release build

A separate, non-debuggable release package ran the existing AMLL lyric tour for 30.03 seconds. SurfaceFlinger recorded 1118 presentations: **37.23 presented FPS**. Presentation intervals were p50 25.00 ms, p95 54.17 ms and p99 66.67 ms. Native gfxinfo reported 1134 frames, 97.88% jank, and frame-duration p50/p95/p99 97.08/109.68/118.77 ms from its last 120 samples. Process usage was 3573 raw CPU ticks and 251.6 MB PSS. The emulator reports 240.0 Hz.

This is an optimized-build observation, not a matched before/after comparison. No FPS, memory, CPU or battery improvement is established by it. The reported 240 Hz display budget affects native jank classification. Native gfxinfo duration includes stages that differ from presentation intervals. SurfaceFlinger measures the app surface, not individual lyric animation frames. Delayed polling can miss timestamps. The tour uses five lyric lines, so it does not exercise the long-song lookup stress cases above. The observed delivery and jank leave significant rendering headroom. The lookup speedup alone does not solve it.

The release APK was built with an opt-in tour fixture and installed under a separate application ID, preserving the existing installation. A local test certificate signs the release APK without enabling DEBUGGABLE. The normal build has no fixture. The temporary package was removed after measurement.

### Existing development installation, idle

Installed version 1.1.7, debuggable=true. 15.00 seconds recorded. There were 0 new native frames, 0 eligible frame-time samples, 59 raw process CPU ticks, and 684.2 MB PSS. The display reports 240.0 Hz.

The recorded workload was idle. Zero new frames means there is no animation FPS result. It does not mean playback renders at zero FPS. The installed development build is slower and differently instrumented than a release build, and is not an optimization baseline. No whole-app before/after FPS, jank, memory or CPU improvement is claimed from this observation. Native gfxinfo also does not isolate WebView compositor frame delivery.

## Battery and release-build limits

BlueStacks exposes simulated battery values. Physical battery drain, current, energy per minute and battery-life improvement remain unmeasured. Reduced wakeups are a tested scheduling gain, not an energy measurement. Release performance must be measured with matching baseline and optimized release builds, the same renderer/song/workload, display rate, emulator settings, warmup and recording duration.

The Android capture script rejects debuggable builds unless --allow-debug is explicitly supplied. It captures presented FPS, presentation intervals, native frame counts, jank, frame-time percentiles, CPU ticks and memory. Raw dumps are retained. It does not reset global battery statistics or infer CPU percentages from an unverified tick frequency.

## Repeat the tests

From ExpoLyrics:

```powershell
npm run test:performance
npm run benchmark:performance
npm run benchmark:emulator -- 127.0.0.1:5555
npm run profile:android -- 127.0.0.1:5555 30 release-optimized-playing
node scripts/write-performance-report.cjs
```

The WebView microbenchmark requires a running app with WebView debugging enabled. Use that for isolated JS comparisons. Use release builds for native app measurements. For a development observation, append --allow-debug to the Android capture command. Run baseline/optimized scenarios multiple times in alternating order. A native sample with no active animation cannot establish FPS. For physical battery tests, use a real device and repeat a sufficiently long matched playback workload.

Raw measurements: repository .cache/performance/ (ignored by Git).

For a reproducible release workload on Windows, set EXPO_PUBLIC_PERFORMANCE_SCENARIO to tour-amll (or tour-spicy), then run gradlew.bat assembleRelease -PreactNativeArchitectures=x86 -PkineSyncPerformanceSideBySide=true -I ../../scripts/android-short-object-paths.gradle from ExpoLyrics/android. Sign/install the resulting APK with your local test key, launch dev.kineticron.KineSync.performance/dev.kineticron.KineSync.MainActivity, allow warmup, and set KINESYNC_PERFORMANCE_PACKAGE to dev.kineticron.KineSync.performance before capture. Clear the scenario environment variable before a normal build. The optional Gradle init script prevents Windows native object paths exceeding the toolchain limit. It does not change rendering settings.

References: [Android dumpsys frame and memory diagnostics](https://developer.android.com/tools/dumpsys), [Perfetto power counters and hardware support](https://perfetto.dev/docs/data-sources/battery-counters).
