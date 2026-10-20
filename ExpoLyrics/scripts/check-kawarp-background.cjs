/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const { transformSync } = require('@babel/core');
const CanvasKitInit = require('canvaskit-wasm/bin/full/canvaskit.js');
const root = path.resolve(__dirname, '..');

function load(entry, dependencies = {}, contents, globals = {}) {
  const source = buildSync({
    ...(contents ? { stdin: { contents, resolveDir: root, loader: 'ts' } } : { entryPoints: [path.join(root, entry)] }),
    bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['@shopify/react-native-skia', ...Object.keys(dependencies)],
  }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, console, ...globals,
    require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name) });
  return module.exports;
}

async function checkPixels() {
  // Execute the production texture pipeline with Skia's real CPU backend, not shader mocks.
  const kit = await CanvasKitInit({ locateFile: file => path.join(path.dirname(require.resolve('canvaskit-wasm/bin/full/canvaskit.js')), file) });
  const adapter = load(null, {}, [
    'export { JsiSkApi } from "./node_modules/@shopify/react-native-skia/src/skia/web/JsiSkia";',
    'export { FilterMode, MipmapMode, TileMode } from "./node_modules/@shopify/react-native-skia/src/skia/types";',
  ].join('\n'));
  const Skia = adapter.JsiSkApi(kit);
  const api = { ...adapter, Skia };
  const texture = load('components/lyrics/kawarp-texture.ts', { '@shopify/react-native-skia': api });
  const { kawarpRenderSize } = load('components/lyrics/kawarp-shaders.ts');
  const effects = texture.makeKawarpEffects();
  assert.ok(effects, 'Every production SkSL shader must compile');
  for (const [width, height, density] of [[390, 844, 3], [844, 390, 3], [393, 852, 3], [402, 874, 3], [874, 402, 3],
    [411.428571, 891.428571, 2.625], [2048, 2732, 2], [100, 200, 1]]) {
    const size = kawarpRenderSize(width, height, density);
    assert.ok(Math.max(size.width, size.height) * density <= 720.001);
    for (const axis of ['width', 'height']) {
      assert.equal(size[axis], Math.trunc(size[axis]), 'Canvas dimensions use whole layout points for the iOS Metal provider');
      const nativeSize = Math.trunc(size[axis]);
      const target = axis === 'width' ? width : height;
      const filteredEdge = size.scale / density / 2;
      assert.ok(size.bleed > filteredEdge, 'The leading filtered surface edge stays outside the viewport');
      assert.ok(nativeSize * size.scale - size.bleed - filteredEdge >= target - 0.000001,
        'The trailing filtered surface edge stays outside the viewport after iOS point truncation');
      assert.ok(nativeSize * size.scale < target + 5 * size.scale,
        'Overscan stays within a few source points');
    }
  }
  const solid = color => {
    const surface = Skia.Surface.Make(256, 64);
    surface.getCanvas().clear(kit.Color4f(...color));
    const source = surface.makeImageSnapshot();
    const result = texture.makeKawarpTexture(source, effects);
    assert.equal(result.width(), 128);
    assert.equal(result.height(), 128);
    source.dispose(); surface.dispose();
    return result;
  };
  const red = solid([1, 0, 0, 1]), blue = solid([0, 0, 1, 1]);
  const mixed = texture.blendKawarpTextures(red, blue, 0.25);
  const pixel = mixed.readPixels(), redPixels = red.readPixels(), bluePixels = blue.readPixels();
  for (let channel = 0; channel < 4; channel++) {
    const expected = redPixels[channel] * 0.75 + bluePixels[channel] * 0.25;
    assert.ok(Math.abs(pixel[channel] - expected) <= 2, 'Interrupted crossfade preserves its exact color mix');
  }
  assert.equal(texture.blendKawarpTextures(red, blue, 0), red);
  assert.equal(texture.blendKawarpTextures(red, blue, 1), blue);

  const encoded = Skia.Data.fromBytes(fs.readFileSync(process.env.KAWARP_PREVIEW_ART || path.join(root, 'assets/images/promotional-banner.png')));
  const art = Skia.Image.MakeImageFromEncoded(encoded);
  const blurred = texture.makeKawarpTexture(art, effects);
  const imageShader = image => image.makeShaderOptions(api.TileMode.Clamp, api.TileMode.Clamp, api.FilterMode.Linear, api.MipmapMode.None);
  function render(time, blend, first = blurred, second = blurred) {
    const surface = Skia.Surface.Make(180, 320), paint = Skia.Paint();
    const children = [imageShader(first), imageShader(second)];
    const shader = effects.warp.makeShaderWithChildren([180, 320, time, blend], children);
    paint.setShader(shader);
    surface.getCanvas().drawRect(Skia.XYWHRect(0, 0, 180, 320), paint);
    const output = surface.makeImageSnapshot();
    const pixels = output.readPixels();
    // Optional visual QA artifact, always generated from the production shader.
    if (process.env.KAWARP_PREVIEW_DIR && first === blurred && second === blurred) {
      fs.mkdirSync(process.env.KAWARP_PREVIEW_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.KAWARP_PREVIEW_DIR, `kawarp-${time}-${blend}.png`), output.encodeToBytes());
    }
    output.dispose(); shader.dispose(); children.forEach(child => child.dispose());
    paint.dispose(); surface.dispose();
    return pixels;
  }
  const initial = render(0, 1), later = render(6, 1);
  const preparedFrame = texture.makeKawarpFrame(blurred, effects.warp, 0, 180, 320, 1);
  assert.deepEqual(preparedFrame.readPixels(), initial, 'The prepared bitmap exactly matches the live shader at fade completion');
  preparedFrame.dispose();
  assert.notDeepEqual(initial, later, 'Actual album colors move through the domain warp');
  assert.deepEqual(render(0, 0, red, blue), render(0, 1, red, red), 'Crossfade starts from the old artwork');
  assert.deepEqual(render(0, 1, red, blue), render(0, 1, blue, blue), 'Crossfade ends at the new artwork');
  for (let i = 0; i < initial.length; i += 4) {
    assert.equal(initial[i + 3], 255, 'The background has no transparent holes');
    assert.ok(Math.max(initial[i], initial[i + 1], initial[i + 2]) < 125, 'White lyrics retain contrast');
  }
  const white = solid([1, 1, 1, 1]);
  const whiteOutput = render(0, 1, white, white);
  const luminance = value => { const v = value / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  for (let i = 0; i < whiteOutput.length; i += 4) {
    const luma = 0.2126 * luminance(whiteOutput[i]) + 0.7152 * luminance(whiteOutput[i + 1]) + 0.0722 * luminance(whiteOutput[i + 2]);
    assert.ok(1.05 / (luma + 0.05) >= 4.5, 'Even white album art supports readable white text');
  }

  // Surface allocation failure still releases its temporary shader.
  const origSurfaceMake = Skia.Surface.Make;
  Skia.Surface.Make = function unavailableSurface() { return null; };
  let failedShaderDisposals = 0;
  try {
    const failedEffects = { ...effects, tint: { makeShaderWithChildren: () => ({ dispose() { failedShaderDisposals++; } }) } };
    assert.throws(() => texture.makeKawarpTexture(art, failedEffects), /Cannot allocate artwork background texture/);
    assert.equal(failedShaderDisposals, 1, 'The shader must be released even when no surface can be created');
  } finally { Skia.Surface.Make = origSurfaceMake; }

  // Execute Babel-serialized worker closures against real Skia, not ordinary JS closures.
  const workerBundle = buildSync({ entryPoints: [path.join(root, 'components/lyrics/kawarp-artwork-loader.ts')],
    bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['@shopify/react-native-skia', 'react-native-worklets'], }).outputFiles[0].text;
  const workerCode = transformSync(workerBundle, { filename: path.join(root, 'components/lyrics/kawarp-artwork-loader.ts'), presets: ['babel-preset-expo'] }).code;
  let context, inWorker = false, runtimes = 0, workerCalls = 0;
  const hydrated = new WeakMap();
  const hydrate = fn => {
    if (!fn.__initData) return fn;
    if (hydrated.has(fn)) return hydrated.get(fn);
    const receiver = { __closure: fn.__closure.map(value => typeof value === 'function' ? hydrate(value) : value) };
    const bound = vm.runInContext(fn.__initData.code, context).bind(receiver);
    receiver._recur = bound; hydrated.set(fn, bound); return bound;
  };
  const workerModule = { exports: {} };
  context = vm.createContext({ module: workerModule, exports: workerModule.exports,
    require: name => name === '@shopify/react-native-skia' ? api : name !== 'react-native-worklets' ? require(name) : {
      createWorkletRuntime(config) { runtimes++; assert.equal(config.enableEventLoop, false); return {}; },
      runOnRuntimeAsync(_runtime, fn, ...args) {
        assert.ok(fn.__initData, 'The real worker entry must be serialized by the Expo worklet plugin');
        return new Promise((resolve, reject) => setImmediate(() => {
          inWorker = true; workerCalls++;
          try { resolve(hydrate(fn)(...args)); } catch (error) { reject(error); } finally { inWorker = false; }
        }));
      },
    },
  });
  context.global = context;
  const decode = Skia.Image.MakeImageFromEncoded;
  Skia.Image.MakeImageFromEncoded = (...args) => {
    assert.ok(inWorker, 'Encoded image decode cannot execute on RN or UI');
    return decode.apply(Skia.Image, args);
  };
  try {
    vm.runInContext(workerCode, context);
    const prepare = workerModule.exports.prepareKawarpArtwork;
    const firstJob = prepare(encoded, null, 1, 0, 60, 100, 2);
    assert.equal(workerCalls, 0, 'Preparation must yield before doing any raster work');
    const first = await firstJob;
    assert.equal(first.frame.width(), 120); assert.equal(first.frame.height(), 200);
    const next = await prepare(encoded, first, 0.35, 0, 60, 100, 2);
    assert.equal(runtimes, 1, 'Loads reuse one worker runtime');
    const partial = next.previousFrame.readPixels();
    assert.ok(partial[3] > 0 && partial[3] < 255, 'Interrupting the first fade preserves its partial opacity');
    [first.texture, first.frame, next.texture, next.frame, next.previousFrame, ...Object.values(first.effects)].forEach(value => value.dispose());
  } finally { Skia.Image.MakeImageFromEncoded = decode; }

  [red, blue, mixed, blurred, white, art, encoded, ...Object.values(effects)].forEach(value => value.dispose());
}

async function checkLifecycle() {
  let cursor = 0, dirty = false, tree, props = { uri: 'https://art/first', playing: true, active: true };
  const slots = [], pending = [], requests = new Map(), jobs = [], listeners = new Map(), frames = [];
  const transitions = [], blends = [], disposed = [];
  const memo = (fn, deps) => {
    const index = cursor++, old = slots[index];
    if (!old || !deps || deps.some((value, i) => !Object.is(old.deps?.[i], value))) slots[index] = { value: fn(), deps };
    return slots[index].value;
  };
  const React = {
    memo: fn => fn, useMemo: memo, useCallback: (fn, deps) => memo(() => fn, deps),
    useContext: () => true, useRef: value => memo(() => ({ current: value }), []),
    useState: initial => {
      const state = memo(() => ({ value: initial }), []);
      return [state.value, value => { const next = typeof value === 'function' ? value(state.value) : value;
        if (next !== state.value) { state.value = next; dirty = true; } }];
    },
    useEffect: (fn, deps) => {
      const index = cursor++, old = slots[index];
      if (!old || deps.some((value, i) => !Object.is(old.deps[i], value))) {
        slots[index] = { deps, cleanup: old?.cleanup };
        pending.push(() => { slots[index].cleanup?.(); slots[index].cleanup = fn(); });
      }
    },
  };
  const shared = value => ({ value, get() { return this.value; }, set(next) {
    if (next && typeof next === 'object' && 'target' in next) {
      const animation = { shared: this, from: this.value, to: next.target, duration: next.options.duration, complete: next.complete };
      transitions.push(animation); this.animation = animation;
    } else this.value = next;
  } });
  const Reanimated = {
    __esModule: true, default: { View: 'AnimatedView' },
    useReducedMotion: () => false, useSharedValue: initial => memo(() => shared(initial), []),
    makeMutable: value => { const blend = shared(value); blends.push(blend); return blend; },
    useDerivedValue: fn => ({ get value() { return fn(); } }),
    useAnimatedStyle: fn => ({ get opacity() { return fn().opacity; } }),
    cancelAnimation(value) { value.animation?.complete?.(false); value.animation = null; },
    withTiming: (target, options, complete) => ({ target, options, complete }), Easing: { bezier() {} },
    useFrameCallback: fn => {
      const frame = memo(() => { const value = { active: false, callback: fn, setActive(active) { this.active = active; } }; frames.push(value); return value; }, []);
      frame.callback = fn; return frame;
    },
  };
  const listen = (name, fn) => { listeners.set(name, fn); return { remove: () => listeners.delete(name) }; };
  const jsx = (type, props, key) => ({ type, key, props });
  const image = id => ({ id, dispose() { disposed.push(id); } });
  const component = load('components/lyrics/artwork-background.tsx', {
    react: React, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': { View: 'View', PixelRatio: { get: () => 3 }, StyleSheet: { create: x => x },
      AppState: { currentState: 'active', addEventListener: listen }, AccessibilityInfo: { addEventListener: listen } },
    'react-native-reanimated': Reanimated,
    'react-native-worklets': { scheduleOnRN: (fn, ...args) => fn(...args) },
    '@shopify/react-native-skia': { Canvas: 'Canvas', Image: 'Image', Fill: 'Fill', ImageShader: 'ImageShader', Shader: 'Shader',
      FilterMode: {}, MipmapMode: {}, Skia: { Data: { fromBytes: bytes => image(['first', 'latest', 'stale'][bytes[0]]) },
        Image: { MakeImageFromEncoded() { throw new Error('Decode must not run on RN'); } } } },
    './kawarp-artwork-loader': { prepareKawarpArtwork: (...args) => new Promise((resolve, reject) => jobs.push({ args, resolve, reject })) },
    './artwork-background-fallback': { ArtworkBackgroundFallback: 'Fallback' },
    '@/components/ui/launch-visibility': {}, '@/components/ui/promotional-backdrop': { PromotionalBackdrop: 'Promotional' },
  }, undefined, { AbortController, setTimeout, clearTimeout,
    fetch: (uri, { signal }) => new Promise((resolve, reject) => requests.set(uri, { resolve, reject, signal })) }).ArtworkBackground;
  const render = updates => {
    props = { ...props, ...updates };
    let count = 0;
    do { assert.ok(count++ < 12); dirty = false; cursor = 0; tree = component(props); pending.splice(0).forEach(fn => fn()); } while (dirty);
  };
  const settle = async () => { await new Promise(setImmediate); render(); };
  const nodes = (node, type) => !node ? [] : Array.isArray(node) ? node.flatMap(child => nodes(child, type))
    : [...(node.type === type ? [node] : []), ...nodes(node.props?.children, type)];
  const resolveArtwork = (uri, id) => requests.get(uri).resolve({ ok: true, arrayBuffer: async () => Uint8Array.of(id).buffer });
  const resolveJob = job => { const id = job.args[0].id;
    job.resolve({ texture: image(id), frame: image(id + '-frame'), previousFrame: job.args[1] ? image('previous-frame') : null, effects: { warp: {} } }); };
  const finishFade = () => { const blend = blends.at(-1); blend.value = 1; blend.animation.complete(true); render(); };
  render();
  tree.props.onLayout({ nativeEvent: { layout: { width: 390, height: 844 } } }); render();
  assert.equal(nodes(tree, 'Canvas').length, 1, 'The native surface mounts before the artwork arrives');
  assert.equal(frames[0].active, false);
  resolveArtwork(props.uri, 0); await settle();
  assert.equal(jobs.length, 1);
  assert.equal(nodes(tree, 'Image').length, 0, 'Unprepared artwork cannot start a fade');
  resolveJob(jobs[0]); await settle();
  assert.equal(frames[0].active, false, 'No motion callback during initial fade');
  assert.equal(nodes(tree, 'Shader').length, 0, 'Opacity fades never draw the expensive warp shader');
  assert.equal(nodes(tree, 'Image').length, 1);
  assert.equal(nodes(tree, 'Image')[0].props.opacity, blends[0]);
  assert.equal(transitions.find(t => t.shared === blends[0]).duration, 1200);
  const canvasStyle = nodes(tree, 'Canvas')[0].props.style;
  assert.ok(canvasStyle.left < 0 && canvasStyle.top < 0);
  assert.ok(canvasStyle.width * canvasStyle.transform[0].scale + canvasStyle.left > 390);
  assert.ok(canvasStyle.height * canvasStyle.transform[0].scale + canvasStyle.top > 844);
  finishFade();
  assert.equal(frames[0].active, true);
  assert.equal(nodes(tree, 'Shader').length, 1);
  for (const changes of [{ playing: false }, { active: false }]) {
    render(changes); assert.equal(frames[0].active, false);
    render({ playing: true, active: true }); assert.equal(frames[0].active, true);
  }
  listeners.get('change')('background'); render(); assert.equal(frames[0].active, false);
  listeners.get('change')('active'); render(); assert.equal(frames[0].active, true);
  listeners.get('reduceMotionChanged')(true); render(); assert.equal(frames[0].active, false);
  listeners.get('reduceMotionChanged')(false); render(); assert.equal(frames[0].active, true);
  assert.equal(requests.size, 1);
  const time = slots.find(slot => slot?.value?.get && typeof slot.value.value === 'number').value;
  for (const hz of [60, 120]) {
    let changes = 0;
    for (let i = 0; i < hz; i++) { const before = time.value; frames[0].callback({ timeSincePreviousFrame: 1000 / hz }); if (time.value !== before) changes++; }
    assert.equal(changes, 30);
  }
  render({ uri: 'https://art/slow' }); render({ uri: 'https://art/latest' });
  assert.equal(requests.get('https://art/slow').signal.aborted, true);
  resolveArtwork('https://art/latest', 1); await settle();
  assert.equal(frames[0].active, false, 'Worker preparation holds the old frame without blocking the UI');
  resolveJob(jobs.at(-1)); await settle();
  resolveArtwork('https://art/slow', 2); await settle();
  assert.equal(nodes(tree, 'Canvas').length, 1, 'Song changes never remount or allocate a second native surface');
  assert.equal(nodes(tree, 'Canvas')[0].key, undefined);
  assert.equal(nodes(tree, 'Shader').length, 0);
  assert.equal(nodes(tree, 'Image').length, 2);
  assert.ok(nodes(tree, 'Image').some(node => node.props.image.id === 'latest-frame'));
  assert.ok(nodes(tree, 'Image').every(node => !node.props.image.id.includes('stale')));
  const heldTime = time.value;
  for (const hz of [60, 120]) for (let i = 0; i < hz; i++) {
    blends[1].value = i / hz;
    assert.equal(frames[0].active, false);
    assert.equal(time.value, heldTime);
    assert.equal(nodes(tree, 'Shader').length, 0);
  }
  render({ playing: false }); finishFade();
  assert.equal(frames[0].active, false);
  render({ playing: true }); assert.equal(frames[0].active, true);
  blends[1].value = 0.35;
  render({ uri: 'https://art/interrupted' }); resolveArtwork(props.uri, 0); await settle();
  const interrupted = jobs.at(-1);
  assert.equal(interrupted.args[2], 0.35, 'Interrupted fades preserve their displayed image mix');
  render({ uri: 'https://art/newest' });
  resolveJob(interrupted); await settle();
  assert.equal(blends.length, 2, 'A stale worker result cannot publish a new scene');
  resolveArtwork(props.uri, 1); await settle(); resolveJob(jobs.at(-1)); await settle(); finishFade();
  const requestsBeforeResize = requests.size;
  tree.props.onLayout({ nativeEvent: { layout: { width: 844, height: 390 } } }); render();
  assert.equal(requests.size, requestsBeforeResize, 'Rotation reuses encoded artwork instead of downloading it again');
  resolveJob(jobs.at(-1)); await settle(); finishFade();
  render({ uri: 'https://art/broken' }); requests.get(props.uri).reject(new Error('offline')); await settle();
  assert.equal(frames[0].active, false);
  assert.ok(transitions.some(t => t.to === 0));
  render({ uri: '' }); assert.equal(frames[0].active, false);
  slots.forEach(slot => slot?.cleanup?.());
  assert.equal(listeners.size, 0);
  assert.equal(frames[0].active, false);
}

(async () => {
  await checkPixels();
  await checkLifecycle();
  console.log('Kawarp checks passed: real SkSL rendering, artwork colors/crossfades, contrast, resolution/frame bounds, loading races, failures and lifecycle suspension.');
})().catch(error => { console.error(error); process.exitCode = 1; });
