/* Run only with an already installed compatible development binary on a physical Android device.
 * Fixture workload, not live-provider or actual-presentation evidence. No build or installation.
 */
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const matrix = ['amll', 'spicy'].flatMap(style => ['portrait', 'landscape'].flatMap(orientation =>
  ['start', 'mid-song', 'overlap'].map(scenario => ({ style, orientation, scenario }))));
if (process.argv.includes('--plan')) {
  console.log(JSON.stringify({ matrix, requires: ['physical Android device', 'existing compatible dev binary', 'bundled arrival-lab route', 'thermal/power/refresh/debugger metadata recorded separately'], actualPresentation: 'unavailable' }));
  process.exit(0);
}
const serial = process.argv[2];
if (!serial) { console.error('Usage: node scripts/profile-lyrics-arrival.cjs PHYSICAL_SERIAL OUTPUT.json'); process.exit(2); }
const output = process.argv[3];
if (!output) throw Error('Explicit output path required');
const adb = (...args) => execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 20000 });
if (adb('shell', 'getprop', 'ro.kernel.qemu').trim() === '1') throw Error('Physical device required');
const packageName = process.env.KINESYNC_PERFORMANCE_PACKAGE || 'dev.kineticron.KineSync';
if (!/^[a-zA-Z][a-zA-Z0-9_.]+$/.test(packageName)) throw Error('Invalid package');
const results = [];
(async () => {
  const device = { serial, model: adb('shell', 'getprop', 'ro.product.model').trim(), os: adb('shell', 'getprop', 'ro.build.version.release').trim() };
  const oldRotation = adb('shell', 'settings', 'get', 'system', 'user_rotation').trim();
  const oldAuto = adb('shell', 'settings', 'get', 'system', 'accelerometer_rotation').trim();
  try {
    for (const { style, orientation, scenario } of matrix) {
      const run = `${Date.now()}-${style}-${orientation}-${scenario}`;
      adb('shell', 'am', 'force-stop', packageName);
      adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
      adb('shell', 'settings', 'put', 'system', 'user_rotation', orientation === 'landscape' ? '1' : '0');
      const logger = spawn('adb', ['-s', serial, 'logcat', '-v', 'raw', '-s', 'ReactNativeJS:I']);
      let buffer = '';
      const chunks = new Map();
      let chunkTotal = 0;
      try {
        const result = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error(`No trace for ${run}; verify installed dev binary and deep link`)), 30000);
          logger.on('error', error => { clearTimeout(timer); reject(error); });
          logger.stdout.on('data', chunk => {
            buffer = (buffer + chunk).slice(-2 * 1024 * 1024);
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
              const marker = line.indexOf('KINESYNC_ARRIVAL_CHUNK ');
              if (marker < 0) continue;
              try {
                const part = JSON.parse(line.slice(marker + 'KINESYNC_ARRIVAL_CHUNK '.length));
                if (part.run !== run || !Number.isInteger(part.total) || part.total < 1 || part.total > 1024 ||
                    !Number.isInteger(part.index) || part.index < 0 || part.index >= part.total ||
                    typeof part.data !== 'string' || part.data.length > 1200) continue;
                if (chunkTotal && chunkTotal !== part.total) continue;
                chunkTotal = part.total; chunks.set(part.index, part.data);
                if (chunks.size === chunkTotal) {
                  const data = JSON.parse(Array.from({ length: chunkTotal }, (_, index) => chunks.get(index)).join(''));
                  if (data.run === run) { clearTimeout(timer); resolve(data); }
                }
              } catch {}
            }
          });
        });
        const uri = `expolyrics://arrival-lab?${new URLSearchParams({ style, orientation, scenario, run })}`;
        adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', `'${uri}'`, packageName);
        results.push(await result);
        fs.writeFileSync(output, JSON.stringify({ device, measurement: 'native fixture workload; actual correct presentation unavailable', results }, null, 2));
      } finally { logger.kill(); }
    }
  } finally {
    adb('shell', 'settings', 'put', 'system', 'user_rotation', oldRotation);
    adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', oldAuto);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
