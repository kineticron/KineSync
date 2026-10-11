/* global __dirname */
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const { collectPresentTimes, summarizePresentTimes } = require('./android-frame-metrics.cjs');
const serial = process.env.ANDROID_SERIAL || process.argv[2];
const seconds = Number(process.argv[3] || 15);
const label = process.argv[4] || 'current-build';
const allowDebug = process.argv.includes('--allow-debug');
if (!serial || !Number.isFinite(seconds) || seconds < 5 || seconds > 60 || !/^[a-z0-9-]+$/i.test(label)) {
  throw new Error('Usage: node capture-android-performance.cjs SERIAL SECONDS LABEL [--allow-debug]; seconds must be 5..60');
}
const packageName = process.env.KINESYNC_PERFORMANCE_PACKAGE || 'dev.kineticron.KineSync';
if (!/^[a-zA-Z][a-zA-Z0-9_.]+$/.test(packageName)) throw new Error('Invalid Android package name');
const adb = async (...args) => (await run('adb', ['-s', serial, ...args], { timeout: 20000, maxBuffer: 4 * 1024 * 1024 })).stdout;
const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] : null;
const cpuTicks = text => {
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
  return Number(fields[11]) + Number(fields[12]);
};
(async () => {
  const packageInfo = await adb('shell', 'dumpsys', 'package', packageName);
  const debug = /flags=\[[^\]]*DEBUGGABLE/.test(packageInfo);
  if (debug && !allowDebug) throw new Error('Installed app is DEBUGGABLE. Install a release build, or explicitly pass --allow-debug for exploratory data.');
  const pid = (await adb('shell', 'pidof', packageName)).trim().split(/\s+/)[0];
  if (!/^\d+$/.test(pid)) throw new Error('Start the app and the desired workload before recording.');
  const layers = await adb('shell', 'dumpsys', 'SurfaceFlinger', '--list');
  const layer = layers.split(/\r?\n/).find(line => line.startsWith(`${packageName}/`)) || `${packageName}/dev.kineticron.KineSync.MainActivity`;
  const [batteryBefore, cpuBefore, uptimeBefore, display] = await Promise.all([
    adb('shell', 'dumpsys', 'battery'), adb('shell', 'cat', `/proc/${pid}/stat`),
    adb('shell', 'cat', '/proc/uptime'), adb('shell', 'dumpsys', 'SurfaceFlinger', '--latency', layer),
  ]);
  await adb('shell', 'dumpsys', 'gfxinfo', packageName, 'reset');
  const started = performance.now();
  const presented = new Set();
  const surfaceSamples = [];
  const startNs = parseFloat(await adb('shell', 'cat', '/proc/uptime')) * 1e9;
  while (performance.now() - started < seconds * 1000) {
    const sample = await adb('shell', 'dumpsys', 'SurfaceFlinger', '--latency', layer);
    surfaceSamples.push(sample);
    collectPresentTimes(sample, startNs, presented);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const elapsedSeconds = (performance.now() - started) / 1000;
  const [gfx, batteryAfter, cpuAfter, memory, lastPid] = await Promise.all([
    adb('shell', 'dumpsys', 'gfxinfo', packageName, 'framestats'), adb('shell', 'dumpsys', 'battery'),
    adb('shell', 'cat', `/proc/${pid}/stat`), adb('shell', 'dumpsys', 'meminfo', packageName), adb('shell', 'pidof', packageName),
  ]);
  if (lastPid.trim().split(/\s+/)[0] !== pid) throw new Error('App process changed during recording; discard this sample.');
  const frames = [];
  let headers;
  for (const line of gfx.split(/\r?\n/)) {
    if (line.startsWith('Flags,IntendedVsync,')) { headers = line.split(','); continue; }
    if (!headers || !/^\d+,\d+,/.test(line)) continue;
    const fields = line.split(',');
    const intended = Number(fields[headers.indexOf('IntendedVsync')]);
    const completed = Number(fields[headers.indexOf('FrameCompleted')]);
    if (Number(fields[0]) !== 0 || intended < parseFloat(uptimeBefore) * 1e9 || completed < intended) continue;
    frames.push((completed - intended) / 1e6);
  }
  const refreshPeriodNs = Number(display.split(/\r?\n/).find(line => /^\d+$/.test(line.trim())));
  const totalFrames = Number(/Total frames rendered:\s*(\d+)/.exec(gfx)?.[1] ?? 0);
  const jankyFrames = Number(/Janky frames:\s*(\d+)/.exec(gfx)?.[1] ?? 0);
  const pssKb = Number(/TOTAL\s+(\d+)/.exec(memory)?.[1] ?? /TOTAL PSS:\s*(\d+)/.exec(memory)?.[1] ?? NaN);
  const directory = path.resolve(__dirname, '../../.cache/performance', label);
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, data] of Object.entries({ 'gfxinfo.txt': gfx, 'meminfo.txt': memory,
    'battery-before.txt': batteryBefore, 'battery-after.txt': batteryAfter })) fs.writeFileSync(path.join(directory, name), data);
  fs.writeFileSync(path.join(directory, 'surfaceflinger-samples.txt'), surfaceSamples.join('\n---SAMPLE---\n'));
  const report = { generatedAt: new Date().toISOString(), serial, packageName,
    version: /versionName=(\S+)/.exec(packageInfo)?.[1], debugBuild: debug, label, elapsedSeconds,
    totalFrames, nativeFramesPerSecond: totalFrames / elapsedSeconds,
    jankyFrames, jankPercent: totalFrames ? jankyFrames / totalFrames * 100 : null,
    framestatsSamples: frames.length, frameTimeP50Ms: percentile(frames, 0.5),
    frameTimeP95Ms: percentile(frames, 0.95), frameTimeP99Ms: percentile(frames, 0.99),
    displayReportedHz: refreshPeriodNs > 0 ? 1e9 / refreshPeriodNs : null,
    ...summarizePresentTimes(presented, elapsedSeconds),
    processCpuTicks: cpuTicks(cpuAfter) - cpuTicks(cpuBefore), pssMb: Number.isFinite(pssKb) ? pssKb / 1024 : null,
    batterySavings: null,
    limitations: [
      'Native gfxinfo does not isolate lyric WebView compositor FPS; idle native frame rate is not an animation FPS score.',
      'Frame percentiles use the bounded framestats ring, not necessarily every frame in the window.',
      'Presentation timestamps are deduplicated from periodic SurfaceFlinger ring samples; delayed polling can miss records.',
      'CPU ticks are raw user+system ticks; no CPU percentage is inferred without a verified CLK_TCK.',
      'BlueStacks battery/current values are simulated; physical-device battery drain is unmeasured.',
      'Only a matched baseline/optimized release-build workload can establish whole-app gains.',
    ],
  };
  fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
