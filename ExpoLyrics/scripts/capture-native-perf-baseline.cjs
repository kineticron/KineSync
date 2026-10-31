/* global __dirname */
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { setTimeout: delay } = require('node:timers/promises');

// Resolve ws from ExpoLyrics/node_modules
let WS;
try {
  WS = require('ws');
} catch {
  WS = require(path.join(__dirname, '../node_modules/ws'));
}

const args = process.argv.slice(2);
let seconds = 20;
let outputPath = null;
let cpuProfilePath = null;
const initialLabels = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--out' && args[i + 1]) {
    outputPath = args[++i];
  } else if ((arg === '--cpuprofile' || arg === '--profile') && args[i + 1]) {
    cpuProfilePath = args[++i];
  } else if (arg === '--label' && args[i + 1]) {
    initialLabels.push(args[++i]);
  } else if (!arg.startsWith('-') && Number.isFinite(Number(arg)) && Number(arg) > 0) {
    seconds = Number(arg);
  }
}

const base = process.env.METRO_URL || 'http://127.0.0.1:8081';
const origin = process.env.METRO_ORIGIN || 'http://127.0.0.1:8081';

let socket;
let sequence = 0;
let done = false;
const pending = new Map();

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(method + ' timed out after 20 seconds'));
    }, 20000);
    pending.set(id, { resolve, reject, timer, method });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await call('Runtime.evaluate', {
    expression,
    returnByValue: true,
  });
  if (result?.exceptionDetails) {
    throw new Error('Evaluation failed: ' + JSON.stringify(result.exceptionDetails));
  }
  return result?.result?.value;
}

async function recordDeviceLabel(labelName) {
  const safe = String(labelName || '').trim();
  if (!safe) return;
  try {
    await evaluate(`(function() {
      if (typeof globalThis.__kinesyncPerf !== 'undefined' && typeof globalThis.__kinesyncPerf.label === 'function') {
        globalThis.__kinesyncPerf.label(${JSON.stringify(safe)});
        return true;
      }
      return false;
    })()`);
    console.log(`[LABEL RECORDED] ${safe}`);
  } catch (err) {
    console.warn(`Failed to record label '${safe}': ${err.message}`);
  }
}

async function main() {
  console.log(`Connecting to Metro CDP at ${base}...`);
  let pages;
  try {
    const response = await fetch(base + '/json/list', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Device discovery failed HTTP ' + response.status);
    pages = await response.json();
  } catch (err) {
    throw new Error(`Could not query ${base}/json/list. Ensure Metro is running. (${err.message})`);
  }

  const page = pages.find(p => p.description?.includes('C++ connection') || p.title?.includes('Hermes')) || pages[0];
  const address = page?.webSocketDebuggerUrl;
  if (!address) {
    throw new Error('No Hermes device listed. Open the app dev client on the phone or emulator.');
  }

  console.log(`Connecting to Hermes target (${page.title || 'React Native Hermes'})...`);
  socket = new WS(address, { headers: { Origin: origin }, handshakeTimeout: 5000, maxPayload: 128 * 1024 * 1024 });

  socket.on('message', data => {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(waiter.method + ' failed: ' + JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  });

  socket.on('close', (code, reason) => {
    if (!done) console.error('CDP debugger disconnected', code, reason.toString());
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Debugger disconnected ' + code));
    }
    pending.clear();
  });

  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  socket.on('error', error => console.error('WebSocket error:', error.message));

  // Note: Hermes supports start/stop directly, but not Profiler.enable.
  console.log('Arming __kinesyncPerf on device...');
  const armStatus = await evaluate(`
    (function() {
      if (typeof globalThis.__kinesyncPerf !== 'undefined') {
        globalThis.__kinesyncPerf.reset();
        globalThis.__kinesyncPerf.arm();
        return 'ARMED';
      }
      return 'UNAVAILABLE';
    })()
  `);

  if (armStatus !== 'ARMED') {
    throw new Error('globalThis.__kinesyncPerf is unavailable on target device. Ensure __DEV__ is enabled.');
  }

  let profileStartAlign = null;
  if (cpuProfilePath) {
    console.log(`Starting Hermes CPU profile recording for ${cpuProfilePath}...`);
    profileStartAlign = await evaluate(`
      (function() {
        return {
          wallClockMs: Date.now(),
          perfNowMs: typeof performance !== 'undefined' ? performance.now() : Date.now()
        };
      })()
    `);
    await call('Profiler.start');
  }

  // Record any initial CLI labels
  for (const lbl of initialLabels) {
    await recordDeviceLabel(lbl);
  }

  console.log('\n=============================================================');
  console.log('__kinesyncPerf is ARMED on device.');
  console.log('Perform user-driven actions now:');
  console.log('  - Song skip / new lyrics arrival');
  console.log('  - AMLL <-> Spicy renderer switch');
  console.log('  - Portrait <-> Landscape screen rotation');
  console.log('You can type label names into this terminal and press Enter to mark operations.');
  console.log(`Waiting ${seconds}s (or press Enter on empty line to finish)...`);
  console.log('=============================================================\n');

  // Wait for duration or user pressing Enter on empty line (do NOT auto-skip or auto-rotate)
  let stopWaiting;
  const waitPromise = new Promise(resolve => {
    stopWaiting = resolve;
  });
  const timeoutId = setTimeout(stopWaiting, seconds * 1000);

  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('line', async line => {
      const text = line.trim();
      if (!text || text === 'done' || text === 'exit' || text === 'quit') {
        clearTimeout(timeoutId);
        rl.close();
        stopWaiting();
      } else {
        await recordDeviceLabel(text);
      }
    });
  }

  await waitPromise;

  let profileData = null;
  let profileStopAlign = null;
  if (cpuProfilePath) {
    console.log('Stopping Hermes CPU profile...');
    try {
      profileStopAlign = await evaluate(`
        (function() {
          return {
            wallClockMs: Date.now(),
            perfNowMs: typeof performance !== 'undefined' ? performance.now() : Date.now()
          };
        })()
      `);
      const stopResult = await call('Profiler.stop');
      profileData = stopResult?.profile;
      if (profileData) {
        profileData.alignment = {
          start: profileStartAlign,
          stop: profileStopAlign,
        };
        fs.mkdirSync(path.dirname(path.resolve(cpuProfilePath)), { recursive: true });
        fs.writeFileSync(path.resolve(cpuProfilePath), JSON.stringify(profileData), 'utf8');
        console.log(`Saved correlated CPU profile to ${cpuProfilePath} (${profileData.nodes?.length || 0} nodes, ${profileData.samples?.length || 0} samples)`);
      }
    } catch (err) {
      console.warn(`Could not save CPU profile: ${err.message}`);
    }
  }

  console.log('Disarming and retrieving summary JSON from device...');
  const summaryJson = await evaluate(`
    (function() {
      if (typeof globalThis.__kinesyncPerf !== 'undefined') {
        var s = globalThis.__kinesyncPerf.summary();
        globalThis.__kinesyncPerf.disarm();
        return JSON.stringify(s);
      }
      return null;
    })()
  `);

  if (!summaryJson) {
    throw new Error('Failed to retrieve summary JSON from device.');
  }

  const summary = JSON.parse(summaryJson);
  if (cpuProfilePath && profileStartAlign) {
    summary.cpuProfile = {
      path: cpuProfilePath,
      alignment: {
        start: profileStartAlign,
        stop: profileStopAlign,
      },
    };
  }

  console.log('\n--- KineSync Native Perf Baseline Summary ---');
  console.log(JSON.stringify(summary, null, 2));

  const cl = summary.callbackLateness || summary.jsThreadBlocks;
  if (cl) {
    console.log('\n--- rAF Callback Lateness / Frame Gap ---');
    console.log(`Notice: ${summary.callbackLatenessNotice || 'Measures callback lateness/frame gap, NOT continuous JS blocking'}`);
    console.log(`Samples: ${cl.sampleCount}`);
    console.log(`Max frame gap: ${cl.maxFrameGapMs ?? cl.maxBlockMs}ms`);
    console.log(`Frame gaps >= 100ms (gap >=100ms target comparison): ${cl.gapsOver100ms ?? cl.blocksOver100ms}`);
    console.log(`Frame gaps >= 50ms: ${cl.gapsOver50ms ?? cl.blocksOver50ms}`);
    console.log(`Frame gaps >= 250ms: ${cl.gapsOver250ms ?? cl.blocksOver250ms}`);
    console.log(`Frame gaps >= 1000ms: ${cl.gapsOver1000ms ?? cl.blocksOver1000ms}`);
  }
  if (summary.arrivals && summary.arrivals.length > 0) {
    console.log(`\nRetained arrivals (${summary.arrivals.length}):`);
    for (const arr of summary.arrivals) {
      console.log(`  Arrival ${arr.arrivalId} [${arr.kind}] (superseded=${arr.superseded}) track="${arr.trackLabel}":`);
      for (const [stg, data] of Object.entries(arr.stages)) {
        if (data.status === 'recorded') {
          console.log(`    ${stg}: count=${data.count}, avg=${data.avgDurationMs}ms, total=${data.totalDurationMs}ms`);
        } else {
          console.log(`    ${stg}: unavailable`);
        }
      }
    }
  }

  if (outputPath) {
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outputPath), JSON.stringify(summary, null, 2), 'utf8');
    console.log(`\nSaved summary JSON to ${outputPath}`);
  }

  done = true;
  socket.close(1000);
}

main().catch(err => {
  console.error('Error:', err.message);
  done = true;
  if (socket) socket.terminate();
  process.exitCode = 1;
});
