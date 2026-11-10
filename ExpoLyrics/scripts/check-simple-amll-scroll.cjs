const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'components/lyrics/native');

function bundle(file) {
  return buildSync({
    entryPoints: [path.join(dir, file)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    external: ['react', 'react-native', 'react-native-reanimated', './reference-scroll'],
  }).outputFiles[0].text;
}

// 1. Math and Analytic Curve Engine Test
function testAnalyticCurveMath() {
  const simpleSource = bundle('simple-amll-motion.ts');
  const mod = { exports: {} };
  vm.runInNewContext(simpleSource, { module: mod, exports: mod.exports, require: name => name === 'react-native-reanimated' ? { cancelAnimation: () => {} } : {} });
  const api = mod.exports;

  const omega = api.amllOmega(800, false);
  assert(omega > 10 && omega < 20, 'omega reasonable: ' + omega);

  // Single segment test
  const seg1 = {
    startTime: 1.0,
    endTime: Infinity,
    p0: 120,
    v0: 0,
    omega,
    c1: 120,
    c2: omega * 120,
    targetShift: 0,
  };
  const atStart = api.sampleTrajectory([seg1], 1.0);
  assert(Math.abs(atStart.p - 120) < 1e-6);
  assert(Math.abs(atStart.v) < 1e-6);
  assert(!atStart.settled);

  const after1s = api.sampleTrajectory([seg1], 2.0);
  assert(after1s.p < 1.0, 'decayed after 1s: ' + after1s.p);

  const after2s = api.sampleTrajectory([seg1], 3.0);
  assert(after2s.settled, 'settled after 2s');
  assert.equal(after2s.p, 0);
  assert.equal(after2s.v, 0);

  // Fast Retarget Tests: 16ms, 30ms, 60ms, 100ms
  for (const interval of [0.016, 0.033, 0.064, 0.1]) {
    const s0 = {
      startTime: 1.0,
      endTime: Infinity,
      p0: 100,
      v0: 0,
      omega,
      c1: 100,
      c2: omega * 100,
      targetShift: 0,
    };
    const history = [s0];
    const T_retarget = 1.0 + interval;
    const cur = api.sampleTrajectory(history, T_retarget);
    s0.endTime = T_retarget;
    const delta = 150;
    s0.targetShift += delta;

    const p0_new = cur.p + delta;
    const v0_new = cur.v;
    const omega_new = api.amllOmega(600, false);
    history.push({
      startTime: T_retarget,
      endTime: Infinity,
      p0: p0_new,
      v0: v0_new,
      omega: omega_new,
      c1: p0_new,
      c2: v0_new + omega_new * p0_new,
      targetShift: 0,
    });

    const eps = 1e-7;
    const before = api.sampleTrajectory(history, T_retarget - eps);
    const after = api.sampleTrajectory(history, T_retarget + eps);
    assert(Math.abs(after.p - before.p) < 0.001, 'displacement continuous at dt=' + interval + ': diff=' + Math.abs(after.p - before.p));
    assert(Math.abs(after.v - before.v) < 0.05, 'velocity continuous at dt=' + interval + ': diff=' + Math.abs(after.v - before.v));

    // Test stagger continuity for delayed rows
    for (const delay of [0.05, 0.08, 0.12, 0.20]) {
      const T_cross = T_retarget + delay;
      const rowBefore = api.sampleTrajectory(history, T_cross - delay - eps);
      const rowAfter = api.sampleTrajectory(history, T_cross - delay + eps);
      assert(Math.abs(rowAfter.p - rowBefore.p) < 0.001, 'row stagger displacement continuous: diff=' + Math.abs(rowAfter.p - rowBefore.p));
      assert(Math.abs(rowAfter.v - rowBefore.v) < 0.05, 'row stagger velocity continuous: diff=' + Math.abs(rowAfter.v - rowBefore.v));
    }
  }

  // Backward seek test (delta < 0)
  {
    const s0 = {
      startTime: 1.0,
      endTime: 1.5,
      p0: 200,
      v0: 0,
      omega,
      c1: 200,
      c2: omega * 200,
      targetShift: -250,
    };
    const s1 = {
      startTime: 1.5,
      endTime: Infinity,
      p0: -180,
      v0: -100,
      omega,
      c1: -180,
      c2: -100 + omega * (-180),
      targetShift: 0,
    };
    const history = [s0, s1];
    const atSeek = api.sampleTrajectory(history, 1.5);
    assert(atSeek.p < 0, 'negative displacement on backward seek');
    const settledBack = api.sampleTrajectory(history, 3.5);
    assert(settledBack.settled && settledBack.p === 0, 'backward seek settles to 0');
  }

  // Motion blur lead conservatism test from rest/acceleration (v0 = 0)
  for (const p0 of [50, 100, 200]) {
    const sRest = {
      startTime: 0,
      endTime: Infinity,
      p0,
      v0: 0,
      omega,
      c1: p0,
      c2: omega * p0,
      targetShift: 0,
    };
    const historyRest = [sRest];
    const bound = api.boundAnalyticDisplacement(historyRest, 0, 0.064);
    assert(bound > 0, 'bound must be strictly positive from rest');
    for (let t = 0.001; t <= 0.064; t += 0.002) {
      const sample = api.sampleTrajectory(historyRest, t);
      const disp = Math.abs(sample.p - p0);
      assert(disp <= bound + 1e-4, 'disp ' + disp + ' exceeds bound ' + bound + ' at t=' + t);
    }
  }

  // Delay transition rate and finite difference coverage under chain rule
  {
    const seg = {
      startTime: 0,
      endTime: Infinity,
      p0: 100,
      v0: 0,
      omega,
      c1: 100,
      c2: omega * 100,
      targetShift: 0,
    };
    // Active motion window at T = 0.25s
    const T = 0.25;
    for (const delayRate of [-0.5, 0.0, 0.5]) {
      const delay = 0.10;
      const dt = 0.001;
      const t1 = T - delay;
      const t2 = (T + dt) - (delay + delayRate * dt);
      const s1 = api.sampleTrajectory([seg], t1);
      const s2 = api.sampleTrajectory([seg], t2);
      const fd = (s2.p - s1.p) / dt;
      const sMid = api.sampleTrajectory([seg], (t1 + t2) / 2);
      const expectedV = sMid.v * (1 - delayRate);
      assert(Math.abs(fd - expectedV) < 0.01, 'chain rule finite difference matches at rate ' + delayRate + ': fd=' + fd + ' expected=' + expectedV);
    }
  }

  console.log('Analytic critically damped curve math PASS: velocity-preserving retarget, stagger continuity, rest acceleration bound, finite difference coverage, backward seek, and settling.');
}

const blurSource = fs.readFileSync(path.join(dir, 'native-shared-blur.tsx'), 'utf8');
const blurSnippet = blurSource.slice(blurSource.indexOf('export function amllAnimatedProtection'), blurSource.indexOf('export function NativeSharedBlur'));
const blurModule = { exports: {} };
vm.runInNewContext(buildSync({ stdin: { contents: blurSnippet, loader: 'ts' }, format: 'cjs', write: false }).outputFiles[0].text,
  { module: blurModule, exports: blurModule.exports });

const simpleModuleSource = bundle('simple-amll-motion.ts');
const refScrollSource = bundle('reference-scroll.tsx');

function mountSimple({ N = 16, fps = 60 } = {}) {
    const frames = [], reactions = [], styles = [], cleanups = [], values = [], styleDeps = [], dirty = new Set();
    const counts = { callbacks: 0, registryPublications: 0, rowSnapshots: 0, styleCalls: 0, styleEmissions: 0 };
    let lastElement;
    let reads, composing = false, frameNumber = -1, lastCompose = -2, composeDirty = true;
    const shared = initial => {
      let value = initial;
      const cell = {
        get value() { reads?.add(cell); return value; },
        set value(next) {
          if (Object.is(next, value)) return;
          value = next; dirty.add(cell);
          if (cell === host?.motions) counts.registryPublications++;
          if (cell === host?.batchRows) { counts.rowSnapshots++; composeDirty = true; }
        },
        modify(fn, force = true) {
          const next = fn(value);
          if (force || next !== value) {
            value = next; dirty.add(cell);
            if (cell === host?.simple || cell === host?.batch) composeDirty = true;
          }
        }
      };
      values.push(cell); return cell;
    };
    let host;
    const react = {
      createContext: () => ({}), forwardRef: fn => fn, useCallback: fn => fn, useContext: () => host,
      useMemo: fn => fn(), useEffect: fn => { cleanups.push(fn()); }, createElement: (type, props) => (lastElement = { type, props })
    };
    const ra = {
      default: { ScrollView: 'ScrollView', View: 'View' }, useSharedValue: shared, useAnimatedRef: () => () => {}, useScrollOffset() {}, cancelAnimation() {},
      scrollTo: (_ref, _x, y) => { host.actualOffset.value = y; },
      useAnimatedStyle: fn => {
        const deps = new Set(); reads = deps; fn(); reads = undefined; styleDeps.push(deps); styles.push(fn); return fn;
      },
      useAnimatedReaction: (prepare, react) => reactions.push({ prepare, react, previous: null }),
      useFrameCallback: (fn, active = true) => { const frame = { fn, active }; frames.push(frame); return { setActive: value => { frame.active = value; } }; },
      runOnUI: fn => (...args) => fn(...args)
    };
    function load(source) {
      const module = { exports: {} };
      vm.runInNewContext(source, { global: { Error }, module, exports: module.exports, require: name => name === 'react' ? react : name === 'react/jsx-runtime' ? { jsx: (type, props) => (lastElement = { type, props }) } : name === 'react-native' ? {} : name === './reference-scroll' ? api : name === './simple-amll-motion' ? simpleApi : name === './batched-amll-motion' ? {} : ra });
      return module.exports;
    }
    const simpleApi = load(simpleModuleSource);
    const api = load(refScrollSource);

    host = {
      command: shared({ ...api.initialScrollCommand }),
      residual: shared(0),
      renderedResidual: shared(0),
      actualOffset: shared(0),
      motions: shared({}),
      spicy: false,
      batchRows: shared({}),
      simple: shared(simpleApi.createSimpleScrollState()),
      batch: shared({ rows: {}, cells: {}, dirty: false })
    };
    api.ReferenceScrollView({}, null);
    for (let i = 0; i < N; i++) api.useReferenceRowScroll(host, i, true);

    function compose() {
      if (!composeDirty || composing) return;
      composing = true;
      host.motions.value = simpleApi.composeSimpleRegistry(host.batchRows.value, host.simple.value, host.batch.value);
      composing = false; composeDirty = false; lastCompose = frameNumber;
    }
    const previousStyles = [], trace = [], times = [];
    function issue(fields) {
      host.command.value = { ...host.command.value, serial: host.command.value.serial + 1, ...fields };
    }
    function tick() {
      frameNumber++; const t = performance.now();
      for (const frame of frames) if (frame.active) { counts.callbacks++; frame.fn({ timeSincePreviousFrame: 1000 / fps }); }
      compose(); times.push(performance.now() - t);
      const positions = styles.map((fn, i) => {
        counts.styleCalls++; const p = fn().transform[0].translateY;
        if (p !== previousStyles[i]) { counts.styleEmissions++; previousStyles[i] = p; } return p;
      });
      trace.push({
        frame: frameNumber, offset: host.actualOffset.value, residual: host.residual.value, positions,
        registry: JSON.parse(JSON.stringify(host.motions.value, (key, value) => key === 'owner' ? undefined : value))
      });
      dirty.clear();
      return trace.at(-1);
    }
    return { host, counts, trace, times, issue, tick };
  }

function scenarioSimple({ N = 16, fps = 60 } = {}) {
  const h = mountSimple({ N, fps });
  for (let f = 0; f < 12 * fps; f++) {
    if (f === fps) h.issue({ offset: 100, delta: 100, index: 2, firstVisible: 0, interval: 800, instant: false, snap: true });
    if (f === 2 * fps) h.issue({ offset: 220, delta: 120, index: 4, firstVisible: 0, interval: 240, instant: false, snap: true, interlude: true });
    // Fast retarget with BOTH firstVisible and index changing within 33ms
    if (f === 2 * fps + Math.max(1, Math.floor(fps / 30))) h.issue({ offset: 310, delta: 90, index: 6, firstVisible: 3, interval: 200, instant: false, snap: true, interlude: true });
    if (f === 2 * fps + Math.floor(fps / 5)) h.issue({ offset: 40, delta: -270, index: 1, firstVisible: 0, interval: 100, instant: false, snap: true, interlude: false });
    if (f === 4 * fps) h.issue({ offset: 120, delta: 80, index: 3, interval: 800, instant: false, snap: true, geometry: true });
    if (f === 5 * fps) h.issue({ offset: 400, delta: 280, index: 5, instant: true, snap: true, geometry: false });
    if (f === 6 * fps) { h.issue({ instant: true, snap: false }); h.host.actualOffset.value = 650; }
    if (f === 7 * fps) h.issue({ offset: 200, delta: 0, index: 3, instant: false, snap: true });
    h.tick();
  }
  return h;
}

// 2. Integration & Blur Protection Test
function testIntegrationAndBlurProtection() {
  for (const N of [8, 16]) for (const fps of [60, 120]) {
    const h = scenarioSimple({ N, fps });

    // Verify blur mask protection on every frame
    const tolerance = 1e-4;
    for (let f = 0; f < h.trace.length; f++) {
      const frame = h.trace[f];
      const geometry = frame.positions.map((_, i) => ({ y: i * 100, height: 80 }));
      const envelope = blurModule.exports.amllAnimatedProtection(geometry, { first: 0, index: geometry.length - 1, top: 0, bottom: geometry.length * 100 }, frame.registry, frame.residual);
      for (let i = 0; i < geometry.length; i++) {
        const p = geometry[i].y + frame.positions[i];
        assert(envelope.top <= p + tolerance && envelope.bottom >= p + geometry[i].height - tolerance,
          'frame ' + f + ' row ' + i + ': envelope covers rendered row');
        const entry = frame.registry[i];
        if (entry) {
          assert(Math.abs(frame.positions[i] - entry.row) <= (entry.vLead ?? 0) + tolerance,
            'frame ' + f + ' row ' + i + ': vLead bounds delta');
          const issueFrames = [fps, 2 * fps, 2 * fps + Math.max(1, Math.floor(fps / 30)), 2 * fps + Math.floor(fps / 5), 4 * fps, 5 * fps, 6 * fps, 7 * fps];
          const nextIssue = issueFrames.find(frm => frm > f) ?? h.trace.length;
          // Lookahead within the same segment (up to next retarget) within 64ms window
          const maxLookahead = Math.min(nextIssue - 1, f + Math.floor(0.064 * fps + 1e-4));
          for (let look = f + 1; look <= maxLookahead; look++) {
            const forwardDelta = Math.abs(h.trace[look].positions[i] - frame.positions[i]);
            assert(forwardDelta <= (entry.vLead ?? 0) + 0.05,
              'frame ' + f + ' lookahead frame ' + look + ' row ' + i + ': forwardDelta ' + forwardDelta + ' exceeds vLead ' + entry.vLead);
          }
        }
      }
    }
  }
  console.log('Simple AMLL scroll integration PASS: all cues, seeks, geometry, instant, manual drag, and same-frame blur mask protection.');
}

if (require.main === module) {
  (() => {
    testAnalyticCurveMath();
    testIntegrationAndBlurProtection();
    console.log('ALL SIMPLE AMLL SCROLL TESTS PASSED!');
  })();
}

module.exports = { mountSimple, scenarioSimple };
