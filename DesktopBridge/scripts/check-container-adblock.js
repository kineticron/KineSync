const { execFileSync } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');
const { WebSocket } = require('ws');

const origin = 'http://127.0.0.1:43880';
const extensionPath = /\/extensions\/adblock\.js(?:[?#]|$)/i;
const observeMs = 15000;

async function findPlayerPage() {
  const deadline = Date.now() + 90000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/json/list`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error(`DevTools returned HTTP ${response.status}`);
      const page = (await response.json()).find(({ type, url, webSocketDebuggerUrl }) =>
        type === 'page' && url.includes('xpui') && webSocketDebuggerUrl);
      if (page) return page;
      lastError = new Error('Spotify xpui page is absent from DevTools');
    } catch (error) {
      lastError = error;
    }
    await sleep(1000);
  }
  throw new Error(`Spotify renderer did not start: ${lastError?.message}`);
}

async function main() {
  const page = await findPlayerPage();
  const socket = new WebSocket(page.webSocketDebuggerUrl, { origin, handshakeTimeout: 5000 });
  const pending = new Map();
  const errors = [];
  let sequence = 0;
  try {
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.on('error', reject);
    });
    socket.on('message', raw => {
      const { id, result, error, method, params } = JSON.parse(String(raw));
      if (pending.has(id)) {
        const { resolve, reject, timer } = pending.get(id);
        clearTimeout(timer);
        pending.delete(id);
        if (error) reject(new Error(error.message));
        else resolve(result);
      } else if (method === 'Debugger.scriptFailedToParse' && extensionPath.test(params.url)) {
        errors.push('adblock.js failed to parse');
      } else if (method === 'Runtime.exceptionThrown' ||
          (method === 'Runtime.consoleAPICalled' && params.type === 'error') ||
          (method === 'Log.entryAdded' && params.entry.level === 'error')) {
        const details = JSON.stringify(params);
        if (/adblockify:|extensions\/adblock\.js/i.test(details)) {
          errors.push(params.exceptionDetails?.exception?.description ||
            params.entry?.text || params.args?.[0]?.value || 'adblock.js raised a runtime error');
        }
      }
    });
    function call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`DevTools timed out: ${method}`));
        }, 5000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    }

    await call('Page.enable');
    await call('Runtime.enable');
    await call('Debugger.enable');
    await call('Log.enable');
    await call('Profiler.enable');
    await call('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
    await call('Page.reload', { ignoreCache: true });
    await sleep(observeMs);
    const { result: coverage } = await call('Profiler.takePreciseCoverage');
    const { result: spicetify, exceptionDetails } = await call('Runtime.evaluate', {
      expression: 'typeof globalThis.Spicetify === "object" && Boolean(globalThis.Spicetify.Events)',
      returnByValue: true,
    });
    if (exceptionDetails || !spicetify.value) throw new Error('Spicetify did not initialize in Spotify');
    if (errors.length) throw new Error(`adblock.js startup errors: ${errors.join(' | ')}`);
    if (!coverage.some(script => extensionPath.test(script.url) &&
        script.functions.some(fn => fn.ranges.some(range => range.count > 0)))) {
      throw new Error('DevTools did not observe execution of the bundled adblock.js');
    }
    console.log(JSON.stringify({
      spotifyPackage: execFileSync('dpkg-query', ['-W', '-f=${Version}', 'spotify-client:amd64'], { encoding: 'utf8' }),
      spicetifyApplied: true,
      adblockExecuted: true,
      extensionErrors: errors.length,
      observeMs,
      accountTier: 'signed-out startup',
      playbackMeasured: false,
    }));
  } finally {
    socket.terminate();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
