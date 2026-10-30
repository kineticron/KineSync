/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const directory = path.join(__dirname, '../components/lyrics/native');
const baselineIndex = process.argv.indexOf('--baseline');
const compareIndex = process.argv.indexOf('--compare-baseline');
const compareOnly = compareIndex >= 0;
const baselinePath = compareOnly ? process.argv[compareIndex + 1] : baselineIndex < 0 ? null : process.argv[baselineIndex + 1];
const bundle = filename => buildSync({ stdin: { contents: fs.readFileSync(filename, 'utf8'), resolveDir: directory, loader: 'tsx' },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['react', 'react-native-reanimated', '@shopify/react-native-skia'],
}).outputFiles[0].text;
const source = bundle(path.join(directory, 'native-glyph-picture.tsx'));
const baselineSource = baselinePath && bundle(baselinePath);

function mount(code, spicy, count = 3, start = 5000, letterCount = 4) {
  const frames = [], shared = [], cleanups = [];
  let reads = 0, pictures = 0, paints = 0, blurFilters = 0, blurFilterDisposals = 0, paintSlotWrites = 0;
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
    const letters = Array.from({ length: letterCount }, (_, letter) => String.fromCharCode(97 + letter % 26));
    return { word: { text: letters.join(''), start: start + index * 600, end: start + index * 600 + 500,
      offset: index * 5, letters, emphasized: true, joined: false,
      emphasis: { start: start + index * 600, end: start + index * 600 + 500, index: 0, count: letters.length, last: index === count - 1 } },
    rects: [rect], letters: letters.map((_, letter) => [{ ...rect, x: rect.x + letter * 4, width: 4 }]),
    revealRects: letters.map(() => rect), width: 20, before: index * 20, clips: letters.map(() => ({})),
    pictures: letters.map(() => ({ glyph: index })), emojiMask: letters.map(() => false),
    runs: letters.map((_, letter) => [{ glyphs: [index * letters.length + letter + 1], positions: [{ x: rect.x + letter * 4, y: 20 }], font: 'font' }]) };
  }));
  const value = initial => {
    let current = initial;
    const wrap = next => next && Array.isArray(next.words) ? { ...next, words: counted(next.words) } : next;
    current = wrap(current);
    const result = { get value() { return current; }, set value(next) { if (initial === null && next !== current) paintSlotWrites++; current = wrap(next); },
      modify(fn) { current = fn(current); } };
    shared.push(result);
    return result;
  };
  const paint = () => { paints++; return { color: 'black', setAntiAlias() {}, setShader(shader) { this.shader = shader; },
    setBlendMode(mode) { this.blendMode = mode; },
    setColor(color) { this.color = color; }, setAlphaf(alpha) { this.alpha = alpha; },
    setImageFilter(filter) { this.filter = filter; } }; };
  const Skia = { XYWHRect: (x, y, width, height) => ({ x, y, width, height }), Paint: paint, Color: color => color,
    Shader: { MakeLinearGradient: (...args) => ({ gradient: args }) }, ImageFilter: { MakeBlur: (...args) => { blurFilters++;
      return { blur: args, dispose() { blurFilterDisposals++; } }; } } };
  const createPicture = draw => {
    pictures++;
    const commands = [];
    const canvas = {};
    for (const name of ['save', 'restore', 'translate', 'scale', 'clipPath', 'saveLayer', 'drawPicture', 'drawGlyphs', 'drawPaint'])
      canvas[name] = (...args) => commands.push([name, ...args.map(arg => arg && typeof arg === 'object' ? { ...arg } : arg)]);
    draw(canvas);
    const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
    return JSON.stringify(stable(commands));
  };
  const react = { memo: fn => fn, useMemo: fn => fn(), useCallback: fn => fn,
    useEffect: fn => cleanups.push(fn()), createElement: (_type, props) => props };
  const moduleObject = { exports: {} };
  vm.runInNewContext(code, { module: moduleObject, exports: moduleObject.exports,
    require: name => name === 'react' ? react : name === 'react-native-reanimated'
      ? { useSharedValue: value, useFrameCallback: fn => {
        const frame = { fn, active: false }; frames.push(frame);
        return { setActive: active => { frame.active = active; } };
      } } : { Skia, createPicture, Picture: 'Picture', BlendMode: { SrcIn: 5, SrcOver: 3 }, ClipOp: { Intersect: 0 }, TileMode: { Clamp: 0, Decal: 1 } } });
  const position = { value: 0 }, active = { value: false };
  const lineMotion = { value: { scale: 0.97, velocity: 0, bright: 0.2, dark: 0.2 } };
  moduleObject.exports.NativeGlyphPicture({ words, width: count * 22, height: 24, position, active, spicy,
    background: false, fontSize: 36, lineEnd: start + count * 600, lineMotion });
  return { position, active, lineMotion,
    tick(time, dt = 1000 / 120) { position.value = time; for (const frame of frames) if (frame.active) frame.fn({ timeSincePreviousFrame: dt }); },
    get picture() { return shared[0].value; }, get reads() { return reads; }, get pictures() { return pictures; }, get paints() { return paints; },
    get blurFilters() { return blurFilters; },
    get blurFilterDisposals() { return blurFilterDisposals; },
    get paintSlotWrites() { return paintSlotWrites; },
    get reusablePaints() { return shared.find(item => item.value?.paint)?.value ?? null; },
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
    if (!compareOnly) assert.ok(baseline.reads - oldReads >= 60000, 'Pre-change code scans the 100-word voice each frame');
  }
  console.log(`${spicy ? 'Spicy' : 'AMLL'} 100-word idle voice over 600 frames: ${current.reads - reads} word/state reads${baseline ? `, before ${baseline.reads - oldReads}` : ''}, zero picture rebuilds.`);
  current.unmount(); baseline?.unmount();

  const live = mount(source, spicy), old = baselineSource && mount(baselineSource, spicy);
  const tick = (time, dt) => { live.tick(time, dt); old?.tick(time, dt);
    if (old) assert.equal(live.picture, old.picture, `Draw commands must match at ${time} ms (${spicy ? 'Spicy' : 'AMLL'})`); };
  const active = enabled => { live.active.value = enabled; if (old) old.active.value = enabled; };
  for (let frame = 0; frame < 600; frame++) tick(frame * 8);
  const paintsAtStart = live.paints;
  const picturesAtStart = live.pictures;
  const blurFiltersAtStart = live.blurFilters;
  const baselineBlurFiltersAtStart = old?.blurFilters;
  const legacyPaintsAtStart = old?.paints;
  active(true);
  for (let frame = 600; frame < 975; frame++) tick(frame * 8);
  assert.equal(live.paints - paintsAtStart, 0, 'After initial paint creation, an active voice reuses the same two paints across 375 picture rebuilds');
  assert.equal(live.paints, 2, 'One mounted NativeGlyphPicture owns one paint pair');
  assert.equal(live.paintSlotWrites, 1, 'Reusable paint handles are published once, never written into SharedValue each frame');
  assert.equal(live.reusablePaints.paint.shader, null, 'Completed picture does not leave a shader retained by the reusable paint');
  assert.equal(live.reusablePaints.glowPaint.filter, null, 'Completed picture does not leave an image filter retained by the reusable paint');
  assert.equal(live.pictures - picturesAtStart, 375, 'The active voice still records a new picture for each changing animation frame');
  if (old) assert.equal(old.paints - legacyPaintsAtStart, 750, 'legacy renderer allocates two paints on each active picture rebuild');
  assert(live.blurFilters > blurFiltersAtStart, 'Active glow frames record blurred letter layers');
  const currentGlowFilters = live.blurFilters - blurFiltersAtStart;
  const baselineGlowFilters = old ? old.blurFilters - baselineBlurFiltersAtStart : null;
  assert(live.reusablePaints.blurRadii.length <= 32, 'Mounted voice retains at most 32 exact-radius filters');
  assert.equal(live.reusablePaints.blurFilters.length, live.reusablePaints.blurRadii.length);
  assert.equal(live.blurFilterDisposals, 0, 'No cached filter is explicitly disposed while recorded pictures may retain it');
  if (old) {
    if (spicy) assert.equal(currentGlowFilters, baselineGlowFilters, 'Spicy playback preserves its existing exact-radius filter count');
    else assert(currentGlowFilters < baselineGlowFilters, 'AMLL reuses repeated exact radii without reducing distinct values');
  }
  console.log(`${spicy ? 'Spicy' : 'AMLL'} active 375-frame probe: ${live.pictures - picturesAtStart} recorded pictures, ` +
    `${currentGlowFilters} blur filters${old ? ` (baseline ${baselineGlowFilters})` : ''}, ${live.paints - paintsAtStart} new paint objects`);
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
const liveCounts = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/native-memory-live-counts.json'), 'utf8'));
for (const track of liveCounts.tracks) {
  const lettersPerSegment = Math.max(1, Math.ceil(track.maxLettersPerVoice / track.maxSegmentsPerVoice));
  const live = mount(source, true, track.maxSegmentsPerVoice, 1000, lettersPerSegment);
  const old = baselineSource && mount(baselineSource, true, track.maxSegmentsPerVoice, 1000, lettersPerSegment);
  live.active.value = true;
  if (old) old.active.value = true;
  const initialPictureCount = live.pictures;
  for (let frame = 0; frame < 60; frame++) {
    live.tick(1000 + frame * (1000 / 60));
    old?.tick(1000 + frame * (1000 / 60));
    if (old) assert.equal(live.picture, old.picture, `${track.isrc}: active picture output remains unchanged`);
  }
  assert.equal(live.pictures - initialPictureCount, 60, `${track.isrc}: one new picture per active frame`);
  assert.equal(live.paints, 2, `${track.isrc}: one cached paint pair per simulated voice`);
  assert.equal(live.paintSlotWrites, 1, `${track.isrc}: paint shared value is written only once`);
  assert(live.blurFilters > 0, `${track.isrc}: animated voice exercises image-filter allocation`);
  console.log(`${track.title} (${track.isrc}) count-scaled voice: 60 frames, 60 picture records, ` +
    `${live.blurFilters} blur filters, ${live.paints} paint objects; fixture sizes ${track.lines} lines/${track.maxSegmentsPerVoice} max segments/${track.maxLettersPerVoice} max letters.`);
  live.unmount(); old?.unmount();
}
console.log('Native glyph idle checks passed: cached work bounds, activation, release, pause/resume, seeks and line-paint invalidation.');
