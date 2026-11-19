/* global __dirname */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const serial = process.argv[2] || process.env.ANDROID_SERIAL;
const selectedStyle = process.argv[3] || 'both';
const canvasOnly = process.argv.includes('--canvas-only');
const parityCandidates = process.argv.includes('--parity-candidates');
const scenario = process.argv[4] || 'playback';
if (!serial || !['amll', 'spicy', 'both'].includes(selectedStyle) || !['playback', 'scroll', 'stall', 'paused', 'long'].includes(scenario)) {
  throw new Error('Usage: node scripts/profile-native-lyrics.cjs SERIAL [both|amll|spicy] [playback|scroll|stall|paused|long]');
}
const root = path.resolve(__dirname, '..');
const directory = path.resolve(root, '../.cache/performance/native-lyrics', scenario);
const packageName = process.env.KINESYNC_PERFORMANCE_PACKAGE || 'dev.kineticron.KineSync';
if (!/^[a-zA-Z][a-zA-Z0-9_.]+$/.test(packageName)) throw new Error('Invalid Android package name');
fs.mkdirSync(directory, { recursive: true });
const adb = (...args) => execFileSync('adb', ['-s', serial, ...args], { timeout: 20000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const configurations = canvasOnly ? [{ backend: 'flash', reveal: 'canvas' }] : parityCandidates ? [
  { backend: 'webview', reveal: 'clip' }, { backend: 'flash', reveal: 'canvas' },
] : [
  { backend: 'webview', reveal: 'clip' },
  { backend: 'flat', reveal: 'clip' },
  { backend: 'flash', reveal: 'clip' },
  { backend: 'flash', reveal: 'mask' },
  { backend: 'flash', reveal: 'canvas' },
];
(async () => {
  const comparisonPath = path.join(directory, 'comparison.json');
  const reports = fs.existsSync(comparisonPath) ? JSON.parse(fs.readFileSync(comparisonPath, 'utf8')) : [];
  for (const style of selectedStyle === 'both' ? ['spicy', 'amll'] : [selectedStyle]) {
    for (const configuration of configurations) {
      const { backend, reveal } = configuration;
      const label = `native-lab-${style}-${backend}-${reveal}-${scenario}`;
      const runId = String(Date.now());
      const query = new URLSearchParams({ renderer: style, backend, reveal, lines: scenario === 'long' ? '2000' : '100',
        paused: scenario === 'paused' ? '1' : '0', stall: scenario === 'stall' ? '1' : '0', run: runId });
      const uri = `expolyrics://renderer-lab?${query}`;
      console.log(`Starting ${label}`);
      // Stream before launch: noisy GPU drivers can evict readiness/profile markers
      // from logcat's ring before a later snapshot reads them.
      let streamedLog = '';
      const logger = spawn('adb', ['-s', serial, 'logcat', '-s', 'ReactNativeJS:I'], { stdio: ['ignore', 'pipe', 'ignore'] });
      logger.stdout.on('data', chunk => { streamedLog = (streamedLog + chunk).slice(-2 * 1024 * 1024); });
      try {
      // Quote the complete URI for Android's remote shell, keeping & inside the argument.
      adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', `'${uri}'`, packageName);
      const deadline = Date.now() + 15000;
      while (!streamedLog.includes(`"run":"${runId}"`) && Date.now() < deadline) await pause(250);
      await pause(3000);
      // UIAutomator waits for idle and can time out on a continuously animated screen.
      // Verify the unique route instance through its one-shot readiness marker instead.
      const readinessLog = streamedLog;
      if (!readinessLog.includes(`"run":"${runId}"`)) throw new Error(`${label} did not mount. Resolve the app/runtime error before profiling.`);
      const gestures = scenario === 'scroll' ? (async () => {
        for (let i = 0; i < 10; i++) {
          adb('shell', 'input', 'swipe', '600', i % 2 ? '500' : '1500', '600', i % 2 ? '1500' : '500', '350');
          await pause(600);
        }
      })() : Promise.resolve();
      const [capture] = await Promise.all([
        run(process.execPath, [path.join(root, 'scripts/capture-android-performance.cjs'), serial, '12', label, '--allow-debug'],
          { cwd: root, timeout: 60000, maxBuffer: 4 * 1024 * 1024 }), gestures,
      ]);
      const metrics = JSON.parse(capture.stdout);
      const log = streamedLog;
      const profiles = log.split(/\r?\n/).filter(line => line.includes('KINESYNC_NATIVE_PROFILE '));
      let js = null;
      if (profiles.length) {
        const candidate = JSON.parse(profiles.at(-1).split('KINESYNC_NATIVE_PROFILE ')[1]);
        if (candidate.run === runId && candidate.backend === backend && candidate.style === style && candidate.reveal === reveal) js = candidate;
      }
      const screenshot = execFileSync('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], { timeout: 20000, maxBuffer: 12 * 1024 * 1024 });
      fs.writeFileSync(path.join(directory, `${label}.png`), screenshot);
      const report = { style, backend, reveal, scenario, js, metrics };
      const previous = reports.findIndex(item => item.style === style && item.backend === backend && item.reveal === reveal);
      if (previous >= 0) reports[previous] = report; else reports.push(report);
      fs.writeFileSync(comparisonPath, JSON.stringify(reports, null, 2));
      console.log(JSON.stringify({ label, jsP95Ms: js?.jsDelayP95Ms, presentationP95Ms: metrics.presentIntervalP95Ms,
        jankPercent: metrics.jankPercent, cpuTicks: metrics.processCpuTicks, pssMb: metrics.pssMb }));
      } finally { logger.kill(); }
    }
  }
  console.log(`Saved matched exploratory debug measurements to ${directory}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
