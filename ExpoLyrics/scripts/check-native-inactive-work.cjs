/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const { transformSync } = require('@babel/core');

const nativeDir = path.join(__dirname, '../components/lyrics/native');
const sourcePath = path.join(nativeDir, 'use-reference-line-motion.ts');
const baselineIndex = process.argv.indexOf('--baseline');
const baselinePath = baselineIndex < 0 ? null : process.argv[baselineIndex + 1];
const bundle = (file, compiled = false) => buildSync({ stdin: {
  contents: compiled ? transformSync(fs.readFileSync(file, 'utf8'), { filename: file, presets: ['babel-preset-expo'] }).code : fs.readFileSync(file, 'utf8'),
  resolveDir: nativeDir, loader: compiled ? 'js' : 'ts',
},
  bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['react', 'react-native-reanimated', 'react-native-worklets'],
}).outputFiles[0].text;
const source = bundle(sourcePath, true);
const baselineSource = baselinePath ? bundle(baselinePath) : null;
const same = (a, b) => a?.length === b?.length && a.every((value, index) => Object.is(value, b[index]));

// Execute the real hook and its real spring solver. Only React, shared values and
// the UI frame scheduler are substituted, so an early return still counts as work.
// Hydrate Babel's serialized callbacks too: ordinary JS closures can hide native
// worklet capture bugs, such as assigning to a captured primitive.
function mount(code, fps, initial = {}) {
  const slots = [];
  const queue = new Map();
  let cursor = 0;
  let nextId = 0;
  let timestamp = 0;
  let calls = 0;
  let props = { activeLine: { value: false }, enabled: true, background: false, playing: true, ...initial };
  let motion;
  let context;
  const hydrated = new WeakMap();
  const onUI = fn => {
    if (!fn.__initData) return fn;
    if (hydrated.has(fn)) return hydrated.get(fn);
    const worklet = vm.runInContext(fn.__initData.code, context);
    const receiver = { __closure: fn.__closure.map(value => typeof value === 'function' ? onUI(value) : value) };
    const bound = worklet.bind(receiver);
    receiver._recur = bound;
    hydrated.set(fn, bound);
    return bound;
  };
  const slot = create => slots[cursor++] ?? (slots[cursor - 1] = create());
  const react = {
    useCallback: (fn, deps) => {
      const item = slot(() => ({}));
      if (!same(item.deps, deps)) Object.assign(item, { deps, fn });
      return item.fn;
    },
    useEffect: (setup, deps) => {
      const item = slot(() => ({}));
      if (!same(item.deps, deps)) Object.assign(item, { deps, setup, dirty: true });
    },
  };
  const reanimated = {
    useSharedValue: value => slot(() => ({ value })),
    useAnimatedReaction: (prepare, run) => {
      const item = slot(() => ({ reaction: true, previous: null, dirty: true }));
      Object.assign(item, { prepare: onUI(prepare), run: onUI(run), dirty: true });
    },
    useFrameCallback: (fn, active) => {
      const item = slot(() => ({ frame: true, active, first: true }));
      if (item.fn !== fn) { item.fn = fn; item.first = true; }
      item.control ??= { setActive: value => { item.active = value; item.first = true; } };
      return item.control;
    },
  };
  const moduleObject = { exports: {} };
  context = vm.createContext({ module: moduleObject, exports: moduleObject.exports,
    require: name => name === 'react' ? react : name === 'react-native-reanimated' ? reanimated : { scheduleOnUI: fn => onUI(fn)() },
    requestAnimationFrame: fn => { const id = nextId++; queue.set(id, onUI(fn)); return id; },
    cancelAnimationFrame: id => queue.delete(id),
  });
  context.global = context;
  vm.runInContext(code, context);
  const flush = () => {
    for (const item of slots) if (item.reaction) {
      const next = item.prepare();
      if (item.dirty || !item.previous || Object.keys(next).some(key => next[key] !== item.previous[key])) {
        item.run(next, item.previous);
        item.previous = next;
        item.dirty = false;
      }
    }
  };
  const render = patch => {
    props = { ...props, ...patch };
    cursor = 0;
    motion = moduleObject.exports.useReferenceLineMotion(props.activeLine, props.enabled, props.background, props.playing);
    for (const item of slots) if (item.dirty && item.setup) {
      item.cleanup?.(); item.cleanup = item.setup(); item.dirty = false;
    }
    flush();
  };
  render({});
  return {
    render,
    setActive: value => { props.activeLine.value = value; flush(); },
    tick: (elapsed = 1000 / fps) => {
      timestamp += elapsed;
      flush();
      const ready = [...queue];
      for (const [id] of ready) queue.delete(id);
      for (const [, fn] of ready) { calls++; fn(timestamp); }
      for (const item of slots) if (item.frame && item.active) {
        calls++;
        item.fn({ timestamp, timeSincePreviousFrame: item.first ? null : elapsed });
        item.first = false;
      }
      flush();
    },
    replayEffects: () => {
      for (const item of slots) item.cleanup?.();
      assert.equal(queue.size, 0, 'Strict Mode cleanup must cancel pending callbacks');
      for (const item of slots) {
        if (item.setup) item.cleanup = item.setup();
        if (item.reaction) item.dirty = true; // Restart the reaction mapper with retained hook state.
      }
      flush();
    },
    unmount: () => { for (const item of slots) item.cleanup?.(); },
    get motion() { return { ...motion.value }; },
    get calls() { return calls; },
    get pending() { return queue.size; },
  };
}

for (const fps of [60, 120]) for (const background of [false, true]) {
  const current = mount(source, fps, { background });
  const baseline = baselineSource && mount(baselineSource, fps, { background });
  const each = fn => { fn(current); if (baseline) fn(baseline); };
  const tick = count => {
    for (let index = 0; index < count; index++) {
      each(hook => hook.tick());
      if (baseline) for (const key of ['scale', 'bright', 'dark'])
        assert.ok(Math.abs(current.motion[key] - baseline.motion[key]) < 0.0001,
          `${fps} Hz ${background ? 'background' : 'lead'} ${key}: ${current.motion[key]} vs ${baseline.motion[key]}`);
    }
  };
  const rest = (scale, bright, dark) => {
    tick(fps * 6);
    assert.equal(current.pending, 0, 'Settled line must unregister its own frame work');
    for (const [key, expected] of Object.entries({ scale, bright, dark }))
      assert.ok(Math.abs(current.motion[key] - expected) < 1e-10, `${key} must retain the reference endpoint`);
    const before = current.calls;
    const baselineBefore = baseline?.calls;
    tick(fps * 5);
    assert.equal(current.calls, before, 'Five seconds at rest must execute zero line callbacks');
    if (baseline) assert.equal(baseline.calls - baselineBefore, fps * 5, 'The fixture must actually execute its resting callbacks');
  };
  rest(background ? 0.75 : 0.97, 0.2, 0.2);
  // Seeks change the UI presentation window without a React render.
  each(hook => hook.setActive(true));
  assert.equal(current.pending, 1, 'A forward/backward seek must wake a sleeping line on the UI runtime');
  tick(8);
  assert.ok(current.motion.scale > (background ? 0.75 : 0.97));
  each(hook => hook.setActive(false)); // Interrupt while carrying spring velocity.
  tick(3);
  each(hook => hook.setActive(true));
  rest(1, 1, 0.4);
  each(hook => hook.setActive(false));
  rest(background ? 0.75 : 0.97, 0.2, 0.2);
  each(hook => hook.render({ playing: false }));
  rest(1, 0.4, 0.4);
  each(hook => hook.render({ playing: true }));
  rest(background ? 0.75 : 0.97, 0.2, 0.2);
  each(hook => hook.render({ background: !background }));
  rest(background ? 0.97 : 0.75, 0.2, 0.2);
  // A recycled row may retain its hook state but receive a different shared
  // active signal, including replacement during an existing animation.
  each(hook => hook.render({ activeLine: { value: true } }));
  tick(4);
  each(hook => hook.render({ activeLine: { value: false } }));
  rest(background ? 0.97 : 0.75, 0.2, 0.2);
  each(hook => hook.setActive(true));
  tick(4);
  each(hook => hook.render({ enabled: false }));
  assert.equal(current.pending, 0, 'Disabling during motion must cancel queued work');
  const disabled = current.motion;
  tick(fps);
  assert.deepEqual(current.motion, disabled);
  each(hook => hook.render({ enabled: true }));
  rest(1, 1, 0.4);
  each(hook => hook.setActive(false));
  each(hook => hook.unmount());
  assert.equal(current.pending, 0, 'Unmount must cancel pending callbacks');
  const unmounted = current.motion;
  tick(3);
  assert.deepEqual(current.motion, unmounted);
  console.log(`${fps} Hz ${background ? 'background' : 'lead'}: settled callbacks 0 over 5s, wake/seek/interruption/recycle/pause/disable/unmount passed${baseline ? ', pre-change visual trace matched within 0.0001' : ''}.`);
}

for (const fps of [60, 120]) for (const background of [false, true]) {
  const current = mount(source, fps, { background });
  const baseline = baselineSource && mount(baselineSource, fps, { background });
  const each = fn => { fn(current); if (baseline) fn(baseline); };
  const compare = () => {
    if (baseline) for (const key of ['scale', 'bright', 'dark'])
      assert.ok(Math.abs(current.motion[key] - baseline.motion[key]) < 0.0001,
        `${fps} Hz suspension ${key}: ${current.motion[key]} vs ${baseline.motion[key]}`);
  };
  for (let index = 0; index < 8; index++) each(hook => hook.tick());
  // A delayed in-flight frame must still integrate the full reference delta.
  each(hook => hook.tick(250));
  compare();
  each(hook => hook.tick());
  compare();
  for (let index = 0; index < fps * 6; index++) each(hook => hook.tick());
  each(hook => hook.setActive(true));
  for (let index = 0; index < 8; index++) each(hook => hook.tick());
  each(hook => hook.tick(10_000)); // UI frames suspended, with the animation still registered.
  compare();
  assert.equal(current.pending, 0, 'The resumed frame must settle and put the line to sleep');
  for (let index = 0; index < fps; index++) each(hook => hook.tick());
  each(hook => hook.setActive(false));
  each(hook => hook.tick());
  assert.equal(current.motion.scale, 1, 'Wake must discard the cached suspension delta');
  assert.ok(current.motion.bright > 0.9, 'The next lyric cue must fade instead of jumping to the inactive endpoint');
  assert.equal(current.pending, 1, 'The next lyric cue must continue animating after suspension');
  for (let index = 0; index < fps * 6; index++) each(hook => hook.tick());
  compare();
  assert.equal(current.pending, 0);
  each(hook => hook.unmount());
  console.log(`${fps} Hz ${background ? 'background' : 'lead'}: continuous delayed frames and suspension/settle/wake passed.`);
}

for (const active of [false, true]) {
  const current = mount(source, 120, { activeLine: { value: active } });
  current.tick();
  current.replayEffects();
  assert.equal(current.pending, 1, 'Strict Mode setup replay must restart exactly one loop');
  for (let index = 0; index < 720; index++) current.tick();
  assert.equal(current.pending, 0, 'A replayed loop must still sleep at rest');
  current.setActive(!active);
  assert.equal(current.pending, 1, 'A replayed loop must still wake on lyric changes');
  current.unmount();
  assert.equal(current.pending, 0, 'Unmount after replay must cancel pending callbacks');
  const calls = current.calls;
  current.tick();
  assert.equal(current.calls, calls);
}
console.log('Strict Mode cleanup/setup replay: single loop, settle, wake, and unmount passed.');

// Model the mounted buffer, not the whole song. Scroll position is deliberately
// absent from this hook: moving a settled row into view cannot freeze its cues.
const buffered = Array.from({ length: 12 }, () => mount(source, 120));
for (let index = 0; index < 720; index++) for (const row of buffered) row.tick();
const before = buffered.reduce((sum, row) => sum + row.calls, 0);
for (let index = 0; index < 600; index++) for (const row of buffered) row.tick();
assert.equal(buffered.reduce((sum, row) => sum + row.calls, 0) - before, 0);
buffered[8].setActive(true);
for (let index = 0; index < 20; index++) for (const row of buffered) row.tick();
assert.ok(buffered[8].motion.scale > 0.97, 'A previously idle mounted row must resume even away from the follow target');
assert.equal(buffered[0].calls + buffered[1].calls, before / 6, 'Unrelated resting rows must remain asleep');
for (const row of buffered) row.unmount();
if (baselineSource) {
  const oldBuffer = Array.from({ length: 12 }, () => mount(baselineSource, 120));
  for (let index = 0; index < 720; index++) for (const row of oldBuffer) row.tick();
  const oldBefore = oldBuffer.reduce((sum, row) => sum + row.calls, 0);
  for (let index = 0; index < 600; index++) for (const row of oldBuffer) row.tick();
  assert.equal(oldBuffer.reduce((sum, row) => sum + row.calls, 0) - oldBefore, 7200);
  for (const row of oldBuffer) row.unmount();
}
console.log('12 settled mounted voices at 120 Hz: 0 line callbacks over 5s (previous continuously registered design: 7,200).');
