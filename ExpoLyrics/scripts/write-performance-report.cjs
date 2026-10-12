/* global __dirname */
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const cache = path.join(root, '../.cache/performance');
const load = name => fs.existsSync(path.join(cache, name)) ? JSON.parse(fs.readFileSync(path.join(cache, name), 'utf8')) : null;
const emulator = load('emulator-benchmark.json');
const node = load('node-benchmark.json');
const observation = load('bluestacks-development-observation/summary.json');
const release = load('release-amll-tour/summary.json');
const table = report => report ? [
  '| Lyric lines | Linear lookup µs | Indexed lookup µs | Speedup | Lookup CPU reduction |',
  '| ---: | ---: | ---: | ---: | ---: |',
  ...report.results.map(row => `| ${row.lineCount} | ${row.baselineUsPerLookup.toFixed(3)} | ${row.optimizedUsPerLookup.toFixed(3)} | ${row.speedup.toFixed(1)}× | ${row.reductionPercent.toFixed(1)}% |`),
].join('\n') : 'Not recorded.';
const output = `# Performance measurements

Report generated ${new Date().toISOString()}.

## Before/after lookup microbenchmark

Both implementations receive identical deterministic positions and overlapping ranges. The baseline reproduces the previous first-match linear algorithm on normalized numeric ranges, excluding the old per-frame normalization overhead; the optimized implementation is the production indexed timeline. Every result is checked for equality before measurement. Each workload warms both implementations, alternates measurement order, and reports the median of nine batches of 12,000 queries. Raw JSON includes batch p95 and index build cost.

### BlueStacks WebView engine

${table(emulator)}

Runtime: ${emulator?.runtime ?? 'not recorded'}. Sample: ${emulator?.generatedAt ?? 'not recorded'}.

This is the same pure JavaScript A/B workload running inside the installed WebView engine, without DOM mutations. It measures lookup cost, not the native release app, compositor FPS, or battery drain. Typical-song savings are a fraction of a microsecond per lookup: a large relative speedup here alone does not imply a visible FPS increase.

### Desktop Node engine

${table(node)}

Runtime: ${node?.runtime ?? 'not recorded'}; CPU: ${node?.cpu ?? 'not recorded'}. Sample: ${node?.generatedAt ?? 'not recorded'}.

## Scheduling and allocation budgets

- The actual store tick is exercised for ten virtual playback minutes: 600 timer callbacks/store publications, compared with 6,000 at the previous 100 ms cadence. This is a 90% reduction in that timer's callbacks, not a 90% battery saving.
- Inactive/hidden AMLL scheduling and paused/hidden/ended desktop scheduling are asserted to leave zero pending frame/timer callbacks. Late callbacks and anchor updates cannot restart suspended AMLL rendering.
- 45 static JSX prop objects/arrays moved out of render bodies. Their values are unchanged and no longer allocated on every render. WebView source/whitelist/load-handler identities are checked across option updates.
- Artwork search ranking is checked under reverse completion order, with cancellation on failure. Health checks are tested with a maximum of three concurrent providers and one request per provider.

## Native BlueStacks observation

### Animated release build

${release ? `A separate, non-debuggable release package ran the existing AMLL lyric tour for ${release.elapsedSeconds.toFixed(2)} seconds. SurfaceFlinger recorded ${release.presentedFrames} presentations: **${release.presentedFramesPerSecond.toFixed(2)} presented FPS**. Presentation intervals were p50 ${release.presentIntervalP50Ms.toFixed(2)} ms, p95 ${release.presentIntervalP95Ms.toFixed(2)} ms and p99 ${release.presentIntervalP99Ms.toFixed(2)} ms. Native gfxinfo reported ${release.totalFrames} frames, ${release.jankPercent.toFixed(2)}% jank, and frame-duration p50/p95/p99 ${release.frameTimeP50Ms.toFixed(2)}/${release.frameTimeP95Ms.toFixed(2)}/${release.frameTimeP99Ms.toFixed(2)} ms from its last ${release.framestatsSamples} samples. Process usage was ${release.processCpuTicks} raw CPU ticks and ${release.pssMb.toFixed(1)} MB PSS. The emulator reports ${release.displayReportedHz.toFixed(1)} Hz.` : 'Not recorded.'}

This is an optimized-build observation, not a matched before/after comparison. No FPS, memory, CPU or battery improvement is established by it. The reported 240 Hz display budget affects native jank classification; native gfxinfo duration includes stages that differ from presentation intervals. SurfaceFlinger measures the app surface, not individual lyric animation frames. Delayed polling can miss timestamps. The tour uses five lyric lines, so it does not exercise the long-song lookup stress cases above. The observed delivery and jank leave significant rendering headroom; the lookup speedup alone does not solve it.

The release APK was built with an opt-in tour fixture and installed under a separate application ID, preserving the existing installation. A local test certificate signs the release APK without enabling DEBUGGABLE. The normal build has no fixture. The temporary package was removed after measurement.

### Existing development installation, idle

${observation ? `Installed version ${observation.version}, debuggable=${observation.debugBuild}; ${observation.elapsedSeconds.toFixed(2)} seconds recorded. There were ${observation.totalFrames} new native frames, ${observation.framestatsSamples} eligible frame-time samples, ${observation.processCpuTicks} raw process CPU ticks, and ${observation.pssMb?.toFixed(1)} MB PSS. The display reports ${observation.displayReportedHz?.toFixed(1)} Hz.` : 'Not recorded.'}

The recorded workload was idle. Zero new frames means there is no animation FPS result; it does not mean playback renders at zero FPS. The installed development build is slower and differently instrumented than a release build, and is not an optimization baseline. No whole-app before/after FPS, jank, memory or CPU improvement is claimed from this observation. Native gfxinfo also does not isolate WebView compositor frame delivery.

## Battery and release-build limits

BlueStacks exposes simulated battery values. Physical battery drain, current, energy per minute and battery-life improvement remain unmeasured. Reduced wakeups are a tested scheduling gain, not an energy measurement. Release performance must be measured with matching baseline and optimized release builds, the same renderer/song/workload, display rate, emulator settings, warmup and recording duration.

The Android capture script rejects debuggable builds unless --allow-debug is explicitly supplied. It captures presented FPS, presentation intervals, native frame counts, jank, frame-time percentiles, CPU ticks and memory; raw dumps are retained. It does not reset global battery statistics or infer CPU percentages from an unverified tick frequency.

## Repeat the tests

From ExpoLyrics:

${String.fromCharCode(96).repeat(3)}powershell
npm run test:performance
npm run benchmark:performance
npm run benchmark:emulator -- 127.0.0.1:5555
npm run profile:android -- 127.0.0.1:5555 30 release-optimized-playing
node scripts/write-performance-report.cjs
${String.fromCharCode(96).repeat(3)}

The WebView microbenchmark requires a running app with WebView debugging enabled. Use that for isolated JS comparisons; use release builds for native app measurements. For a development observation, append --allow-debug to the Android capture command. Run baseline/optimized scenarios multiple times in alternating order. A native sample with no active animation cannot establish FPS. For physical battery tests, use a real device and repeat a sufficiently long matched playback workload.

Raw measurements: repository .cache/performance/ (ignored by Git).

For a reproducible release workload on Windows, set EXPO_PUBLIC_PERFORMANCE_SCENARIO to tour-amll (or tour-spicy), then run gradlew.bat assembleRelease -PreactNativeArchitectures=x86 -PkineSyncPerformanceSideBySide=true -I ../../scripts/android-short-object-paths.gradle from ExpoLyrics/android. Sign/install the resulting APK with your local test key, launch dev.kineticron.KineSync.performance/dev.kineticron.KineSync.MainActivity, allow warmup, and set KINESYNC_PERFORMANCE_PACKAGE to dev.kineticron.KineSync.performance before capture. Clear the scenario environment variable before a normal build. The optional Gradle init script prevents Windows native object paths exceeding the toolchain limit; it does not change rendering settings.

References: [Android dumpsys frame and memory diagnostics](https://developer.android.com/tools/dumpsys), [Perfetto power counters and hardware support](https://perfetto.dev/docs/data-sources/battery-counters).
`;
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
// Keep generated prose consistent with the repository's documentation style.
const documentation = output.replace(/\s*—\s*/g, ': ')
  .replace(/;\s+([a-z])/g, (_, letter) => `. ${letter.toUpperCase()}`)
  .replace(/;/g, '.');
fs.writeFileSync(path.join(root, 'docs/performance-results.md'), documentation);
console.log('Wrote docs/performance-results.md');
