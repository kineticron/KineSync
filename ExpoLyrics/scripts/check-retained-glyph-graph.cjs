/* global __dirname */
// Unaccepted retained-graph experiment. Real CanvasKit, NOT native iOS.
// node scripts/check-retained-glyph-graph.cjs --font Devanagari.ttf --rtl-font Arabic.ttf --emoji-font NotoColorEmoji.ttf --out /tmp/retained
// Add --require-exact for the exact-fidelity gate (currently expected to fail).
// Add --benchmark for bounded app-expression counts and host callback timing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Buffer } = require('node:buffer');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { buildSync } = require('esbuild');
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function main() {
  assert.ok(process.argv.includes('--font') && process.argv.includes('--rtl-font'), 'Supply real --font Devanagari.ttf and --rtl-font Arabic.ttf');
  const out = process.argv.includes('--out') ? arg('--out') : '/tmp/kinesync-shirorekha';
  fs.mkdirSync(out, { recursive: true });
  const ck = await require('canvaskit-wasm')({ locateFile: f => path.join(path.dirname(require.resolve('canvaskit-wasm')), f) });
  const web = path.join(path.dirname(require.resolve('@shopify/react-native-skia/package.json')), 'lib/commonjs/skia/web');
  const types = path.join(web, '../types');
  const { BlendMode } = require(path.join(types, 'Paint/BlendMode'));
  const { ClipOp } = require(path.join(types, 'Canvas'));
  const { TileMode } = require(path.join(types, 'ImageFilter/ImageFilter'));
  const Skia = require(path.join(web, 'JsiSkia')).JsiSkApi(ck);
  // CanvasKit uses instanceof Array; normalize only JS arrays crossing VM realms.
  const linearGradient = Skia.Shader.MakeLinearGradient.bind(Skia.Shader);
  Skia.Shader.MakeLinearGradient = (a, b, colors, ...rest) => linearGradient(a, b, Array.from(colors), ...rest);
  const makeMatrix = Skia.ColorFilter.MakeMatrix.bind(Skia.ColorFilter);
  Skia.ColorFilter.MakeMatrix = values => makeMatrix(Array.from(values));
  const { JsiSkCanvas } = require(path.join(web, 'JsiSkCanvas'));
  const drawGlyphs = JsiSkCanvas.prototype.drawGlyphs;
  JsiSkCanvas.prototype.drawGlyphs = function(ids, positions, ...rest) { return drawGlyphs.call(this, Array.from(ids), Array.from(positions), ...rest); };
  const { JsiSkFont } = require(path.join(web, 'JsiSkFont'));
  const createPicture = draw => { const recorder = Skia.PictureRecorder(); draw(recorder.beginRecording(Skia.XYWHRect(-64, -64, 900, 350))); return recorder.finishRecordingAsPicture(); };
  const directory = path.join(__dirname, '../components/lyrics/native');
  const filename = path.join(directory, 'retained-glyph-graph.tsx');
  const source = fs.readFileSync(filename, 'utf8');
  const React = require('react');
  const makeMutable = value => ({ value, _isReanimatedSharedValue: true, modify(fn) { this.value = fn(this.value); } });
  let renderer;
  const skiaExports = { Skia, createPicture, BlendMode, ClipOp, TileMode };
  function load(contents, mocks = {}, instrument = false) {
    let code = buildSync({ stdin: { contents: contents, resolveDir: directory, loader: 'tsx' }, bundle: true,
      platform: 'node', format: 'cjs', write: false, external: ['react', 'react-native-reanimated', 'react-native-worklets', '@shopify/react-native-skia'] }).outputFiles[0].text;
    if (instrument) code = require('@babel/core').transformSync(code, { configFile: false, babelrc: false, plugins: [({ types: t }) => ({ visitor: {
      'ObjectExpression|ArrayExpression|RegExpLiteral|FunctionExpression|ArrowFunctionExpression': { exit(p) { const kind = p.isArrayExpression() ? 'arrays' : p.isRegExpLiteral() ? 'regexps' : p.isFunctionExpression() || p.isArrowFunctionExpression() ? 'functions' : 'objects'; p.replaceWith(t.callExpression(t.identifier('__alloc'), [t.stringLiteral(kind), p.node])); p.skip(); } },
      CallExpression: { exit(p) { const c=p.node.callee; if (t.isMemberExpression(c) && !c.computed && ['map','filter','flat','flatMap','slice','concat','from'].includes(c.property.name)) { p.replaceWith(t.callExpression(t.identifier('__alloc'), [t.stringLiteral('arrayResults'), p.node])); p.skip(); } } }
    } })] }).code;
    const module = { exports: {} };
    vm.runInNewContext(code, { Float32Array, performance: require('node:perf_hooks').performance, __DEV__: false, __alloc: mocks.allocate, module, exports: module.exports, require: name => name === 'react' ? mocks.react ?? React : name === '@shopify/react-native-skia' ? { ...skiaExports, ...mocks.skia } : name === 'react-native-reanimated' ? { makeMutable, ...mocks.reanimated } : {} });
    return module.exports;
  }
  const installed = path.dirname(require.resolve('@shopify/react-native-skia/package.json'));
  const entries = { visit: 'sksg/Recorder/Visitor', Recorder: 'sksg/Recorder/Recorder', replay: 'sksg/Recorder/Player', createDrawingContext: 'sksg/Recorder/DrawingContext', Group: 'renderer/components/Group', Blur: 'renderer/components/imageFilters/Blur', ColorMatrix: 'renderer/components/colorFilters/Matrix', Fill: 'renderer/components/shapes/Fill', Glyphs: 'renderer/components/text/Glyphs', LinearGradient: 'renderer/components/shaders/LinearGradient', Paint: 'renderer/components/Paint', Path: 'renderer/components/shapes/Path', Picture: 'renderer/components/Picture' };
  renderer = load(Object.entries(entries).map(([name, file]) => `export {${name}} from ${JSON.stringify(path.join(installed, 'src', file))};`).join('\n'));
  for (const name of Object.keys(entries)) if (!['visit', 'Recorder', 'replay', 'createDrawingContext'].includes(name)) skiaExports[name] = renderer[name];
  const api = load(source);
  const original = execFileSync('git', ['show', '5e76f08:ExpoLyrics/components/lyrics/native/native-glyph-picture.tsx'], { encoding: 'utf8' });
  assert.equal(hash(original), '30e8071e41466af439c5f74824386a50bacdd272648fc23d40b91968588089c8');
  const baseline = load(original + '\nexport { drawVoice, advanceReferenceWordMotion, initialWordSpringState, advanceAmllFloatClock, amllEmphasis, amllFloat, amllWordFloatPosition };');
  const fonts = { indic: fs.readFileSync(arg('--font')), arabic: fs.readFileSync(arg('--rtl-font')),
    latin: fs.readFileSync(path.join(__dirname, '../assets/fonts/SF-Pro-Display-Bold.otf')),
    ...(process.argv.includes('--emoji-font') ? { emoji: fs.readFileSync(arg('--emoji-font')) } : {}) };
  const resources = [];
  const rect = r => Skia.XYWHRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
  function fixture(text, fontName, parts, rtl = false, fallbackName, width = 650) {
    const data = fonts[fontName], provider = ck.TypefaceFontProvider.Make(); provider.registerFont(data, 'Diagnostic');
    const typeface = ck.Typeface.MakeTypefaceFromData(data);
    const fallback = fallbackName && ck.Typeface.MakeTypefaceFromData(fonts[fallbackName]);
    if (fallback) { provider.registerFont(fonts[fallbackName], 'Diagnostic fallback'); resources.push(fallback); }
    for (const char of text.replace(/\s/g, '')) assert.ok(typeface.getGlyphIDs(char)[0] || fallback?.getGlyphIDs(char)[0], `${fontName} / fallback must contain ${char}`);
    const builder = ck.ParagraphBuilder.MakeFromFontProvider(new ck.ParagraphStyle({ textDirection: rtl ? ck.TextDirection.RTL : ck.TextDirection.LTR,
      textAlign: ck.TextAlign.Left, textStyle: { fontFamilies: fallback ? ['Diagnostic', 'Diagnostic fallback'] : ['Diagnostic'], fontSize: 64, color: ck.WHITE } }), provider);
    builder.addText(text); const paragraph = builder.build(); paragraph.layout(width);
    const range = (start, end) => paragraph.getRectsForRange(start, end, ck.RectHeightStyle.Tight, ck.RectWidthStyle.Tight).map(box => rect(box.rect));
    const runs = paragraph.getShapedLines().flatMap(line => line.runs.map(run => {
      const font = new ck.Font(run.typeface, run.size), bounds = font.getGlyphBounds(run.glyphs);
      resources.push(font);
      return { glyphs: Array.from(run.glyphs), origin: { x: 0, y: 0 }, positions: Array.from(run.glyphs, (_, i) => ({ x: run.positions[i * 2], y: run.positions[i * 2 + 1] })),
        bounds: Array.from(run.glyphs, (_, i) => rect(bounds.subarray(i * 4, i * 4 + 4))), font: new JsiSkFont(ck, font) };
    }));
    resources.push(paragraph, builder, typeface, provider);
    const input = parts.map(part => {
      const letters = part.letters ?? [part.text];
      const rects = range(part.offset, part.offset + part.text.length);
      let offset = part.offset;
      return { word: { start: 0, end: 2000, ...part, letters }, rects, letters: letters.map(letter => { const start = offset; offset += letter.length; return range(start, offset); }),
        width: rects.reduce((n, r) => n + r.width, 0), before: 0 };
    });
    return { input, runs, shape: (spicy, renderer = baseline) => renderer.shapeGlyphWords({ getLineMetrics: () => paragraph.getLineMetrics(), extendedVisit: visit => runs.forEach(run => visit(0, run)) }, input, spicy) };
  }
  const sourceHashes = Object.fromEntries(['retained-glyph-graph.tsx', 'retained-word-motion.ts', 'retained-amll-emphasis.ts', 'reference-word-motion.ts', 'reference-motion.ts', 'amll-float-clock.ts', 'native-glyph-layout.ts', 'spicy-text-policy.ts'].map(file => [file, hash(fs.readFileSync(path.join(directory,file)))]));
  sourceHashes['check-retained-glyph-graph.cjs'] = hash(fs.readFileSync(__filename));
  sourceHashes['retained-glyph-benchmark.cjs'] = hash(fs.readFileSync(path.join(__dirname,'retained-glyph-benchmark.cjs')));
  const provenance = { sourceHashes, baseline: hash(original), fonts: Object.fromEntries(Object.entries(fonts).map(([name,data])=>[name,hash(data)])), node:process.version,
    packages: Object.fromEntries(['@shopify/react-native-skia','react-native-reanimated','react-native-worklets','react','canvaskit-wasm'].map(name=>[name,require(name+'/package.json').version])), argv:process.argv.slice(2) };
  if (process.argv.includes('--benchmark')) {
    await require('./retained-glyph-benchmark.cjs')({ api, baseline, original, source, load, Skia, createPicture, fixture, out, provenance });
    return;
  }
  // Expansion uses installed Group's real layer handling; recording/playback
  // use installed Skia's actual visitor, command graph and CanvasKit canvas.
  function expand(element) {
    if (element == null || typeof element === 'boolean') return null;
    if (Array.isArray(element)) return element.flatMap(e => expand(e) ?? []);
    if (typeof element.type === 'function') return expand(element.type(element.props));
    const { children, ...props } = element.props;
    return { type: element.type, props, children: React.Children.toArray(children).flatMap(e => expand(e) ?? []) };
  }
  function record(words, state, spicy, clipMode) {
    const recorder = new renderer.Recorder();
    renderer.visit(recorder, [expand(React.createElement(api.RetainedGlyphGraph, { words, state, spicy, clipMode }))]);
    return recorder.getRecording();
  }
  function raster(draw, width, height, name) {
    const surface = Skia.Surface.Make(width + 128, height), canvas = surface.getCanvas();
    canvas.clear(Skia.Color('transparent')); canvas.translate(48.25, 64.125);
    draw(canvas);
    const image = surface.makeImageSnapshot();
    const pixels = image.ref.readPixels(0, 0, { width: width + 128, height, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB });
    const display = Skia.Surface.Make(width + 128, height), target = display.getCanvas();
    target.clear(Skia.Color('#161c28')); target.drawImage(image, 0, 0);
    const preview = display.makeImageSnapshot();
    fs.writeFileSync(path.join(out, name + '.png'), preview.encodeToBytes());
    preview.dispose(); display.dispose(); image.dispose(); surface.dispose();
    return pixels;
  }
  const results = [];
  // Include the real line wrap width in each paragraph, not merely crop/rotate.
  const data = [
    ['indic', 'देख लो', 'indic', [{ text: 'देख', offset: 0, end: 1000 }, { text: 'लो', offset: 4, start: 1000 }]],
    ['indic-emphasis', 'देख', 'indic', [{ text: 'देख', offset: 0, emphasized: true, letters: ['दे', 'ख'] }]],
    ['latin', 'office hello world', 'latin', [{ text: 'office', offset: 0, emphasized: true, letters: ['o','f','f','i','c','e'] }, { text: 'hello', offset: 7 }, { text: 'world', offset: 13 }]],
    ...(fonts.emoji ? [['emoji', 'hello 😀', 'latin', [{ text: 'hello', offset: 0 }, { text: '😀', offset: 6 }], false, 'emoji']] : []),
    ['rtl', 'لا', 'arabic', [{ text: 'لا', offset: 0, emphasized: true, letters: ['ل','ا'] }], true],
  ];
  for (const width of [260, 650]) for (const [label, text, font, parts, rtl, fallbackName] of data) {
    const f = fixture(text, font, parts, rtl, fallbackName, width);
    for (const spicy of [true, false]) for (const background of [false, true]) {
      const options = { spicy, background, fontSize: 64, lineEnd: 2000 }, words = f.shape(spicy);
      const state = api.createRetainedGlyphState(words), recordings = Object.fromEntries(['group','mask'].map(mode => [mode, record(words, state, spicy, mode)]));
      let springs = words.map(w => baseline.initialWordSpringState(w.word)), clock = { active: false, releasePosition: -1, elapsed: 0 };
      const paints = { paint: Skia.Paint(), glowPaint: Skia.Paint(), blurRadii: [], blurFilters: [], revealShaders: [] };
      const sequence = [ ['future', -100, false], ['attack', 0, true],
        ...Array.from({length:75},(_,i)=>[i===29?'reveal':i===53?'emphasis':i===74?'release':null, (i+1)*1000/60, i<74]),
        ...Array.from({length:30},(_,i)=>[i===29?'paused-release':null,1250,false]),
        ['forward-seek', 3000, false], ['backward-seek', 250, true] ];
      for (const [stage, time, active] of sequence) {
        const dt = 1/60, line = { bright: active ? 0.85 : 0.6, dark: active ? 0.5 : 0.35 };
        clock = baseline.advanceAmllFloatClock(clock, active, time, dt*1000);
        const next = words.map((w,i) => baseline.advanceReferenceWordMotion(w.word, springs[i], time, dt));
        springs = next.map(n => n.state);
        const motions = next.map(n => spicy ? n.motion : { scale: 1, y: 0, glow: 0, gradient: 0, letters: [] });
        api.updateRetainedGlyphState(state, words, time, active, dt, line, options);
        if (spicy) for (let i=0;i<words.length;i++) {
          assert.equal(JSON.stringify(state.words[i].motion), JSON.stringify(motions[i]), 'Every spring/letter/reveal equals reference, including seeks');
        }
        if (!spicy) for (let i=0;i<words.length;i++) {
          const word=words[i];
          assert.equal(baseline.amllFloat(baseline.amllWordFloatPosition(state.clock,time,word.word.start,word.word.end),word.word.start,word.word.end,background),
            baseline.amllFloat(baseline.amllWordFloatPosition(clock,time,word.word.start,word.word.end),word.word.start,word.word.end,background), 'AMLL float/release equals reference, including paused release and seeks');
          if(word.word.emphasized) for(let letter=0;letter<word.runs.length;letter++) {
            if(!word.letters[letter][0])continue;
            const expected=baseline.amllEmphasis(time,word.word.emphasis?.start??word.word.start,word.word.emphasis?.end??word.word.end,
              (word.word.emphasis?.index??0)+letter,word.word.emphasis?.count??word.word.letters.length,word.word.emphasis?.last??i===words.length-1,background);
            assert.equal(JSON.stringify(state.words[i].slices[letter].emphasis),JSON.stringify(expected),'AMLL sampled emphasis equations equal reference');
          }
        }
        if (!stage) continue;
        const prefix = `${width}-${label}-${spicy?'spicy':'amll'}-${background?'bg':'fg'}-${stage}`;
        const before = raster(c => baseline.drawVoice(c, words, motions, time, active, spicy, background, 64, 2000, line, clock, paints), width, 320, prefix + '-old');
        for (const mode of ['group','mask']) {
          const recording = recordings[mode];
          const after = raster(c => {
            // Installed JS player uses AA clips; the native C++ recorder omits
            // the AA argument. Emulate that boundary, not web-only parity.
            const clip = c.clipPath.bind(c);
            c.clipPath = (p, op) => clip(p, op, false);
            const ctx = renderer.createDrawingContext(Skia, recording.paintPool, c); renderer.replay(ctx, recording.commands); ctx.dispose(); }, width, 320, prefix + '-' + mode);
          let changed = 0, max = 0, sum = 0;
          for (let i=0;i<before.length;i+=4) { let pixel = false; for (let j=0;j<4;j++) { const d=Math.abs(before[i+j]-after[i+j]); max=Math.max(max,d);sum+=d;pixel ||= d>0; } if(pixel)changed++; }
          let visibleChanged = 0, visibleMax = 0, visibleSum = 0, alphaMax = 0;
          const bg = [22,28,40];
          for (let i=0;i<before.length;i+=4) {
            let pixel=false;
            alphaMax=Math.max(alphaMax,Math.abs(before[i+3]-after[i+3]));
            for(let j=0;j<3;j++) {
              const a=Math.round(before[i+j]*before[i+3]/255+bg[j]*(1-before[i+3]/255));
              const b=Math.round(after[i+j]*after[i+3]/255+bg[j]*(1-after[i+3]/255));
              const d=Math.abs(a-b);visibleMax=Math.max(visibleMax,d);visibleSum+=d;pixel ||= d>0;
            }
            if(pixel)visibleChanged++;
          }
          results.push({ prefix, mode, changedPixels: changed, maxChannelDelta: max, meanChannelDelta: sum/before.length,
            visibleChangedPixels:visibleChanged,maxVisibleChannelDelta:visibleMax,meanVisibleChannelDelta:visibleSum/(before.length/4*3),maxAlphaDelta:alphaMax });
        }
      }
      fs.writeFileSync(path.join(out, 'progress.json'), JSON.stringify({ complete: false, results }, null, 2));
      for (const recording of Object.values(recordings)) for (const p of recording.paintPool) p.dispose();
    }
  }
  fs.writeFileSync(path.join(out, 'raster-results.json'), JSON.stringify({ provenance, source: hash(source), baseline: hash(original), engine: 'CanvasKit ' + require('canvaskit-wasm/package.json').version, results },null,2));
  console.log(JSON.stringify({ cases: results.length, identical: results.filter(r=>r.changedPixels===0).length, worst: results.reduce((a,b)=>a.changedPixels>b.changedPixels?a:b) },null,2));
  if(process.argv.includes('--require-exact')) assert.equal(results.filter(r=>r.mode==='mask'&&(r.visibleChangedPixels!==0||r.maxAlphaDelta!==0)).length,0,'Exact retained candidate acceptance failed: nonzero alpha/composited pixel differences; production remains unchanged');
}
// All artifacts are written synchronously before an acceptance error. Exit the
// diagnostic CLI explicitly so library handles cannot keep a failed run alive.
main().catch(error => { console.error(error); process.exit(1); });
