/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const directory = path.join(__dirname, '../components/lyrics/native');
const baselineIndex = process.argv.indexOf('--baseline');
const baselinePath = baselineIndex < 0 ? null : process.argv[baselineIndex + 1];
const bundle = filename => buildSync({ stdin: { contents: fs.readFileSync(filename, 'utf8'), resolveDir: directory, loader: 'tsx' },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['react', 'react-native-reanimated', '@shopify/react-native-skia'],
}).outputFiles[0].text;
const source = bundle(path.join(directory, 'native-glyph-picture.tsx'));
const baselineSource = baselinePath && bundle(baselinePath);

function mount(code, spicy, count = 3, start = 5000) {
  const frames = [], shared = [], cleanups = [];
  let reads = 0, pictures = 0;
  const countedArrays = new WeakSet();
  const counted = values => {
    if (countedArrays.has(values)) return values;
    const proxy = new Proxy(values, { get(target, key) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key);
    } });
    countedArrays.add(proxy);
    return proxy;
  };
  const words = counted(Array.from({ length: count }, (_, index) => {
    const rect = { x: index * 22, y: 0, width: 20, height: 24 };
    return { word: { text: 'sing', start: start + index * 600, end: start + index * 600 + 500,
      offset: index * 5, letters: ['s', 'i', 'n', 'g'], emphasized: false, joined: false },
    rects: [rect], letters: [[rect]], width: 20, before: index * 20, clips: [{}], pictures: [{ glyph: index }],
    runs: [[{ glyphs: [index + 1], positions: [{ x: rect.x, y: 20 }], font: 'font' }]] };
  }));
  const value = initial => {
    let current = initial;
    const wrap = next => next && Array.isArray(next.words) ? { ...next, words: counted(next.words) } : next;
    current = wrap(current);
    const result = { get value() { return current; }, set value(next) { current = wrap(next); },
      modify(fn) { current = fn(current); } };
    shared.push(result);
    return result;
  };
  const paint = () => ({ setAntiAlias() {}, setShader(shader) { this.shader = shader; },
    setColor(color) { this.color = color; }, setAlphaf(alpha) { this.alpha = alpha; },
    setImageFilter(filter) { this.filter = filter; } });
  const Skia = { XYWHRect: (x, y, width, height) => ({ x, y, width, height }), Paint: paint, Color: color => color,
    Shader: { MakeLinearGradient: (...args) => ({ gradient: args }) }, ImageFilter: { MakeBlur: (...args) => ({ blur: args }) } };
  const createPicture = draw => {
    pictures++;
    const commands = [];
    const canvas = {};
    for (const name of ['save', 'restore', 'translate', 'scale', 'clipPath', 'saveLayer', 'drawPicture', 'drawGlyphs'])
      canvas[name] = (...args) => commands.push([name, ...args.map(arg => arg && typeof arg === 'object' ? { ...arg } : arg)]);
    draw(canvas);
    return JSON.stringify(commands);
  };
  const react = { memo: fn => fn, useMemo: fn => fn(), useCallback: fn => fn,
    useEffect: fn => cleanups.push(fn()), createElement: (_type, props) => props };
  const moduleObject = { exports: {} };
  vm.runInNewContext(code, { module: moduleObject, exports: moduleObject.exports,
    require: name => name === 'react' ? react : name === 'react-native-reanimated'
      ? { useSharedValue: value, useFrameCallback: fn => {
        const frame = { fn, active: false }; frames.push(frame);
        return { setActive: active => { frame.active = active; } };
      } } : { Skia, createPicture, Picture: 'Picture', ClipOp: { Intersect: 0 }, TileMode: { Clamp: 0, Decal: 1 } } });
  const position = { value: 0 }, active = { value: false };
  const lineMotion = { value: { scale: 0.97, velocity: 0, bright: 0.2, dark: 0.2 } };
  moduleObject.exports.NativeGlyphPicture({ words, width: count * 22, height: 24, position, active, spicy,
    background: false, fontSize: 36, lineEnd: start + count * 600, lineMotion });
  return { position, active, lineMotion,
    tick(time, dt = 1000 / 120) { position.value = time; for (const frame of frames) if (frame.active) frame.fn({ timeSincePreviousFrame: dt }); },
    get picture() { return shared[0].value; }, get reads() { return reads; }, get pictures() { return pictures; },
    unmount() { for (const cleanup of cleanups) cleanup?.(); },
  };
}

for (const spicy of [true, false]) {
  const current = mount(source, spicy, 100, 100000);
  const baseline = baselineSource && mount(baselineSource, spicy, 100, 100000);
  for (let frame = 0; frame < 5; frame++) { current.tick(frame * 8); baseline?.tick(frame * 8); }
  const reads = current.reads, pictures = current.pictures, oldReads = baseline?.reads;
  for (let frame = 5; frame < 605; frame++) { current.tick(frame * 8); baseline?.tick(frame * 8); }
  assert.equal(current.pictures, pictures, 'Future idle voices retain their exact display list');
  assert.ok(current.reads - reads <= 600, 'Idle work must not scan every word in a mounted voice');
  if (baseline) {
    assert.equal(current.picture, baseline.picture);
    assert.ok(baseline.reads - oldReads >= 60000, 'Pre-change code scans the 100-word voice each frame');
  }
  console.log(`${spicy ? 'Spicy' : 'AMLL'} 100-word idle voice over 600 frames: ${current.reads - reads} word/state reads${baseline ? `, before ${baseline.reads - oldReads}` : ''}, zero picture rebuilds.`);
  current.unmount(); baseline?.unmount();

  const live = mount(source, spicy), old = baselineSource && mount(baselineSource, spicy);
  const tick = (time, dt) => { live.tick(time, dt); old?.tick(time, dt);
    if (old) assert.equal(live.picture, old.picture, `Draw commands must match at ${time} ms (${spicy ? 'Spicy' : 'AMLL'})`); };
  const active = enabled => { live.active.value = enabled; if (old) old.active.value = enabled; };
  for (let frame = 0; frame < 600; frame++) tick(frame * 8);
  active(true);
  for (let frame = 600; frame < 975; frame++) tick(frame * 8);
  active(false);
  for (let frame = 975; frame < 1400; frame++) tick(frame * 8);
  // Backward seek into an already cached voice, pause, then resume normal playback.
  active(true); tick(5200);
  for (let frame = 0; frame < 200; frame++) tick(5200);
  for (let frame = 1; frame < 120; frame++) tick(5200 + frame * 8);
  // A forward seek must retain the previous clock and trigger the reference snap.
  active(false); tick(14000);
  for (let frame = 0; frame < 200; frame++) tick(14000 + frame * 8);
  live.lineMotion.value = { ...live.lineMotion.value, bright: 0.5, dark: 0.3 };
  if (old) old.lineMotion.value = { ...old.lineMotion.value, bright: 0.5, dark: 0.3 };
  tick(16000);
  live.unmount(); old?.unmount();
}
console.log('Native glyph idle checks passed: cached work bounds, activation, release, pause/resume, seeks and line-paint invalidation.');
