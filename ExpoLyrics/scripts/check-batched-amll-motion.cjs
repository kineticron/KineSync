/* global __dirname */
// Actual source hooks under an explicit deterministic host scheduler. This is
// not React Native scheduling fidelity or a phone JS/UI-thread measurement.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const { execFileSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'components/lyrics/native');
function bundle(file, original = false) {
  const opts = original ? { stdin: { contents: execFileSync('git', ['show', '5e76f08:ExpoLyrics/components/lyrics/native/' + file], { cwd: root, encoding: 'utf8' }), loader: 'tsx', resolveDir: dir } } : { entryPoints: [path.join(dir, file)] };
  return buildSync({ ...opts, bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['react', 'react-native', 'react-native-reanimated', './reference-scroll'] }).outputFiles[0].text;
}
// reference-scroll itself must be bundled when it is the entry point.
const code = bundle('reference-scroll.tsx'), baseCode = bundle('reference-scroll.tsx', true), batchCode = bundle('batched-amll-motion.ts'), cellCode = bundle('amll-layout-cell.tsx'), baseCellCode = bundle('amll-layout-cell.tsx', true);
const serializedCache = new Map();
function serializedBundle(file) {
  if (!serializedCache.has(file)) {
    const babel = require('@babel/core');
    serializedCache.set(file, babel.transformSync(bundle(file), {
      babelrc: false, configFile: false, plugins: [require.resolve('react-native-worklets/plugin')],
      filename: path.join(dir, file),
    }).code);
  }
  return serializedCache.get(file);
}
function rehydrate(fn) {
  if (!fn?.__initData) return fn;
  const closure = fn.__closure?.map(value => typeof value === 'function' ? rehydrate(value) : value);
  const raw = vm.runInNewContext(fn.__initData.code, { console });
  return (...args) => raw.apply({ __closure: closure }, args);
}
function mount({ serialized = false, batched = false, original = false, N = 16, fps = 60, reverse = false } = {}) {
  const frames = [], reactions = [], styles = [], cleanups = [], values = [], styleDeps = [], dirty = new Set();
  const jsEffects = { callbacks: 0, hostMs: 0 };
  const counts = { callbacks: 0, registryPublications: 0, rowSnapshots: 0, styleCalls: 0, styleEmissions: 0, rowStatePublications: 0 };
  let lastElement;
  let reads, composing = false, frameNumber = -1, lastCompose = -2, composeDirty = true;
  const shared = initial => {
    let value = initial;
    const cell = { get value() { reads?.add(cell); return value; }, set value(next) {
      if (Object.is(next, value)) return;
      value = next; dirty.add(cell);
      if (cell === host?.motions) counts.registryPublications++;
      if (cell === host?.batchRows) { counts.rowSnapshots++; composeDirty = true; }
      if (next && typeof next === 'object' && 'renderedP' in next) counts.rowStatePublications++;
    }, modify(fn, force = true) { const next = fn(value); if (force || next !== value) { value = next; dirty.add(cell); if (cell === host?.batch) composeDirty = true; } } };
    values.push(cell); return cell;
  };
  let host;
  const react = { createContext: () => ({}), forwardRef: fn => fn, useCallback: fn => fn, useContext: () => host,
    useMemo: fn => fn(), useEffect: fn => { const t = performance.now(); cleanups.push(fn()); jsEffects.callbacks++; jsEffects.hostMs += performance.now() - t; }, createElement: (type, props) => (lastElement = { type, props }) };
  const ra = { default: { ScrollView: 'ScrollView', View: 'View' }, useSharedValue: shared, useAnimatedRef: () => () => {}, useScrollOffset() {}, cancelAnimation() {},
    scrollTo: (_ref, _x, y) => { host.actualOffset.value = y; }, useAnimatedStyle: fn => { fn = serialized ? rehydrate(fn) : fn; const deps = new Set(); reads = deps; fn(); reads = undefined; styleDeps.push(deps); styles.push(fn); return fn; },
    useAnimatedReaction: (prepare, react) => reactions.push({ prepare: serialized ? rehydrate(prepare) : prepare, react: serialized ? rehydrate(react) : react, previous: null }),
    useFrameCallback: (fn, active = true) => { const frame = { fn: serialized ? rehydrate(fn) : fn, active }; frames.push(frame); return { setActive: value => { frame.active = value; } }; },
    defineAnimation: (_initial, factory) => factory(), runOnUI: fn => (...args) => (serialized ? rehydrate(fn) : fn)(...args) };
  function load(source) { const module = { exports: {} }; vm.runInNewContext(source, { global: { Error }, module, exports: module.exports, require: name => name === 'react' ? react : name === 'react/jsx-runtime' ? { jsx: (type, props) => (lastElement = { type, props }) } : name === 'react-native' ? {} : name === './reference-scroll' ? api : ra }); return module.exports; }
  const api = load(serialized ? serializedBundle('reference-scroll.tsx') : original ? baseCode : code), helpers = load(serialized ? serializedBundle('batched-amll-motion.ts') : batchCode);
  host = { command: shared({ ...api.initialScrollCommand }), residual: shared(0), renderedResidual: shared(0), actualOffset: shared(0), motions: shared({}), spicy: false,
    ...(batched ? { batch: shared({ rows: {}, cells: {}, dirty: false }), batchRows: shared({}) } : {}) };
  api.ReferenceScrollView({}, null);
  const registerRow = api.useReferenceRowScroll;
  for (let i = 0; i < N; i++) registerRow(host, i, true);
  function flush() { for (const reaction of reactions) { const next = reaction.prepare(); reaction.react(next, reaction.previous); reaction.previous = next; } }
  function compose() { if (!batched || !composeDirty || composing) return; assert.notEqual(frameNumber, lastCompose, 'one registry publication per modeled mapper frame'); composing = true; host.motions.value = helpers.composeBatchedRegistry(host.batchRows.value, host.batch.value); composing = false; composeDirty = false; lastCompose = frameNumber; }
  flush();
  const previousStyles = [], trace = [], times = [];
  function issue(fields, order = false) {
    host.command.value = { ...host.command.value, serial: host.command.value.serial + 1, ...fields };
    const before = styles.map(fn => fn().transform[0].translateY);
    const list = order ? [...reactions].reverse() : reactions;
    for (const reaction of list) { const next = reaction.prepare(); reaction.react(next, reaction.previous); reaction.previous = next;
      if (!fields.instant && fields.snap !== false) assert.deepEqual(styles.map(fn => fn().transform[0].translateY), before, 'no intermediate cue flash'); }
  }
  function tick(cellTick) {
    frameNumber++; const before = { ...counts }, t = performance.now();
    if (reverse) cellTick?.();
    for (const frame of reverse ? [...frames].reverse() : frames) if (frame.active) { counts.callbacks++; frame.fn({ timeSincePreviousFrame: 1000 / fps }); }
    if (!reverse) cellTick?.();
    compose(); times.push(performance.now() - t);
    const positions = styles.map((fn, i) => { if (styleDeps[i].size && ![...styleDeps[i]].some(dep => dirty.has(dep)) && previousStyles[i] !== undefined) return previousStyles[i];
      counts.styleCalls++; reads = styleDeps[i]; const p = fn().transform[0].translateY; reads = undefined;
      if (p !== previousStyles[i]) { counts.styleEmissions++; previousStyles[i] = p; } return p; });
    trace.push({ frame: frameNumber, offset: host.actualOffset.value, residual: host.residual.value, positions,
      registry: JSON.parse(JSON.stringify(host.motions.value, (key, value) => key === 'owner' ? undefined : value)), publications: counts.registryPublications - before.registryPublications });
    dirty.clear();
    return trace.at(-1);
  }
  const cellApi = load(original ? baseCellCode : cellCode);
  function cell(index, p) {
    const startValues = values.length, startCleanup = cleanups.length;
    cellApi.AmllLayoutCell({ index }, null);
    const layout = lastElement.props.layout;
    const motion = values[startValues];
    let animation, now = 0;
    function start(delta) {
      const result = layout({ currentOriginY: delta, targetOriginY: 0 });
      animation = result.animations.transform[0].translateY;
      animation.onStart(animation, result.initialValues.transform[0].translateY, now);
    }
    start(p);
    return { motion, start, tick() { now += 1000 / fps; animation.onFrame(animation, now); return animation.current; },
      cleanup: () => cleanups[startCleanup]?.() };

  }
  return { host, helpers, counts, jsEffects, times, trace, issue, tick, cell, cleanups, values, reactions, styles };
}
function scenario(options) {
  const h = mount(options), { fps = 60 } = options;
  for (let f = 0; f < 12 * fps; f++) {
    if (f === fps) h.issue({ offset: 100, delta: 100, index: 2, firstVisible: 0, interval: 800, instant: false, snap: true });
    if (f === 2 * fps) h.issue({ offset: 220, delta: 120, index: 4, interval: 240, instant: false, snap: true, interlude: true });
    if (f === 2 * fps + Math.floor(fps / 5)) h.issue({ offset: 40, delta: -180, index: 1, interval: 100, instant: false, snap: true, interlude: false });
    if (f === 4 * fps) h.issue({ offset: 120, delta: 80, index: 3, interval: 800, instant: false, snap: true, geometry: true });
    if (f === 5 * fps) h.issue({ offset: 400, delta: 280, index: 5, instant: true, snap: true, geometry: false });
    if (f === 6 * fps) { h.issue({ instant: true, snap: false }); h.host.actualOffset.value = 650; }
    if (f === 7 * fps) h.issue({ offset: 200, delta: 0, index: 3, instant: false, snap: true });
    h.tick();
  }
  return h;
}
const blurSource = fs.readFileSync(path.join(dir, 'native-shared-blur.tsx'), 'utf8');
const blurSnippet = blurSource.slice(blurSource.indexOf('export function amllAnimatedProtection'), blurSource.indexOf('export function NativeSharedBlur'));
const blurModule = { exports: {} };
vm.runInNewContext(buildSync({ stdin: { contents: blurSnippet, loader: 'ts' }, format: 'cjs', write: false }).outputFiles[0].text,
  { module: blurModule, exports: blurModule.exports });
function compare(a, b, tolerance = 1e-7) {
  assert.equal(a.trace.length, b.trace.length); let maxDelta = 0;
  for (let f = 0; f < a.trace.length; f++) {
    assert.equal(a.trace[f].offset, b.trace[f].offset, 'viewport trajectory');
    for (let i = 0; i < a.trace[f].positions.length; i++) {
      const delta = Math.abs(a.trace[f].positions[i] - b.trace[f].positions[i]); maxDelta = Math.max(maxDelta, delta);
      assert(delta <= tolerance, `row ${i} frame ${f}: ${delta}`);
      const entry = b.trace[f].registry[i];
      if (entry && b.host.batch) assert(Math.abs(b.trace[f].positions[i] - entry.row) <= (entry.vLead ?? 0) + tolerance, 'conservative envelope includes hidden delta');
    }
    if (b.host.batch) {
      assert(b.trace[f].publications <= 1);
      const geometry = b.trace[f].positions.map((_, i) => ({ y: i * 100, height: 80 }));
      const envelope = blurModule.exports.amllAnimatedProtection(geometry, { first: 0, index: geometry.length - 1, top: 0, bottom: geometry.length * 100 }, b.trace[f].registry, b.trace[f].residual);
      for (let i = 0; i < geometry.length; i++) {
        const p = geometry[i].y + b.trace[f].positions[i] + (b.trace[f].registry[i]?.cell ?? 0);
        assert(envelope.top <= p + tolerance && envelope.bottom >= p + geometry[i].height - tolerance, 'actual blur helper protects every rendered row');
      }
    }
  }
  return maxDelta;
}
function verify() {
  const ordinary = scenario({ batched: true, N: 4, fps: 60 });
  const serialized = scenario({ serialized: true, batched: true, N: 4, fps: 60 });
  compare(ordinary, serialized, 0);
  const rows = [];
  for (const N of [8, 16]) for (const fps of [60, 120]) {
    const original = scenario({ original: true, N, fps }), off = scenario({ N, fps }), on = scenario({ batched: true, N, fps });
    compare(original, off, 0); const maxDelta = compare(off, on);
    const reverse = scenario({ batched: true, N, fps, reverse: true }); compare(on, reverse, 0);
    assert(on.trace.slice(-60).every(frame => frame.publications === 0), 'settled registry sleeps');
    const stats = h => ({ ...h.counts, hostCallbackMeanMs: h.times.reduce((a, b) => a + b, 0) / h.times.length });
    rows.push({ N, fps, frames: on.trace.length, maxDelta, off: stats(off), on: stats(on) });
  }
  for (const reverse of [false, true]) {
    const off = mount({ N: 4, reverse }), on = mount({ batched: true, N: 4, reverse });
    const a = off.cell(1, 80), b = on.cell(1, 80);
    for (let f = 0; f < 240; f++) {
      if (f === 30) { a.start(-45); b.start(-45); }
      off.tick(() => a.tick()); on.tick(() => b.tick());
      assert.equal(a.motion.value.p, b.motion.value.p, 'actual layout animation trajectory');
      const entry = on.host.motions.value[1];
      assert.equal(entry.cell, b.motion.value.p, 'composition sees same-frame cell regardless of frame callback order');
    }
    a.cleanup(); b.cleanup(); on.tick(); assert.equal(on.host.motions.value[1].cell, 0);
    b.tick(); on.tick(); assert.equal(on.host.motions.value[1].cell, 0, 'late actual animation cannot republish after cleanup');
  }
  // Cleanup ownership, late cell callbacks, recycle, retained small deltas and
  // declared composition ordering are exercised against exported source helpers.
  const h = mount({ batched: true, N: 2 }); h.tick();
  const slot = h.host.batch.value.rows[0];
  for (let i = 1; i <= 20; i++) {
    slot.sleeping = false; h.host.batch.value.awake = true;
    slot.state.value = { ...slot.state.value, p: i * 2e-8, delay: 0.5 };
    h.host.command.value = { ...h.host.command.value, snap: true };
    h.tick();
    const entry = h.host.motions.value[0];
    assert(Math.abs(slot.state.value.p - slot.output.value) < 1e-7 + Number.EPSILON);
    assert(entry.row - entry.vLead <= slot.state.value.p && entry.row + entry.vLead >= slot.state.value.p, 'retained envelope covers accumulating subpixel deltas');
  }
  const old = h.host.batch.value.rows[1].output;
  h.helpers.removeBatchedMotion(h.host.batch, 1, old, false); h.tick();
  assert(!h.host.motions.value[1], 'unmounted row removed at next publication');
  h.host.batch.value.rows[1] = { ...h.host.batch.value.rows[0], output: { value: 0 } };
  h.helpers.removeBatchedMotion(h.host.batch, 1, old, false);
  assert(h.host.batch.value.rows[1], 'stale cleanup cannot delete replacement');
  const owner = { value: { index: 0 } };
  h.helpers.stageBatchedCell(h.host, 0, owner, 80, 40, false); h.tick();
  assert.equal(h.host.motions.value[0].cell, 80);
  h.helpers.removeBatchedMotion(h.host.batch, 0, owner, true); owner.value.index = -1;
  h.helpers.stageBatchedCell(h.host, 0, owner, 999, 999, false); h.tick();
  assert.equal(h.host.motions.value[0].cell, 0, 'late callback cannot resurrect unmounted cell');
  console.log('Batched AMLL actual source PASS (including serialized worklet startup): OFF exact historical baseline, ON 60/120Hz interrupted/stagger/geometry/seek/drag trajectories, reverse callback order, local sleep, conservative small deltas, one registry publication/frame, cleanup ownership. HOST scheduler only.');
  return rows;
}
if (require.main === module) (async () => { console.log(JSON.stringify(verify(), null, 2)); })().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { mount, scenario, compare, verify };
