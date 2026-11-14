/* global __dirname */
// Actual current production Skia paragraphs/glyph paint; isolated voice, not UIKit.
// node native/lyrics-renderer/evidence/parity-capture.cjs [OUTPUT_DIRECTORY]
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../../..');
const app = path.join(root, 'ExpoLyrics');
const appRequire = createRequire(path.join(app, 'package.json'));
const { build } = appRequire('esbuild');
const native = path.join(app, 'components/lyrics/native');
const out = path.resolve(process.argv[2] || '/tmp/rust-parity-capture');
const hash = data => createHash('sha256').update(data).digest('hex');
const sourceFiles = new Set();
const boundaries = /^react\/|(react|react-native|react-native-reanimated|react-native-worklets|@shopify\/react-native-skia)$|lyrics-arrival-|native-clock-diagnostics|native-shared-blur|native-lyrics-fonts/;
async function bundle(filename, extra = '') {
  const result = await build({ stdin: { contents: fs.readFileSync(filename, 'utf8') + extra,
    resolveDir: path.dirname(filename), sourcefile: filename, loader: 'tsx' }, absWorkingDir: app,
    bundle: true, platform: 'node', format: 'cjs', write: false, metafile: true,
    plugins: [{ name: 'host-boundaries', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => boundaries.test(args.path) ? { path: args.path, external: true } : undefined);
    } }], tsconfig: path.join(app, 'tsconfig.json') });
  sourceFiles.add(filename);
  for (const name of Object.keys(result.metafile.inputs)) {
    const resolved = path.resolve(app, name);
    if (fs.existsSync(resolved)) sourceFiles.add(resolved);
  }
  return result.outputFiles[0].text;
}
async function main() {
  fs.mkdirSync(out, { recursive: true });
  const ck = await appRequire('canvaskit-wasm')({ locateFile: file => path.join(path.dirname(appRequire.resolve('canvaskit-wasm')), file) });
  const installed = path.dirname(appRequire.resolve('@shopify/react-native-skia/package.json'));
  const web = path.join(installed, 'lib/commonjs/skia/web');
  const Skia = appRequire(path.join(web, 'JsiSkia')).JsiSkApi(ck);
  const { JsiSkFont } = appRequire(path.join(web, 'JsiSkFont'));
  const { JsiSkParagraph } = appRequire(path.join(web, 'JsiSkParagraph'));
  // CanvasKit lacks native extendedVisit; adapt actual shaped glyphs and faces.
  // This is the sole paragraph API adapter, following the existing repo harness.
  const resources = [];
  const fallbackFamilies = new Set();
  JsiSkParagraph.prototype.extendedVisit = function(visitor) {
    this.ref.getShapedLines().forEach((line, index) => line.runs.forEach(run => {
      const font = new ck.Font(run.typeface, run.size);
      resources.push(font);
      fallbackFamilies.add(run.typeface.getFamilyName());
      assert.ok(Array.from(run.glyphs).every(glyph => glyph !== 0), 'Skia capture must contain no missing glyphs');
      const bounds = font.getGlyphBounds(run.glyphs);
      visitor(index, { glyphs: Array.from(run.glyphs), origin: { x: 0, y: 0 },
        positions: Array.from(run.glyphs, (_, i) => ({ x: run.positions[i * 2], y: run.positions[i * 2 + 1] })),
        bounds: Array.from(run.glyphs, (_, i) => Skia.XYWHRect(bounds[i * 4], bounds[i * 4 + 1], bounds[i * 4 + 2] - bounds[i * 4], bounds[i * 4 + 3] - bounds[i * 4 + 1])),
        font: new JsiSkFont(ck, font) });
    }));
  };
  // Normalize arrays crossing VM realms; Skia's web bindings use instanceof.
  const gradient = Skia.Shader.MakeLinearGradient.bind(Skia.Shader);
  Skia.Shader.MakeLinearGradient = (a, b, colors, ...rest) => gradient(a, b, Array.from(colors), ...rest);
  const matrix = Skia.ColorFilter.MakeMatrix.bind(Skia.ColorFilter);
  Skia.ColorFilter.MakeMatrix = values => matrix(Array.from(values));
  const { JsiSkCanvas } = appRequire(path.join(web, 'JsiSkCanvas'));
  const drawGlyphs = JsiSkCanvas.prototype.drawGlyphs;
  JsiSkCanvas.prototype.drawGlyphs = function(ids, positions, ...rest) { return drawGlyphs.call(this, Array.from(ids), Array.from(positions), ...rest); };
  const provider = Skia.TypefaceFontProvider.Make();
  const fontPaths = ['assets/fonts/SF-Pro-Display-Regular.otf', 'assets/fonts/SF-Pro-Display-Bold.otf'].map(p => path.join(app, p));
  // Explicit Linux fallback appended at the paragraph API boundary.
  // It is NOT iOS system cascade certification.
  const fallback = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc';
  fontPaths.push(fallback);
  for (const file of fontPaths) provider.ref.registerFont(fs.readFileSync(file), file === fallback ? 'Parity Linux CJK' : 'SF Pro Display');
  const makeParagraph = Skia.ParagraphBuilder.Make.bind(Skia.ParagraphBuilder);
  Skia.ParagraphBuilder.Make = (style, fonts) => makeParagraph({ ...style,
    textStyle: { ...style.textStyle, fontFamilies: [...style.textStyle.fontFamilies, 'Parity Linux CJK'] },
    ...(style.strutStyle ? { strutStyle: { ...style.strutStyle, fontFamilies: [...style.strutStyle.fontFamilies, 'Parity Linux CJK'] } } : {}) }, fonts);
  const fontContext = { fonts: true };
  let width = 0, captured;
  const React = { ...appRequire('react'), useContext: context => context === fontContext ? provider : true,
    useState: () => [width, () => {}], useRef: value => ({ current: value }),
    useMemo: fn => { const value = fn(); if (value?.glyphWords) captured = value; return value; },
    useEffect: () => {}, useCallback: fn => fn };
  const shared = value => ({ value });
  const reanimated = { default: { View: 'AnimatedView' }, useSharedValue: shared,
    useDerivedValue: fn => shared(fn()), useAnimatedReaction: () => {}, useAnimatedStyle: fn => fn(),
    Easing: { bezier: () => x => x }, withTiming: x => x };
  const createPicture = (draw, bounds) => {
    const recorder = Skia.PictureRecorder();
    draw(recorder.beginRecording(bounds));
    return recorder.finishRecordingAsPicture();
  };
  const types = path.join(web, '../types');
  const skiaExports = { Skia, createPicture, TextAlign: appRequire(path.join(types, 'Paragraph/ParagraphStyle')).TextAlign,
    BlendMode: appRequire(path.join(types, 'Paint/BlendMode')).BlendMode,
    ClipOp: appRequire(path.join(types, 'Canvas')).ClipOp,
    TileMode: appRequire(path.join(types, 'ImageFilter/ImageFilter')).TileMode };
  async function load(filename, extra) {
    const compiled = await bundle(filename, extra);
    const module = { exports: {} };
    vm.runInNewContext(compiled, { Float32Array, __DEV__: false, module, exports: module.exports,
      require: name => {
        if (name === 'react') return React;
        if (name.startsWith('react/')) return appRequire(name);
        if (name === 'react-native') return { StyleSheet: { create: x => x, absoluteFill: {} } };
        if (name === '@shopify/react-native-skia') return skiaExports;
        if (name === 'react-native-reanimated') return reanimated;
        if (/native-lyrics-fonts/.test(name)) return { NativeLyricsFontContext: fontContext };
        if (/lyrics-arrival-context/.test(name)) return { useArrivalVoice: () => ({}), useArrivalShapeAttribution: () => {} };
        if (/lyrics-arrival-|native-clock-diagnostics|native-shared-blur|^react-native-worklets$/.test(name)) return {};
        throw new Error(`Unexpected harness external: ${name}`);
      } });
    return module.exports;
  }
  const glyph = await load(path.join(native, 'native-glyph-picture.tsx'), '\nexport { drawVoice, advanceReferenceWordMotion, initialWordSpringState, advanceAmllFloatClock };');
  const voiceComponent = (await load(path.join(native, 'native-skia-voice.tsx'))).NativeSkiaVoice.type;
  const model = await load(path.join(native, 'native-lyrics-model.ts'));
  const fixturePath = path.join(root, 'DesktopBridge/test/fixtures/lrc-red/ZZA0P2622376.ttml');
  const { lyrics } = appRequire('./lib/lyrics-ttml-import').parseTtmlToLyrics(fs.readFileSync(fixturePath, 'utf8'));
  const { buildRustTrack } = appRequire('./lib/rust-lyrics-protocol');
  const records = [];
  sourceFiles.add(appRequire.resolve('./lib/lyrics-ttml-import'));
  sourceFiles.add(appRequire.resolve('./lib/rust-lyrics-protocol'));
  const cases = [{ id: 'korean', index: 1 }, { id: 'latin', index: lyrics.findIndex(l => l.syllables.every(s => /^[\x00-\x7f]*$/.test(s.text))) }];
  for (const item of cases) {
    assert.ok(item.index >= 0);
    const line = lyrics[item.index];
    const time = line.lineStartTime + (line.lineEndTime - line.lineStartTime) * 0.47;
    const packet = buildRustTrack('ZZA0P2622376', 1, [line]);
    const packetFile = path.join(out, item.id + '-track.json');
    fs.writeFileSync(packetFile, packet + '\n');
    for (const [vw, vh, dpr] of [[390, 640, 1], [844, 390, 1], [390, 640, 3]]) {
      const key = `${item.id}-${vw}x${vh}-${dpr}x`;
      const rustPng = path.join(out, `${key}-rust.png`);
      const rustLog = execFileSync(path.join(root, 'native/lyrics-renderer/target/debug/examples/parity-capture'),
        [packetFile, String(vw * dpr), String(vh * dpr), String(dpr), String(time), rustPng],
        { encoding: 'utf8', env: { ...process.env, XDG_RUNTIME_DIR: '/tmp', WGPU_BACKEND: 'vulkan' } });
      fs.writeFileSync(path.join(out, `${key}-rust.log`), rustLog);
      for (const style of ['spicy', 'amll']) {
        const spicy = style === 'spicy', landscape = vw > vh;
        const fontSize = spicy ? 32 * 1.05 : landscape ? 32 : 36;
        const lineHeight = spicy ? 42 * 1.05 : fontSize * 1.2;
        // Isolated semantic lane: these explicit host coordinates are NOT Yoga output.
        // Width/padding are declared so the next native reference can replace them.
        width = vw - 56;
        captured = null;
        fallbackFamilies.clear();
        const voice = model.buildNativeVoice(line.syllables, line.lineStartTime, line.lineEndTime, style);
        voiceComponent({ voice, position: shared(time), fontSize, lineHeight, right: false, background: false,
          staticLyrics: false, blur: shared(0), lineActive: shared(true), lineMotion: shared({ bright: 0.85, dark: 0.5, scale: 1 }),
          spicy, showTranslation: false, hasDuet: false, batched: true });
        assert.ok(captured?.glyphWords.length, 'actual component must shape glyphs');
        let springs = captured.glyphWords.map(w => glyph.initialWordSpringState(w.word));
        let clock = { active: false, releasePosition: -1, elapsed: 0 }, motions;
        const history = [];
        const start = line.lineStartTime - 1000;
        const frames = Math.ceil((time - start) / (1000 / 120));
        for (let frame = 0; frame <= frames; frame++) {
          const t = Math.min(time, start + frame * 1000 / 120), dt = frame === 0 ? 0 : (t - history.at(-1)) / 1000;
          const active = t >= line.lineStartTime && t < line.lineEndTime;
          const next = captured.glyphWords.map((word, i) => glyph.advanceReferenceWordMotion(word.word, springs[i], t, dt));
          springs = next.map(n => n.state); motions = next.map(n => n.motion);
          clock = glyph.advanceAmllFloatClock(clock, active, t, dt * 1000);
          history.push(t);
        }
        const surface = Skia.Surface.Make(vw * dpr, vh * dpr), canvas = surface.getCanvas();
        canvas.clear(Skia.Color('transparent')); canvas.scale(dpr, dpr); canvas.translate(28, vh * 0.37);
        glyph.drawVoice(canvas, captured.glyphWords, motions, time, true, spicy, false, fontSize, line.lineEndTime,
          { bright: 0.85, dark: 0.5 }, clock, { paint: Skia.Paint(), glowPaint: Skia.Paint(), blurRadii: [], blurFilters: [], revealShaders: [] });
        const image = surface.makeImageSnapshot();
        const skiaPng = path.join(out, `${key}-${style}-skia.png`);
        fs.writeFileSync(skiaPng, image.encodeToBytes()); image.dispose(); surface.dispose();
        records.push({ id: `${key}-${style}`, style, viewport: { width: vw, height: vh, dpr }, fixtureLine: item.index,
          time_ms: time, inputPacket: packetFile, inputPacketSha256: hash(packet),
          originalSyllables: line.syllables, skiaVoice: JSON.parse(JSON.stringify(voice)),
          skiaGeometry: { laneWidth: width, textWidth: spicy ? width : width - fontSize * 0.4, fontSize, lineHeight,
            paragraphHeight: captured.height, x: 28, y: vh * 0.37, effectiveFamilies: [...fallbackFamilies] },
          rustGeometry: { laneWidth: landscape ? vw * 0.67 : vw - 64, fontSize: 34, lineHeight: 34 * 1.35,
            x: landscape ? vw * 0.165 : 32, y: vh * 0.37, fontFamily: 'Noto Sans CJK KR', weight: 800 },
          history_ms: history, settings: { fontScale: 1, translation: false, romanization: false, background: false,
            active: true, right: false, duet: false, nativeSharedBlur: 'not exercised: protected isolated voice' },
          pngs: { skia: skiaPng, rust: rustPng } });
      }
    }
  }
  for (const file of ['JsiSkia', 'JsiSkParagraph', 'JsiSkFont', 'JsiSkCanvas', 'JsiSkParagraphBuilder', 'JsiSkParagraphBuilderFactory']) {
    const p = path.join(web, file + '.js'); if (fs.existsSync(p)) sourceFiles.add(p);
  }
  sourceFiles.add(__filename);
  sourceFiles.add(path.join(root, 'native/lyrics-renderer/examples/parity-capture.rs'));
  sourceFiles.add(fixturePath);
  const wasm = path.join(path.dirname(appRequire.resolve('canvaskit-wasm')), 'canvaskit.wasm');
  sourceFiles.add(wasm);
  sourceFiles.add(appRequire.resolve('canvaskit-wasm'));
  for (const file of Object.keys(require.cache)) if (file.startsWith(installed + path.sep)) sourceFiles.add(file);
  for (const file of fs.readdirSync(path.join(root, 'native/lyrics-renderer/src'))) sourceFiles.add(path.join(root, 'native/lyrics-renderer/src', file));
  for (const file of ['Cargo.toml', 'Cargo.lock']) sourceFiles.add(path.join(root, 'native/lyrics-renderer', file));
  for (const pkg of ['@shopify/react-native-skia', 'canvaskit-wasm', 'esbuild', 'unicode-segmenter']) sourceFiles.add(appRequire.resolve(pkg + '/package.json'));
  const manifest = { schema: 1, baseline: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    scope: 'Actual current Skia NativeSkiaVoice preparation + drawVoice via CanvasKit vs unchanged Rust isolated voice. NOT full native screen parity.',
    limitations: ['React hooks/state/clock sampled in Node; no Yoga/UI thread/UIKit material blur',
      'Skia paragraph adapter appends explicit Parity Linux CJK family (TTC first face); not iOS cascade',
      'Rust baseline has no style support and is intentionally identical in both style comparisons',
      'Same source syllables/times; each production model retains its own text/spacing transformation',
      'Isolated host-selected lane origin and width, no claim of native measured layout or touch proof',
      'AMLL line-motion sampled at declared bright/dark/scale; outer row/view opacity and transforms excluded for both styles'],
    node: process.version, packages: Object.fromEntries(['@shopify/react-native-skia', 'canvaskit-wasm', 'esbuild', 'unicode-segmenter'].map(name => [name, appRequire(name + '/package.json').version])),
    sources: [...sourceFiles].sort().map(file => ({ path: file, sha256: hash(fs.readFileSync(file)) })),
    fonts: fontPaths.map(file => ({ path: file, sha256: hash(fs.readFileSync(file)) })),
    rustHostFonts: { note: 'System font candidates, not a per-glyph face attestation. Parley selects KR family/weight800; capture reports missing glyphs.',
      files: ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc'].map(file => ({ path: file, sha256: hash(fs.readFileSync(file)) })) }, records };
  for (const record of records) record.pngHashes = Object.fromEntries(Object.entries(record.pngs).map(([name, p]) => [name, hash(fs.readFileSync(p))]));
  fs.writeFileSync(path.join(out, 'capture-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ captures: records.length, manifest: path.join(out, 'capture-manifest.json') }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
