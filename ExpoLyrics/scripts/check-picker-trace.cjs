/* global __dirname */
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const fs = require('node:fs');
const ts = require('typescript');

// Verify shared picker trace in DesktopBridge/src/lyricsAutoPicker.js
const pickerPath = path.join(__dirname, '../../DesktopBridge/src/lyricsAutoPicker.js');
const pickerSource = fs.readFileSync(pickerPath, 'utf8');

function loadPicker(dev, nodeEnv, onLog) {
  const lines = [];
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console: {
      log: (...args) => {
        lines.push(args);
        if (onLog) onLog(...args);
      },
    },
    require: () => ({}),
  };
  if (dev !== undefined) sandbox.__DEV__ = dev;
  if (nodeEnv !== undefined) {
    sandbox.process = { env: { NODE_ENV: nodeEnv } };
  } else if (dev === undefined) {
    sandbox.process = { env: {} };
  }
  vm.runInNewContext(pickerSource, sandbox);
  return { api: sandbox.module.exports, lines };
}

// 1. Production / no-env silence in shared picker
const release = loadPicker(false);
release.api.emitPickerTrace('test', { requestId: 99, stage: 'test' });
assert.equal(release.lines.length, 0, 'PickerTrace is silent when __DEV__ is false');

const prodEnv = loadPicker(undefined, 'production');
prodEnv.api.emitPickerTrace('test', { requestId: 99, stage: 'test' });
assert.equal(prodEnv.lines.length, 0, 'PickerTrace is silent when NODE_ENV is production and __DEV__ absent');

const noEnv = loadPicker(undefined, undefined);
noEnv.api.emitPickerTrace('test', { requestId: 99, stage: 'test' });
assert.equal(noEnv.lines.length, 0, 'PickerTrace is silent when NODE_ENV is missing and __DEV__ absent');

// 2. Dev mode logging in shared picker
const dev = loadPicker(true);
dev.api.emitPickerTrace('test', { requestId: 101, custom: 'data' });
assert.equal(dev.lines.length, 1);
assert.equal(dev.lines[0][0], '[PickerTrace]');
const parsed = JSON.parse(dev.lines[0][1]);
assert.equal(parsed.requestId, 101);
assert.equal(parsed.stage, 'test');
assert.equal(parsed.custom, 'data');

const devEnv = loadPicker(undefined, 'development');
devEnv.api.emitPickerTrace('test', { requestId: 102 });
assert.equal(devEnv.lines.length, 1, 'PickerTrace is active when NODE_ENV is development and __DEV__ absent');

const testEnv = loadPicker(undefined, 'test');
testEnv.api.emitPickerTrace('test', { requestId: 103 });
assert.equal(testEnv.lines.length, 1, 'PickerTrace is active when NODE_ENV is test and __DEV__ absent');

// 3. Provider outcome trace preserves raw provider reason
const providerLogs = [];
const providerPicker = loadPicker(true, undefined, (...args) => {
  if (args[0] === '[PickerTrace]') providerLogs.push(JSON.parse(args[1]));
});
providerPicker.api.emitPickerTrace('provider-outcome', {
  requestId: 104,
  source: 'netease',
  outcome: 'fail',
  reason: 'netease:unreachable-timeout: raw error token=123',
  lineCount: 0,
});
assert.equal(providerLogs.length, 1);
assert.equal(providerLogs[0].stage, 'provider-outcome');
assert.equal(providerLogs[0].outcome, 'fail');
assert.equal(providerLogs[0].reason, 'netease:unreachable-timeout: raw error token=123');

// 4. Comparator evaluations and rules
const lrcSyllable = {
  source: 'lrc-red-karaoke',
  lyrics: [{ lineStartTime: 1000, lineEndTime: 3000, text: 'Secret lyrics line 1' }],
};
const spicyApple = {
  source: 'spicy-lyrics-syllable',
  lyrics: [{ lineStartTime: 1000, lineEndTime: 3000, text: 'Secret lyrics line 1' }],
  metadata: { attribution: { source: 'apple_music', provider: 'Apple Music' } },
};
const spicyCommunity = {
  source: 'spicy-lyrics-syllable',
  lyrics: [{ lineStartTime: 1000, lineEndTime: 3000, text: 'Secret lyrics line 1' }],
  metadata: { attribution: { source: 'spicy_lyrics', provider: 'Spicy Lyrics', community: true } },
};

const checkRule = (actual, expectedUpgrade, expectedRule) => {
  assert.equal(actual.upgrade, expectedUpgrade);
  assert.equal(actual.rule, expectedRule);
};

// Initial candidate rule
checkRule(dev.api.evaluatePreferAutoCandidate({}, null, lrcSyllable), true, 'initial-candidate');

// Community spicy precedence rule
checkRule(dev.api.evaluatePreferAutoCandidate({}, lrcSyllable, spicyCommunity), true, 'community-spicy-priority');
checkRule(dev.api.evaluatePreferAutoCandidate({}, spicyCommunity, lrcSyllable), false, 'community-spicy-priority');

// Equivalent Apple Music TTML: lrc.red wins over Apple Music Spicy
checkRule(dev.api.evaluatePreferAutoCandidate({}, spicyApple, lrcSyllable), true, 'equivalent-lrc');
// Reverse: Apple Music Spicy cannot upgrade over equivalent lrc.red
checkRule(dev.api.evaluatePreferAutoCandidate({}, lrcSyllable, spicyApple), false, 'equivalent-lrc');

// Line timing mismatch rule
const spicyTimingDiff = {
  ...spicyApple,
  lyrics: [{ lineStartTime: 1000, lineEndTime: 3200, text: 'Secret lyrics line 1' }],
};
checkRule(dev.api.evaluatePreferAutoCandidate({}, lrcSyllable, spicyTimingDiff), true, 'line-timing-mismatch');

// Line count mismatch rule
const spicyCountDiff = {
  ...spicyApple,
  lyrics: [
    { lineStartTime: 1000, lineEndTime: 2000, text: 'Secret lyrics line 1' },
    { lineStartTime: 2000, lineEndTime: 3000, text: 'Secret lyrics line 2' },
  ],
};
checkRule(dev.api.evaluatePreferAutoCandidate({}, lrcSyllable, spicyCountDiff), true, 'line-count-mismatch');

// 5. Test lyrics-sync.ts trace using actual shared emitter
const lib = path.resolve(__dirname, '../lib');
function loadSync(devFlag, logCollector, nodeEnv, clientOverride) {
  const file = 'lyrics-sync.ts';
  const code = ts.transpileModule(fs.readFileSync(path.join(lib, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: file,
  }).outputText;
  const track = { id: 'track1', title: 'Song', artist: 'Artist', album: 'Album', durationMs: 180000, spotifyTrackId: 'spotify1' };
  const state = {
    currentTrack: track,
    connectionStatus: 'disconnected',
    lyrics: [],
    lyricsSource: '',
    lyricsMetadata: {},
    lyricsStatusMessage: '',
    setLyrics(lyrics, source) { state.lyrics = lyrics; state.lyricsSource = source; },
    setLyricsMetadata(meta) { state.lyricsMetadata = meta; },
    setLyricsStatusMessage(msg) { state.lyricsStatusMessage = msg; },
    clearLyrics() { state.lyrics = []; },
  };

  let onProgressCallback = null;
  const mockClient = clientOverride || {
    fetchMobileLyricsForTrack: async (reqTrack, options) => {
      onProgressCallback = options.onSyncedLyrics;
      // Emit initial spicy
      if (options.onSyncedLyrics) {
        options.onSyncedLyrics({
          trackId: reqTrack.id,
          source: 'spicy-lyrics-syllable|mobile',
          lyrics: [{ lineStartTime: 1000, lineEndTime: 3000, text: 'Secret lyrics line 1' }],
          metadata: { attribution: { source: 'apple_music', provider: 'Apple Music' }, credits: { songwriters: ['Songwriter A'] } },
        });
      }
      // Emit late progressive lrc upgrade
      if (options.onSyncedLyrics) {
        options.onSyncedLyrics({
          trackId: reqTrack.id,
          source: 'lrc-red-karaoke|mobile',
          lyrics: [{ lineStartTime: 1000, lineEndTime: 3000, text: 'Secret lyrics line 1' }],
          metadata: { attribution: { source: 'lrc-red', provider: 'lrc.red' }, credits: { songwriters: ['Songwriter A'] } },
        });
      }
      // Return final upgraded lrc result
      return {
        trackId: reqTrack.id,
        source: 'lrc-red-karaoke|mobile',
        lyrics: [{ lineStartTime: 1000, lineEndTime: 3000, text: 'Secret lyrics line 1' }],
        metadata: { attribution: { source: 'lrc-red', provider: 'lrc.red' }, credits: { songwriters: ['Songwriter A'] } },
      };
    },
  };

  const sharedPickerInstance = loadPicker(devFlag, nodeEnv, (...args) => {
    if (args[0] === '[PickerTrace]') logCollector.push(JSON.parse(args[1]));
  });

  const module = { exports: {} };
  const syncSandbox = {
    module,
    exports: module.exports,
    console: {
      log: (...args) => {
        if (args[0] === '[PickerTrace]') logCollector.push(JSON.parse(args[1]));
      },
    },
    require: (name) => {
      if (name === '@/lib/mobile-lyrics-client') return mockClient;
      if (name === '@/store/playback-store') return { usePlaybackStore: { getState: () => state } };
      if (name === '@/lib/bridge-client') return { bridgeClient: {} };
      if (name === '@/lib/mobile-lyrics-vault') return {};
      if (name.includes('lyricsAutoPicker') || name === '../../DesktopBridge/src/lyricsAutoPicker') {
        return sharedPickerInstance.api;
      }
      return {};
    },
  };
  if (devFlag !== undefined) syncSandbox.__DEV__ = devFlag;
  if (nodeEnv !== undefined) syncSandbox.process = { env: { NODE_ENV: nodeEnv } };
  else if (devFlag === undefined) syncSandbox.process = { env: {} };

  vm.runInNewContext(code, syncSandbox);
  return { sync: module.exports, state, triggerLate: (packet) => onProgressCallback?.(packet) };
}

// 5a. Production & no-env silence in sync layer
const releaseLogs = [];
const releaseHarness = loadSync(false, releaseLogs);
releaseHarness.sync.refreshLyricsForCurrentTrack('auto');
assert.equal(releaseLogs.length, 0, 'No PickerTrace emitted when __DEV__ is false in sync layer');

const prodLogs = [];
const prodHarness = loadSync(undefined, prodLogs, 'production');
prodHarness.sync.refreshLyricsForCurrentTrack('auto');
assert.equal(prodLogs.length, 0, 'No PickerTrace emitted when NODE_ENV is production and __DEV__ absent in sync layer');

const noEnvLogs = [];
const noEnvHarness = loadSync(undefined, noEnvLogs, undefined);
noEnvHarness.sync.refreshLyricsForCurrentTrack('auto');
assert.equal(noEnvLogs.length, 0, 'No PickerTrace emitted when NODE_ENV missing and __DEV__ absent in sync layer');

// 5b. Dev mode test - full trace covering progressive late lrc upgrade and display commit
(async () => {
  const devLogs = [];
  const devHarness = loadSync(true, devLogs);
  await devHarness.sync.refreshLyricsForCurrentTrack('auto');

  assert.ok(devLogs.length >= 6, 'Multiple PickerTrace events emitted in dev mode');
  const reqId = devLogs[0].requestId;
  assert.equal(typeof reqId, 'number');
  assert.ok(reqId > 0);

  // Every single trace event must correlate by the same request ID
  for (const entry of devLogs) {
    assert.equal(entry.requestId, reqId, 'Trace events correlate by request ID');
  }

  // Initial Spicy progress commit
  const initialCommit = devLogs.find((e) => e.stage === 'display-commit' && e.source.includes('spicy'));
  assert.ok(initialCommit, 'Display commit logged initial spicy source');
  assert.equal(initialCommit.credit.provider, 'Apple Music');
  assert.equal(initialCommit.lineCount, 1);

  // Progressive late lrc upgrade commit
  const lateCommit = devLogs.find((e) => e.stage === 'display-commit' && e.source.includes('lrc-red'));
  assert.ok(lateCommit, 'Display commit logged progressive late lrc upgrade');
  assert.equal(lateCommit.credit.provider, 'lrc.red');
  assert.equal(lateCommit.credit.attributionSource, 'lrc-red');
  assert.equal(lateCommit.lineCount, 1);

  // Final store state matches late lrc upgrade
  assert.equal(devHarness.state.lyricsSource, 'lrc-red-karaoke|mobile');

  // Verify callback guard accept & discard logs
  const guards = devLogs.filter((e) => e.stage === 'callback-guard');
  assert.ok(guards.some((g) => g.decision === 'accept' && g.reason === 'current-track-request-match'));
  assert.ok(guards.some((g) => g.decision === 'accept' && g.reason === 'commit-accepted'));

  // Discard check: stale request ID or bridge connection
  devHarness.state.connectionStatus = 'connected';
  devHarness.triggerLate({ trackId: 'track1', source: 'stale-source', lyrics: [], metadata: {} });
  const bridgeDiscard = devLogs.find((e) => e.stage === 'callback-guard' && e.reason === 'bridge-connected');
  assert.ok(bridgeDiscard, 'Guard logged discard when bridge connected');

  // Verify lyric lines are not dumped in logs
  for (const entry of devLogs) {
    const serialized = JSON.stringify(entry);
    assert.ok(!serialized.includes('Secret lyrics'), 'No lyric text leaked in logs');
  }

  // 5c. Raw error preserved in DEV sync-error
  const errorLogs = [];
  const rawErrorMessage = 'upstream provider failure: raw token=secret-auth-failed';
  const errorHarness = loadSync(true, errorLogs, undefined, {
    fetchMobileLyricsForTrack: async () => {
      throw new Error(rawErrorMessage);
    },
  });
  await errorHarness.sync.refreshLyricsForCurrentTrack('auto');
  const errorTrace = errorLogs.find((e) => e.stage === 'callback-guard' && e.target === 'sync-error');
  assert.ok(errorTrace, 'Sync error guard logged');
  assert.ok(errorTrace.error.includes(rawErrorMessage), 'Raw error message is preserved in DEV without sanitization');
  assert.ok(errorHarness.state.lyricsStatusMessage.includes(rawErrorMessage), 'Status message preserves raw error message');

  console.log('PickerTrace diagnostics check passed: dev-only silence, correlated requestId, provider outcomes, comparator rules (including equivalent-lrc), callback guards, and progressive late lrc upgrade with final committed display source and credit.');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
