/* global __dirname */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const vm = require('node:vm');
const ts = require('typescript');
const { runPerformanceBenchmarks } = require('./performance-benchmark-suite.cjs');
const serial = process.env.ANDROID_SERIAL || process.argv[2];
if (!serial) throw new Error('Pass the emulator serial, e.g. 127.0.0.1:5555');
const root = path.resolve(__dirname, '..');
const adb = (...args) => execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 15000 }).trim();
const pid = adb('shell', 'pidof', 'dev.kineticron.KineSync').split(/\s+/)[0];
if (!/^\d+$/.test(pid)) throw new Error('KineSync must be running with a debuggable WebView');
const port = adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
const context = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, 'components/lyrics/active-line-timeline.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, context);
(async () => {
  let socket;
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl);
    if (!target) throw new Error('No KineSync WebView debugger target is available');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    const measured = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Emulator benchmark timed out')), 60000);
      socket.addEventListener('error', error => { clearTimeout(timer); reject(error); });
      socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
        // Pure JS only: no DOM changes, navigation or app-state mutations.
        expression: `JSON.stringify({ runtime: navigator.userAgent, ...(${runPerformanceBenchmarks.toString()})(${context.exports.createActiveLineTimeline.toString()}) })`,
        returnByValue: true,
      } })));
      socket.addEventListener('message', event => {
        const response = JSON.parse(event.data);
        if (response.id !== 1) return;
        clearTimeout(timer);
        if (response.error || response.result?.exceptionDetails) reject(new Error(JSON.stringify(response)));
        else resolve(JSON.parse(response.result.result.value));
      });
    });
    const directory = path.join(root, '../.cache/performance');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'emulator-benchmark.json'), JSON.stringify({
      generatedAt: new Date().toISOString(), serial,
      buildScope: 'Identical pure JS A/B workload in the installed WebView engine; not a native release-build comparison.',
      ...measured,
    }, null, 2));
    console.table(measured.results.map(row => ({ lines: row.lineCount,
      before_us: row.baselineUsPerLookup.toFixed(3), after_us: row.optimizedUsPerLookup.toFixed(3),
      speedup: `${row.speedup.toFixed(1)}x`, cpu_reduction: `${row.reductionPercent.toFixed(1)}%`,
    })));
    console.log(measured.caveat);
  } finally {
    socket?.close();
    adb('forward', '--remove', `tcp:${port}`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
