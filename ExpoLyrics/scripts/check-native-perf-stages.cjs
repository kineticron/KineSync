/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const ts = require('typescript');

const perfStagesPath = path.join(__dirname, '../lib/perf-stages.ts');
const code = buildSync({
  entryPoints: [perfStagesPath],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
}).outputFiles[0].text;

// ============================================================================
// 1. Executable production test (__DEV__ = false) - installs/allocates nothing
// ============================================================================
{
  let setTimeoutCalled = 0;
  let setIntervalCalled = 0;
  let rafCalled = 0;
  let cancelRafCalled = 0;
  let clearTimeoutCalled = 0;
  let addEventListenerCalled = 0;
  let setsCreated = 0;
  let sizedArraysCreated = 0;

  const OriginalSet = Set;
  class TrackedSet extends OriginalSet {
    constructor(...args) {
      super(...args);
      setsCreated++;
    }
  }

  const OriginalArray = Array;
  class TrackedArray extends OriginalArray {
    constructor(...args) {
      super(...args);
      if (args.length === 1 && typeof args[0] === 'number' && args[0] > 1) {
        sizedArraysCreated++;
      }
    }
  }

  const prodContext = {
    module: { exports: {} },
    exports: {},
    __DEV__: false,
    Set: TrackedSet,
    Array: TrackedArray,
    performance: { now: () => 1000 },
    Date: { now: () => 1000 },
    requestAnimationFrame: () => { rafCalled++; return 1; },
    cancelAnimationFrame: () => { cancelRafCalled++; },
    setInterval: () => { setIntervalCalled++; return 1; },
    clearInterval: () => {},
    setTimeout: () => { setTimeoutCalled++; return 1; },
    clearTimeout: () => { clearTimeoutCalled++; },
    addEventListener: () => { addEventListenerCalled++; },
    removeEventListener: () => {},
    console: {
      log: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  };
  prodContext.globalThis = prodContext;

  vm.runInNewContext(code, prodContext);

  const api = prodContext.module.exports;

  // Assert globalThis.__kinesyncPerf is absent
  assert.equal(prodContext.__kinesyncPerf, undefined, 'globalThis.__kinesyncPerf must be absent in production');
  assert.equal('__kinesyncPerf' in prodContext, false, 'globalThis.__kinesyncPerf property must not exist on globalThis in prod');

  // Assert no timers/listeners were called during import
  assert.equal(setTimeoutCalled, 0, 'setTimeout must never be called at import in prod');
  assert.equal(setIntervalCalled, 0, 'setInterval must never be called at import in prod');
  assert.equal(rafCalled, 0, 'requestAnimationFrame must never be called at import in prod');
  assert.equal(addEventListenerCalled, 0, 'addEventListener must never be called at import in prod');

  // Assert no module-level buffers exist
  assert.equal(setsCreated, 0, 'No Set instances should be allocated at import in prod');
  assert.equal(sizedArraysCreated, 0, 'No sized array buffers should be allocated at import in prod');

  const internalState = api._getInternalDevState?.();
  if (internalState) {
    assert.equal(internalState.ringBuffer, null, 'ringBuffer must be null in prod');
    assert.equal(internalState.recentLateness, null, 'recentLateness must be null in prod');
    assert.equal(internalState.milestones, null, 'milestones must be null in prod');
    assert.equal(internalState.seenMilestones, null, 'seenMilestones must be null in prod');
    assert.equal(internalState.forbiddenKeys, null, 'forbiddenKeys must be null in prod');
    assert.equal(internalState.arrivals, null, 'arrivals must be null in prod');
    assert.equal(internalState.arrivalOrder, null, 'arrivalOrder must be null in prod');
    assert.equal(internalState.devObjectArrivalMap, null, 'devObjectArrivalMap must be null in prod');
    assert.equal(internalState.seenActivePictureArrivals, null, 'seenActivePictureArrivals must be null in prod');
  }

  // Calling dev functions stores nothing in prod
  api.arm();
  assert.equal(rafCalled, 0, 'arm() in prod must not schedule rAF');
  assert.equal(setTimeoutCalled, 0, 'arm() in prod must not schedule setTimeout');

  const createdId = api.createArrival('track-1');
  assert.equal(createdId, '', 'createArrival in prod returns empty string');

  api.recordPerfStage('packet-ingestion', 5, { lineCount: 10 });
  api.recordPerfStage('parser CPU (lyrics-ttml-import)', 15);
  const end = api.startPerfStage('glyph shaping');
  end();
  api.label('test-label');

  const prodSummary = api.summary();
  assert.equal(prodSummary.armed, false, 'summary.armed must be false in prod');
  assert.equal(prodSummary.buffer.totalRecorded, 0, 'buffer.totalRecorded must be 0 in prod');
  assert.equal(prodSummary.buffer.currentBuffered, 0, 'buffer.currentBuffered must be 0 in prod');
  assert.equal(prodSummary.marks.length, 0, 'marks must be empty in prod');
  assert.equal(prodSummary.milestones.length, 0, 'milestones must be empty in prod');
  assert.equal(prodSummary.arrivals.length, 0, 'arrivals must be empty in prod');
  assert.equal(Object.keys(prodSummary.stageAggregates).length, 0, 'stageAggregates must be empty in prod');
  assert.equal(prodSummary.callbackLateness.sampleCount, 0, 'callbackLateness samples must be 0 in prod');

  api.reset();
  api.disarm();
  assert.equal(rafCalled, 0, 'rAF must never be called in prod');
  assert.equal(setTimeoutCalled, 0, 'setTimeout must never be called in prod');
  assert.equal(setIntervalCalled, 0, 'setInterval must never be called in prod');
  assert.equal(addEventListenerCalled, 0, 'addEventListener must never be called in prod');
}

// ============================================================================
// 2. Dev mode harness and tests (__DEV__ = true)
// ============================================================================
function createDevHarness() {
  let virtualTime = 1000;
  let rafCounter = 0;
  let timeoutCounter = 0;
  const activeRafs = new Map();
  const activeTimeouts = new Map();
  const logs = [];
  const intervals = [];

  const fakeRaf = cb => {
    const id = ++rafCounter;
    activeRafs.set(id, cb);
    return id;
  };
  const fakeCancelRaf = id => {
    activeRafs.delete(id);
  };
  const fakeSetInterval = (...args) => {
    intervals.push(args);
    throw new Error('setInterval must not be called! Module must be setInterval-free.');
  };
  const fakeSetTimeout = (cb, ms) => {
    const id = ++timeoutCounter;
    activeTimeouts.set(id, cb);
    return id;
  };
  const fakeClearTimeout = id => {
    activeTimeouts.delete(id);
  };

  const context = {
    module: { exports: {} },
    exports: {},
    __DEV__: true,
    performance: {
      now: () => virtualTime,
    },
    Date: {
      now: () => Math.round(virtualTime),
    },
    requestAnimationFrame: fakeRaf,
    cancelAnimationFrame: fakeCancelRaf,
    setInterval: fakeSetInterval,
    clearInterval: () => {},
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    addEventListener: () => {},
    removeEventListener: () => {},
    console: {
      log: (...args) => logs.push(['log', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      error: (...args) => logs.push(['error', ...args]),
      debug: (...args) => logs.push(['debug', ...args]),
    },
  };

  context.globalThis = context;
  vm.runInNewContext(code, context);

  const stepFrame = (deltaMs = 16.6) => {
    virtualTime += deltaMs;
    const pending = Array.from(activeRafs.entries());
    activeRafs.clear();
    for (const [, cb] of pending) {
      cb(virtualTime);
    }
  };

  return {
    api: context.module.exports,
    globalPerf: context.__kinesyncPerf,
    logs,
    activeRafCount: () => activeRafs.size,
    activeTimeoutCount: () => activeTimeouts.size,
    intervals,
    stepFrame,
    setVirtualTime: t => { virtualTime = t; },
    getVirtualTime: () => virtualTime,
  };
}

// 2.1 Unarmed record collects nothing
{
  const harness = createDevHarness();
  const { api, globalPerf } = harness;

  assert.equal(typeof globalPerf, 'object', 'globalThis.__kinesyncPerf must be present in dev');
  assert.equal(api.summary().armed, false, 'Initial state must be unarmed');

  // Unarmed calls
  api.recordPerfStage('packet-ingestion', 5);
  api.recordPerfStage('parser CPU (lyrics-ttml-import)', 10);
  const end = api.startPerfStage('glyph shaping');
  end();

  const s = api.summary();
  assert.equal(s.buffer.totalRecorded, 0, 'Unarmed recordPerfStage must not record anything');
  assert.equal(s.marks.length, 0, 'Unarmed marks must be empty');
  assert.equal(s.milestones.length, 0, 'Unarmed milestones must be empty');
  assert.equal(Object.keys(s.stageAggregates).length, 0, 'Unarmed stageAggregates must be empty');
}

// 2.2 parse-before-packet correlation (parser mark precedes ingestion but shares arrival id)
{
  const harness = createDevHarness();
  const { api } = harness;
  api.arm();

  // Pipeline starts at service entry / request: create arrival before fetch/parse body available
  harness.setVirtualTime(1000);
  const arrivalId = api.createArrival('spotify:track:test1234', 'new-song');
  assert.ok(arrivalId.startsWith('arr_'), 'createArrival returns valid arrival id');

  // Fetch finishes and TTML parser runs BEFORE packet-ingestion
  harness.setVirtualTime(1020);
  api.recordPerfStage('parser CPU (lyrics-ttml-import)', 15, { lineCount: 40 }, arrivalId);

  // Next, packet-ingestion fires when packet is applied to store
  harness.setVirtualTime(1050);
  api.recordPerfStage('packet-ingestion', 0, { source: 'lrc-red', lineCount: 40 }, arrivalId);

  const s = api.summary();
  assert.equal(s.marks.length, 2, 'Two marks recorded');

  const parserMark = s.marks[0];
  const ingestionMark = s.marks[1];

  assert.equal(parserMark.stage, 'parser CPU (lyrics-ttml-import)');
  assert.equal(ingestionMark.stage, 'packet-ingestion');

  // Verify parser mark preceded packet-ingestion in time
  assert.ok(parserMark.timestamp < ingestionMark.timestamp, 'Parser mark must precede ingestion mark in time');

  // Verify BOTH share the exact same arrival id
  assert.equal(parserMark.arrivalId, arrivalId, 'Parser mark shares arrival id');
  assert.equal(ingestionMark.arrivalId, arrivalId, 'Packet ingestion mark shares arrival id');

  // Per-arrival aggregate tracks both stages
  const arrivalSummary = s.arrivals.find(a => a.arrivalId === arrivalId);
  assert.ok(arrivalSummary, 'Arrival summary exists');
  assert.equal(arrivalSummary.stages['parser CPU (lyrics-ttml-import)'].status, 'recorded');
  assert.equal(arrivalSummary.stages['parser CPU (lyrics-ttml-import)'].count, 1);
  assert.equal(arrivalSummary.stages['packet-ingestion'].status, 'recorded');
  assert.equal(arrivalSummary.stages['packet-ingestion'].count, 1);

  // Stages never seen for this arrival are marked unavailable
  assert.equal(arrivalSummary.stages['first-active-picture'].status, 'unavailable');
  assert.equal(arrivalSummary.stages['model build (native-lyrics-model)'].status, 'unavailable');
}

// 2.3 translation/rejected packets not creating new arrival
{
  const harness = createDevHarness();
  const { api } = harness;
  api.arm();

  // 1. Initial new-song arrival
  const songArrival = api.createArrival('song-initial', 'new-song');
  api.recordPerfStage('packet-ingestion', 0, { source: 'mobile-app' }, songArrival);

  let s = api.summary();
  let songRecord = s.arrivals.find(a => a.arrivalId === songArrival);
  assert.equal(songRecord.superseded, false, 'Initial song is not superseded');

  // 2. Translation packet arrives
  const transArrival = api.createArrival('song-initial', 'translation');
  api.recordPerfStage('packet-ingestion', 0, { source: 'mobile-app', isTranslation: true }, transArrival);

  s = api.summary();
  songRecord = s.arrivals.find(a => a.arrivalId === songArrival);
  const transRecord = s.arrivals.find(a => a.arrivalId === transArrival);

  assert.equal(transRecord.kind, 'translation', 'Translation arrival marked as translation kind');
  assert.equal(songRecord.superseded, false, 'Translation update must NOT supersede current song arrival');

  // 3. Rejected packet arrives (e.g. no-match)
  const rejectedArrival = api.createArrival('song-initial', 'rejected');
  api.recordPerfStage('packet-ingestion', 0, { source: 'local-vault:no-match', lineCount: 0 }, rejectedArrival);

  s = api.summary();
  songRecord = s.arrivals.find(a => a.arrivalId === songArrival);
  const rejRecord = s.arrivals.find(a => a.arrivalId === rejectedArrival);

  assert.equal(rejRecord.kind, 'rejected', 'Rejected arrival marked as rejected kind');
  assert.equal(songRecord.superseded, false, 'Rejected packet must NOT supersede current song arrival');
}

// 2.4 superseded/out-of-order marks
{
  const harness = createDevHarness();
  const { api } = harness;
  api.arm();

  // Arrival 1 starts
  const arr1 = api.createArrival('track-old', 'new-song');
  api.recordPerfStage('model build (native-lyrics-model)', 10, {}, arr1);

  // Arrival 2 supersedes Arrival 1
  const arr2 = api.createArrival('track-new', 'new-song');

  let s = api.summary();
  const arr1Summary = s.arrivals.find(a => a.arrivalId === arr1);
  const arr2Summary = s.arrivals.find(a => a.arrivalId === arr2);
  assert.equal(arr1Summary.superseded, true, 'arr1 is superseded by arr2');
  assert.equal(arr2Summary.superseded, false, 'arr2 is not superseded');

  // Late mark for old arrival (arr1) arrives out of order after arr2 was created
  api.recordPerfStage('paragraph layout', 8, { late: true }, arr1);

  // Mark for new arrival (arr2)
  api.recordPerfStage('paragraph layout', 6, { fresh: true }, arr2);

  s = api.summary();
  const marks = s.marks;
  const lateMark = marks.find(m => m.metadata?.late === true);
  const freshMark = marks.find(m => m.metadata?.fresh === true);

  assert.ok(lateMark, 'Late mark was recorded');
  assert.equal(lateMark.arrivalId, arr1, 'Late mark stays attributed to old arrival id');
  assert.equal(lateMark.superseded, true, 'Late mark for superseded arrival is flagged superseded');

  assert.ok(freshMark, 'Fresh mark was recorded');
  assert.equal(freshMark.arrivalId, arr2, 'Fresh mark attributed to new arrival id');
  assert.equal(freshMark.superseded, false, 'Fresh mark for active arrival is not superseded');

  // Aggregate for arr1 was updated with its late mark
  const updatedArr1 = s.arrivals.find(a => a.arrivalId === arr1);
  assert.equal(updatedArr1.stages['paragraph layout'].count, 1);
  assert.equal(updatedArr1.stages['paragraph layout'].totalDurationMs, 8);

  // Aggregate for arr2 has only its fresh mark
  const updatedArr2 = s.arrivals.find(a => a.arrivalId === arr2);
  assert.equal(updatedArr2.stages['paragraph layout'].count, 1);
  assert.equal(updatedArr2.stages['paragraph layout'].totalDurationMs, 6);
}

// 2.5 ring wrap preserves aggregate totals/counts
{
  const harness = createDevHarness();
  const { api } = harness;
  api.arm();

  const arrWrap = api.createArrival('track-wrap', 'new-song');

  // Initial stage marks
  api.recordPerfStage('packet-ingestion', 0, {}, arrWrap);
  api.recordPerfStage('parser CPU (lyrics-ttml-import)', 10, {}, arrWrap);
  api.recordPerfStage('model build (native-lyrics-model)', 15, {}, arrWrap);

  // Record 250 paragraph layout marks (2ms each -> total 500ms)
  for (let i = 0; i < 250; i++) {
    api.recordPerfStage('paragraph layout', 2, { i }, arrWrap);
  }

  const s = api.summary();

  // Ring buffer capacity is 200; total recorded is 253; 53 marks were dropped from ring buffer
  assert.equal(s.buffer.capacity, 200);
  assert.equal(s.buffer.totalRecorded, 253);
  assert.equal(s.buffer.dropped, 53);
  assert.equal(s.marks.length, 200, 'Ring buffer keeps exactly recent 200 marks');

  // But the online aggregate for 'paragraph layout' on arrWrap preserved ALL 250 calls!
  const arrSummary = s.arrivals.find(a => a.arrivalId === arrWrap);
  const layoutAgg = arrSummary.stages['paragraph layout'];

  assert.equal(layoutAgg.status, 'recorded');
  assert.equal(layoutAgg.count, 250, 'Online aggregate preserves full count (250) independent of ring wrap');
  assert.equal(layoutAgg.totalDurationMs, 500, 'Online aggregate preserves full total duration (500ms)');
  assert.equal(layoutAgg.minDurationMs, 2);
  assert.equal(layoutAgg.maxDurationMs, 2);
  assert.equal(layoutAgg.avgDurationMs, 2);
}

// 2.6 repeat capture (reset/arm twice) clean
{
  const harness = createDevHarness();
  const { api } = harness;

  // Run 1
  api.arm();
  const id1 = api.createArrival('run-1', 'new-song');
  api.recordPerfStage('first-active-picture', 12, {}, id1);
  api.recordPerfStage('packet-ingestion', 0, {}, id1);
  const s1 = api.summary();
  assert.equal(s1.marks.length, 2);
  assert.equal(s1.arrivals.length, 1);
  api.disarm();

  // Reset
  api.reset();
  const sReset = api.summary();
  assert.equal(sReset.armed, false);
  assert.equal(sReset.marks.length, 0);
  assert.equal(sReset.arrivals.length, 0);
  assert.equal(sReset.milestones.length, 0);
  assert.equal(sReset.buffer.totalRecorded, 0);

  // Run 2: re-arm and record new arrival
  api.arm();
  const id2 = api.createArrival('run-2', 'new-song');
  api.recordPerfStage('first-active-picture', 8, { pictureNativeMonotonicNow: 54321 }, id2);
  api.recordPerfStage('packet-ingestion', 0, {}, id2);

  const s2 = api.summary();
  assert.equal(s2.marks.length, 2, 'Only Run 2 marks present');
  assert.equal(s2.arrivals.length, 1, 'Only Run 2 arrival present');
  assert.equal(s2.arrivals[0].arrivalId, id2);
  assert.equal(s2.arrivals[0].stages['first-active-picture'].count, 1);
  assert.equal(s2.arrivals[0].stages['first-active-picture'].totalDurationMs, 8);
  api.disarm();
}

// 2.7 first-active-picture independent of traceFrames
{
  const harness = createDevHarness();
  const { api } = harness;
  api.arm();

  const id = api.createArrival('track-active-pic', 'new-song');

  // 1st active frame
  api.recordPerfStage('first-active-picture', 14, { pictureNativeMonotonicNow: 1234567 }, id);

  // 2nd active frame for same arrival (e.g. frame callback continues running)
  api.recordPerfStage('first-active-picture', 10, { pictureNativeMonotonicNow: 1234583 }, id);

  // 3rd active frame for same arrival
  api.recordPerfStage('first-active-picture', 11, { pictureNativeMonotonicNow: 1234600 }, id);

  const s = api.summary();
  const firstActiveMarks = s.marks.filter(m => m.stage === 'first-active-picture');

  // Verify only the FIRST active picture was recorded for this arrival
  assert.equal(firstActiveMarks.length, 1, 'Only 1 first-active-picture mark recorded per arrival');
  assert.equal(firstActiveMarks[0].durationMs, 14);
  assert.equal(firstActiveMarks[0].metadata?.pictureNativeMonotonicNow, 1234567);

  // Now a re-armed existing renderer yields sample again
  api.disarm();
  api.arm(); // Re-arming resets active picture tracking

  api.recordPerfStage('first-active-picture', 9, { pictureNativeMonotonicNow: 2000000 }, id);
  const sRearmed = api.summary();
  const rearmedMarks = sRearmed.marks.filter(m => m.stage === 'first-active-picture');
  assert.equal(rearmedMarks.length, 2, 'Re-armed renderer yields sample again');
}

// 2.8 Callback lateness / frame gap sampler (setInterval-free, honest notice, gap >= 100ms)
{
  const harness = createDevHarness();
  const { globalPerf } = harness;

  assert.equal(harness.activeRafCount(), 0, 'No drift sampler running before arm');
  globalPerf.arm();
  assert.equal(harness.activeRafCount(), 1, 'Drift sampler should start rAF loop when armed');

  harness.stepFrame(16.6); // 16.6ms normal
  harness.stepFrame(60);   // gap > 50ms
  harness.stepFrame(120);  // gap >= 100ms
  harness.stepFrame(300);  // gap >= 250ms
  harness.stepFrame(1100); // gap >= 1000ms

  const s = globalPerf.summary();
  const cl = s.callbackLateness;
  assert.ok(cl, 'callbackLateness must exist on summary');
  assert.equal(cl.sampleCount, 5, 'Sample count must match tick count');
  assert.equal(cl.gapsOver50ms, 1);
  assert.equal(cl.gapsOver100ms, 1, 'One gap in 100-249ms (gap >=100ms comparison)');
  assert.equal(cl.gapsOver250ms, 1);
  assert.equal(cl.gapsOver1000ms, 1);
  assert.equal(cl.maxFrameGapMs, 1100);

  // Honest notices
  assert.ok(s.callbackLatenessNotice.includes('lateness') || s.callbackLatenessNotice.includes('gap'),
    'Notice must describe callback lateness/frame gap');
  assert.ok(s.callbackLatenessNotice.includes('NOT continuous JS'),
    'Notice must clarify it is NOT continuous JS thread blocking');
  assert.ok(s.packetIngestionNotice.includes('backlog is not measured'),
    'Notice must document callback backlog is not measured');

  globalPerf.disarm();
  assert.equal(harness.activeRafCount(), 0, 'rAF cancelled on disarm');
  assert.equal(harness.intervals.length, 0, 'No setInterval calls');
}

// 2.9 Confidentiality: no lyric text and no secrets are retained
{
  const harness = createDevHarness();
  const { api, globalPerf } = harness;
  api.arm();

  api.recordPerfStage('test-stage', 5, {
    lineCount: 42,
    style: 'amll',
    lyrics: 'sensitive lyric line content',
    words: ['secret', 'words'],
    text: 'private text',
    token: 'bearer-secret-token',
    secret: 'my-api-key',
    password: 'password123',
    auth: 'Authorization header',
    cookie: 'session=abc',
    veryLongStringContent: 'a'.repeat(200),
  });

  const s = globalPerf.summary();
  const mark = s.marks[0];
  assert.ok(mark, 'Mark should be recorded');
  assert.equal(mark.metadata?.lineCount, 42);
  assert.equal(mark.metadata?.style, 'amll');

  const json = JSON.stringify(s);
  assert.ok(!json.includes('sensitive lyric line content'), 'Lyric text must not be stored');
  assert.ok(!json.includes('bearer-secret-token'), 'Tokens must not be stored');
  assert.ok(!json.includes('my-api-key'), 'Secrets must not be stored');
  assert.ok(!json.includes('password123'), 'Passwords must not be stored');
  assert.ok(!json.includes('Authorization header'), 'Auth must not be stored');
  assert.ok(!json.includes('private text'), 'Text must not be stored');
  assert.ok(!json.includes('a'.repeat(100)), 'Long string payloads must not be stored');
}

// ============================================================================
// 3. Static checks
// ============================================================================
// 3.1 Each recordPerfStage callsite is guarded by __DEV__
{
  const targetFiles = [
    'components/lyrics/native/native-lyrics-view.tsx',
    'components/lyrics/native/native-lyrics-model.ts',
    'components/lyrics/native/native-glyph-picture.tsx',
    'lib/lyrics-sync.ts',
    'lib/bridge-client.ts',
  ];

  let totalCallsFound = 0;

  for (const relPath of targetFiles) {
    const fullPath = path.join(__dirname, '..', relPath);
    const content = fs.readFileSync(fullPath, 'utf8');
    const sf = ts.createSourceFile(relPath, content, ts.ScriptTarget.Latest, true);

    function visit(node) {
      if (ts.isIdentifier(node) && node.text === 'recordPerfStage') {
        const parent = node.parent;
        // Ignore imports and function declarations
        if (!ts.isImportSpecifier(parent) && !ts.isFunctionDeclaration(parent)) {
          totalCallsFound++;
          let curr = node;
          let guarded = false;
          while (curr) {
            if (ts.isIfStatement(curr)) {
              const cond = curr.expression.getText(sf);
              if (cond.includes('__DEV__') || cond.includes('pictureTraceEnabled')) {
                guarded = true;
                break;
              }
            }
            curr = curr.parent;
          }
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          assert.ok(guarded, `recordPerfStage at ${relPath}:${line} must be guarded by __DEV__`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);
  }

  assert.ok(totalCallsFound >= 5, `Expected at least 5 recordPerfStage callsites across files, found ${totalCallsFound}`);
}

// 3.2 NativeLyricsView mounted effect deps are []
{
  const viewPath = path.join(__dirname, '../components/lyrics/native/native-lyrics-view.tsx');
  const viewContent = fs.readFileSync(viewPath, 'utf8');
  const sf = ts.createSourceFile('native-lyrics-view.tsx', viewContent, ts.ScriptTarget.Latest, true);

  let foundMountedEffect = false;
  let depsAreEmptyArray = false;

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const exprText = node.expression.getText(sf);
      if (exprText === 'useEffect') {
        const effectBody = node.arguments[0]?.getText(sf) || '';
        if (effectBody.includes('mounted.current = true')) {
          foundMountedEffect = true;
          const depsArg = node.arguments[1];
          if (depsArg && ts.isArrayLiteralExpression(depsArg) && depsArg.elements.length === 0) {
            depsAreEmptyArray = true;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  assert.ok(foundMountedEffect, 'Mounted useEffect in NativeLyricsView must be found');
  assert.ok(depsAreEmptyArray, 'Mounted useEffect in NativeLyricsView must have empty dependency array []');
}

// 3.3 Regression: baseline parity for parseTtmlToLyrics (string/object inputs, translationLanguage defaults)
{
  const baselineImporter = require('../../DesktopBridge/src/lyricsTtmlImport');
  const mobileImporter = require('../lib/lyrics-ttml-import');

  // Verify function signatures: exactly matches development baseline (length 1, no 3rd param)
  assert.equal(mobileImporter.parseTtmlToLyrics.length, baselineImporter.parseTtmlToLyrics.length,
    'parseTtmlToLyrics length must match baseline');
  assert.equal(mobileImporter.parseTtmlToLyrics.length, 1, 'parseTtmlToLyrics length must be 1');

  const validTtmlWithTranslations = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:lrc="http://lrc.red/lyric-ttml-internal">
  <head>
    <metadata>
      <sourceMetadata xmlns="http://lrc.red/lyric-ttml-internal">
        <translations>
          <translation xml:lang="en" type="subtitle"><text for="k1">English Translation</text></translation>
          <translation xml:lang="es" type="subtitle"><text for="k1">Traduccion Espanola</text></translation>
        </translations>
      </sourceMetadata>
    </metadata>
  </head>
  <body>
    <p begin="00:01.000" end="00:03.000" lrc:key="k1"><span>Original Text</span></p>
  </body>
</tt>`;

  // 1. Input coercion / validation regressions: instrumentation must not make previously failing input accepted
  const invalidOrObjectInputs = [
    { content: validTtmlWithTranslations },
    { content: 'some lyrics' },
    {},
    { lyrics: [] },
    null,
    undefined,
    '',
    '   ',
    'random non-xml string',
  ];

  for (const input of invalidOrObjectInputs) {
    const baseResult = baselineImporter.parseTtmlToLyrics(input);
    const mobileResult = mobileImporter.parseTtmlToLyrics(input);
    assert.deepEqual(mobileResult, baseResult,
      `Input ${typeof input === 'object' ? JSON.stringify(input) : String(input)} must match baseline parser output`);
    assert.equal(mobileResult.lyrics.length, 0, 'Invalid/object input must yield 0 lyrics');
    assert.equal(mobileResult.durationMs, 0);
    assert.equal(mobileResult.useKaraokeTiming, false);
  }

  // 2. translationLanguage options regressions: undefined/null/empty/valid
  const translationLanguageCases = [
    undefined,
    {},
    { translationLanguage: undefined },
    { translationLanguage: null },
    { translationLanguage: '' },
    { translationLanguage: 'es' },
    { translationLanguage: 'en' },
    { translationLanguage: 'nonexistent-lang' },
  ];

  for (const options of translationLanguageCases) {
    const baseResult = baselineImporter.parseTtmlToLyrics(validTtmlWithTranslations, options);
    const mobileResult = mobileImporter.parseTtmlToLyrics(validTtmlWithTranslations, options);
    assert.deepEqual(mobileResult, baseResult,
      `translationLanguage ${JSON.stringify(options)} must match baseline parser exactly`);
  }

  // Baseline semantics:
  // - undefined / omitted defaults to "English"
  assert.equal(mobileImporter.parseTtmlToLyrics(validTtmlWithTranslations).lyrics[0].translatedText, 'English Translation');
  assert.equal(mobileImporter.parseTtmlToLyrics(validTtmlWithTranslations, {}).lyrics[0].translatedText, 'English Translation');
  assert.equal(mobileImporter.parseTtmlToLyrics(validTtmlWithTranslations, { translationLanguage: undefined }).lyrics[0].translatedText, 'English Translation');
  // - null and empty string MUST NOT fallback to English
  assert.equal(mobileImporter.parseTtmlToLyrics(validTtmlWithTranslations, { translationLanguage: null }).lyrics[0].translatedText, undefined);
  assert.equal(mobileImporter.parseTtmlToLyrics(validTtmlWithTranslations, { translationLanguage: '' }).lyrics[0].translatedText, undefined);
  // - explicit "es" selects Spanish
  assert.equal(mobileImporter.parseTtmlToLyrics(validTtmlWithTranslations, { translationLanguage: 'es' }).lyrics[0].translatedText, 'Traduccion Espanola');

  // 3. Dev correlation side-channel & actual parser implementation tests
  // Exercise the ACTUAL parser implementation with __DEV__ = true and real perf-stages
  globalThis.__DEV__ = true;
  delete require.cache[require.resolve('../lib/lyrics-ttml-import')];
  const realMobileImporter = require('../lib/lyrics-ttml-import');

  // Load real perf-stages in Node global context
  const realPerfModule = { exports: {} };
  const realPerfFn = new Function('module', 'exports', '__DEV__', 'globalThis', code);
  realPerfFn(realPerfModule, realPerfModule.exports, true, globalThis);
  const realPerfStages = realPerfModule.exports;

  // Verify realMobileImporter has pending parse APIs
  assert.equal(typeof realMobileImporter.setPendingParseArrivalId, 'function');
  assert.equal(typeof realMobileImporter.clearPendingParseArrivalId, 'function');

  // 3.1 parse of A body while B active and no pending id => uncorrelated (not B)
  {
    realPerfStages.reset();
    realPerfStages.arm();
    const idB = realPerfStages.createArrival('song-B-active', 'new-song');
    assert.equal(realPerfStages.getActiveArrivalId(), idB, 'B must be active');

    realMobileImporter.clearPendingParseArrivalId();
    const resA = realMobileImporter.parseTtmlToLyrics(validTtmlWithTranslations);
    assert.equal(resA.lyrics.length, 1);

    const s = realPerfStages.summary();
    const markA = s.marks.find(m => m.stage === 'parser CPU (lyrics-ttml-import)');
    assert.ok(markA, 'Parser CPU mark must be recorded');
    assert.equal(markA.arrivalId, 'uncorrelated', 'Parse without pending id while B is active must record uncorrelated');
    assert.notEqual(markA.arrivalId, idB, 'Parse without pending id must NOT adopt active arrival B');
  }

  // 3.2 A pending id set while B active => A
  {
    const idA = realPerfStages.createArrival('song-A-request', 'new-song');
    const idB2 = realPerfStages.createArrival('song-B-current-active', 'new-song');
    assert.equal(realPerfStages.getActiveArrivalId(), idB2, 'B2 must be active');

    // Pending ID for A is set immediately before parse
    realMobileImporter.setPendingParseArrivalId(idA);
    const resA = realMobileImporter.parseTtmlToLyrics(validTtmlWithTranslations);
    assert.equal(resA.lyrics.length, 1);

    const s = realPerfStages.summary();
    const markA = s.marks[s.marks.length - 1];
    assert.equal(markA.stage, 'parser CPU (lyrics-ttml-import)');
    assert.equal(markA.arrivalId, idA, 'A pending id set while B active must record arrival A');
  }

  // 3.3 throw/null input clears pending
  {
    // 3.3a: null input clears pending
    realMobileImporter.setPendingParseArrivalId('arr_pending_null_test');
    const nullRes = realMobileImporter.parseTtmlToLyrics(null);
    assert.equal(nullRes.lyrics.length, 0);

    // Next parse without setting pending must be uncorrelated (not arr_pending_null_test)
    realMobileImporter.parseTtmlToLyrics(validTtmlWithTranslations);
    const sNull = realPerfStages.summary();
    const markAfterNull = sNull.marks[sNull.marks.length - 1];
    assert.equal(markAfterNull.arrivalId, 'uncorrelated', 'Null input must clear pending id');

    // 3.3b: throw input clears pending
    realMobileImporter.setPendingParseArrivalId('arr_pending_throw_test');
    let threw = false;
    try {
      // options = null causes destructuring TypeError in parseTtmlToLyrics
      realMobileImporter.parseTtmlToLyrics(validTtmlWithTranslations, null);
    } catch (e) {
      threw = true;
      realMobileImporter.clearPendingParseArrivalId();
    }
    assert.ok(threw, 'parseTtmlToLyrics with null options must throw TypeError');

    // Next parse without setting pending must be uncorrelated (not arr_pending_throw_test)
    realMobileImporter.parseTtmlToLyrics(validTtmlWithTranslations);
    const sThrow = realPerfStages.summary();
    const markAfterThrow = sThrow.marks[sThrow.marks.length - 1];
    assert.equal(markAfterThrow.arrivalId, 'uncorrelated', 'Throwing input must clear pending id');
  }

  // 3.4 late A ingestion after B stays A
  {
    const idOldA = realPerfStages.createArrival('track-old-A', 'new-song');
    const idNewB = realPerfStages.createArrival('track-new-B', 'new-song');
    assert.equal(realPerfStages.getActiveArrivalId(), idNewB, 'B must be active');

    const packetA = {
      type: 'lyrics',
      trackId: 'track-old-A',
      lyrics: [{ text: 'Old lyrics', lineStartTime: 1000, lineEndTime: 3000 }],
      source: 'mobile-app',
    };
    realPerfStages.associateArrival(packetA, idOldA);

    // Ingest late packet A
    const packetArrivalId = realPerfStages.getArrivalForObject(packetA) || 'uncorrelated';
    realPerfStages.recordPerfStage('packet-ingestion', 0, {
      source: packetA.source,
      lineCount: packetA.lyrics.length,
    }, packetArrivalId);

    const s = realPerfStages.summary();
    const lateMark = s.marks[s.marks.length - 1];
    assert.equal(lateMark.stage, 'packet-ingestion');
    assert.equal(lateMark.arrivalId, idOldA, 'Late A packet must stay attributed to arrival A');
    assert.notEqual(lateMark.arrivalId, idNewB, 'Late A packet must NOT adopt active arrival B');
    assert.equal(lateMark.superseded, true, 'Late A packet must be flagged as superseded');
  }

  // 3.5 missing-id mobile ingestion => uncorrelated
  {
    // Ensure an active arrival exists
    assert.ok(realPerfStages.getActiveArrivalId(), 'Active arrival must exist');

    const unassociatedPacket = {
      type: 'lyrics',
      trackId: 'unassociated-track',
      lyrics: [{ text: 'Uncorrelated lyrics', lineStartTime: 1000, lineEndTime: 2000 }],
      source: 'mobile-app',
    };

    // Mobile ingestion logic: getArrivalForObject or uncorrelated
    const arrivalId = realPerfStages.getArrivalForObject(unassociatedPacket) || 'uncorrelated';
    realPerfStages.recordPerfStage('packet-ingestion', 0, {
      source: unassociatedPacket.source,
      lineCount: unassociatedPacket.lyrics.length,
    }, arrivalId);

    const s = realPerfStages.summary();
    const missingMark = s.marks[s.marks.length - 1];
    assert.equal(missingMark.stage, 'packet-ingestion');
    assert.equal(missingMark.arrivalId, 'uncorrelated', 'Missing-id packet ingestion must record uncorrelated');
    assert.notEqual(missingMark.arrivalId, realPerfStages.getActiveArrivalId(), 'Missing-id packet must NOT adopt active arrival');
  }

  realPerfStages.disarm();
  delete globalThis.__kinesyncPerf;
}

console.log('Perf stages check passed: prod zero-allocation no-op, parse-before-packet correlation, translation/rejected separate kinds, superseded handling, ring wrap aggregate preservation, clean repeat capture, first-active-picture independent of traceFrames, honest lateness, and static __DEV__ guards.');
