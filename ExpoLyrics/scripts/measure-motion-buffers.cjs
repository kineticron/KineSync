/* global __dirname, __filename */
// Reuses CanvasKit/font fixture and literal-allocation instrumentation techniques
// from the retained investigation. No retained renderer is loaded or benchmarked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { buildSync } = require('esbuild');
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const stats = values => { const s = [...values].sort((a,b) => a-b); return { n:s.length, mean:s.reduce((a,b)=>a+b,0)/s.length, p50:s[Math.ceil(s.length*.5)-1], p95:s[Math.ceil(s.length*.95)-1], p99:s[Math.ceil(s.length*.99)-1] }; };
async function main() {
  const out = arg('--out'); fs.mkdirSync(out, { recursive:true });
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
  const React = require('react');
  const makeMutable = value => ({ value, modify(fn) { this.value = fn(this.value); } });
  const skiaExports = { Skia, createPicture, BlendMode, ClipOp, TileMode };
  function load(contents, mocks = {}, instrument = false) {
    let code = buildSync({ stdin: { contents: contents, resolveDir: directory, loader: 'tsx' }, bundle: true,
      platform: 'node', format: 'cjs', write: false, external: ['react-native', 'react', 'react-native-reanimated', 'react-native-worklets', '@shopify/react-native-skia'] }).outputFiles[0].text;
    if (mocks.timing) code = require('@babel/core').transformSync(code, { configFile:false, babelrc:false, plugins:[({types:t})=>({visitor:{
      FunctionDeclaration(p) {
        if(p.node.id?.name !== 'amllEmphasis') return;
        const body=p.node.body.body;
        p.node.body.body=[t.variableDeclaration('const',[t.variableDeclarator(t.identifier('__emphasisStarted'),t.callExpression(t.memberExpression(t.identifier('performance'),t.identifier('now')),[]))]),
          t.tryStatement(t.blockStatement(body),null,t.blockStatement([t.expressionStatement(t.callExpression(t.identifier('__emphasisElapsed'),[t.binaryExpression('-',t.callExpression(t.memberExpression(t.identifier('performance'),t.identifier('now')),[]),t.identifier('__emphasisStarted'))]))]))];
      }
    }})] }).code;
    if (instrument) code = require('@babel/core').transformSync(code, { configFile: false, babelrc: false, plugins: [({ types: t }) => ({ visitor: {
      'ObjectExpression|ArrayExpression|RegExpLiteral|FunctionExpression|ArrowFunctionExpression': { exit(p) { const kind = p.isArrayExpression() ? 'arrays' : p.isRegExpLiteral() ? 'regexps' : p.isFunctionExpression() || p.isArrowFunctionExpression() ? 'functions' : 'objects'; p.replaceWith(t.callExpression(t.identifier('__alloc'), [t.stringLiteral(kind), p.node])); p.skip(); } },
      CallExpression: { exit(p) { const c=p.node.callee; if (t.isMemberExpression(c) && !c.computed && ['map','filter','flat','flatMap','slice','concat','from'].includes(c.property.name)) { p.replaceWith(t.callExpression(t.identifier('__alloc'), [t.stringLiteral('arrayResults'), p.node])); p.skip(); } } }
    } })] }).code;
    const module = { exports: {} };
    vm.runInNewContext(code, { Float32Array, performance: require('node:perf_hooks').performance, __DEV__: false, __alloc: mocks.allocate, __motionStart: mocks.motionStart, __motionEnd: mocks.motionEnd, __emphasisElapsed: mocks.emphasisElapsed, module, exports: module.exports, require: name => name === 'react' ? mocks.react ?? React : name === '@shopify/react-native-skia' ? { ...skiaExports, ...mocks.skia } : name === 'react-native' ? { Platform: { OS: 'ios' } } : name === 'react-native-reanimated' ? { makeMutable, ...mocks.reanimated } : {} });
    return module.exports;
  }
  const original = execFileSync('git', ['show', '5e76f08:ExpoLyrics/components/lyrics/native/native-glyph-picture.tsx'], { encoding:'utf8' });
  const current = fs.readFileSync(path.join(directory, 'native-glyph-picture.tsx'), 'utf8');
  const baseline = load(original);
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
  const provenance = { argv:process.argv.slice(2), host:require('node:os').hostname(), node:process.version,
    baseline:hash(original), sources:Object.fromEntries(['native-glyph-picture.tsx','motion-buffers.ts','reference-word-motion.ts','reference-motion.ts','amll-float-clock.ts'].map(f=>[f,hash(fs.readFileSync(path.join(directory,f)))])),
    harness:hash(fs.readFileSync(__filename)), fonts:Object.fromEntries(Object.entries(fonts).map(([k,v])=>[k,hash(v)])),
    packages:Object.fromEntries(['canvaskit-wasm','@shopify/react-native-skia','react-native-reanimated'].map(n=>[n,require(n+'/package.json').version])) };
  const replay = Array.from({length:1000},(_,frame)=> { const s=frame%250; return {time:s<180?s*1000/60:s<210?2000:s<230?7000:250+(s-230)*1000/60, active:s<180||s>=230, dt:1000/60}; });
  function mount(variant, words, options, instrument=false, timing=false) {
    const frames=[],cleanups=[],shared=[];
    const counts={arrays:0,objects:0,arrayResults:0,regexps:0,functions:0, pictureBuilds:0, notifications:0};
    let picture, motion=0, record=0, emphasis=0, motionStarted=0;
    const cell = initial => { let v=initial; const c={get value(){return v;},set value(next){if(v!==next)counts.notifications++;v=next;}, modify(fn,force=true){const next=fn(v);if(force||v!==next)counts.notifications++;v=next;} };shared.push(c);return c; };
    const react={memo:f=>f,useMemo:f=>f(),useCallback:f=>f,useEffect:f=>cleanups.push(f()),createElement:(_t,p)=>p};
    let contents = variant === 'off' ? original : current;
    if(timing) contents=contents.replaceAll('    const dt =', '    __motionStart();\n    const dt =').replaceAll('    const cachedPaints =','    __motionEnd();\n    const cachedPaints =');
    contents += '\nexport { NativeGlyphPictureProduction, NativeGlyphPictureBuffered };';
    if(variant==='off') contents=contents.replace('export { NativeGlyphPictureProduction, NativeGlyphPictureBuffered };','export { NativeGlyphPictureProduction };');
    const api=load(contents,{react,reanimated:{useSharedValue:cell,useFrameCallback:f=> {const frame={fn:f,active:false};frames.push(frame);return {setActive:v=>{frame.active=v;}};}},
      skia:{createPicture(draw,bounds){const t=performance.now();const rec=Skia.PictureRecorder();draw(rec.beginRecording(bounds));const next=rec.finishRecordingAsPicture();rec.dispose();picture?.dispose();picture=next;counts.pictureBuilds++;record+=performance.now()-t;return next;}},
      allocate(kind,v){if(kind!=='arrayResults'||Array.isArray(v))counts[kind]++;return v;},
      timing, emphasisElapsed(ms){emphasis+=ms;}, motionStart(){motionStarted=performance.now();},motionEnd(){motion+=performance.now()-motionStarted;}
    },instrument);
    const position=cell(0),active=cell(false),lineMotion=cell({scale:1,velocity:0,bright:.85,dark:.5});
    const output=api[variant==='off'?'NativeGlyphPictureProduction':'NativeGlyphPictureBuffered']({words,position,active,lineMotion,width:options.width??650,height:320,...options});
    return {output,counts,shared,tick(s){position.value=s.time;active.value=s.active;motion=record=emphasis=0;const t=performance.now();for(const f of frames)if(f.active)f.fn({timeSincePreviousFrame:s.dt});return {callback:performance.now()-t,motion:motion+emphasis,record:record-emphasis};},
      unmount(){cleanups.forEach(f=>f?.());picture?.dispose();for(const c of shared){if(c.value?.paint){c.value.paint.dispose();c.value.glowPaint.dispose();}}}};
  }
  const latin=fixture('office hello world','latin',[
    {text:'office',offset:0,end:1000,emphasized:true,letters:['o','f','f','i','c','e']},
    {text:'hello',offset:7,start:1000,end:2000},{text:'world',offset:13,start:2000,end:3000}]);
  const callback=[];
  if(!process.argv.includes('--raster-only')) {
    // Three alternating passes; each instance receives the same warmup/replay.
    for(const spicy of [true,false]) for(const background of [false,true]) {
      const words=latin.shape(spicy),options={spicy,background,fontSize:64,lineEnd:3000};
      const samples={off:[],on:[]},stages={off:[],on:[]},allocations={};
      for(let pass=0;pass<3;pass++)for(const variant of pass%2?['on','off']:['off','on']) {
        const m=mount(variant,words,options);for(const s of replay.slice(0,100))m.tick(s);
        for(const s of replay)samples[variant].push(m.tick(s).callback);m.unmount();
      }
      for(const variant of ['off','on']) {
        const m=mount(variant,words,options,false,true);for(const s of replay.slice(0,100))m.tick(s);
        for(const s of replay)stages[variant].push(m.tick(s));m.unmount();
        const a=mount(variant,words,options,true);for(const s of replay.slice(0,100))a.tick(s);const before={...a.counts};
        for(const s of replay)a.tick(s);allocations[variant]=Object.fromEntries(Object.keys(before).map(k=>[k,a.counts[k]-before[k]]));a.unmount();
        callback.push({style:spicy?'spicy':'amll',background,variant,callbackMs:stats(samples[variant]),
          motionAndBookkeepingMs:stats(stages[variant].map(s=>s.motion)),pictureRecordingMs:stats(stages[variant].map(s=>s.record)),allocations:allocations[variant]});
      }
    }
    fs.writeFileSync(path.join(out,'callback.json'),JSON.stringify({provenance,replay,scope:'Node/V8 simulation of UI-runtime callback; actual CanvasKit nested recording. Stage timings separately instrumented; OFF AMLL emphasis timed inside drawVoice and subtracted from recording; ON emphasis timed before recording. Instrumented stage timings include clock/scans/mutable-access bookkeeping and timer overhead. No RN JS/device thread timing.',callback},null,2));
    // Same complete pipeline as ui-thread: callback -> parent drawPicture recording -> CPU raster/flush.
    const pipeline=[];
    for(const spicy of [true,false])for(const [phase,index] of [['reveal',30],['emphasis',54]])for(const variant of ['off','on']) {
      const m=mount(variant,latin.shape(spicy),{spicy,background:false,fontSize:64,lineEnd:3000});
      for(const s of replay.slice(0,index))m.tick(s);
      const surface=Skia.Surface.Make(778,320),canvas=surface.getCanvas(),samples=[];
      for(let trial=0;trial<10;trial++) {
        const t=performance.now();const tick=m.tick(replay[index+trial]);const updated=performance.now();
        const r=Skia.PictureRecorder(),c=r.beginRecording(Skia.XYWHRect(0,0,778,320));c.translate(48.25,64.125);c.drawPicture(m.output.picture.value);
        const p=r.finishRecordingAsPicture(),recorded=performance.now();canvas.clear(Skia.Color('transparent'));canvas.drawPicture(p);surface.flush();const end=performance.now();
        if(trial>=2)samples.push({callbackMs:tick.callback,parentRecordMs:recorded-updated,rasterFlushMs:end-recorded,totalMs:end-t});p.dispose();r.dispose();
      }
      surface.dispose();m.unmount();pipeline.push({style:spicy?'spicy':'amll',phase,variant,samples});
    }
    fs.writeFileSync(path.join(out,'pipeline.json'),JSON.stringify({provenance,pipeline,scope:'Host CPU CanvasKit full pipeline, no native C++ replay or phone GPU; 8 samples/phase/path after 2 warmups. Small diagnostic sample, tails not stable.'},null,2));
  }
  if(process.argv.includes('--timing-only')) return;
  // Full-stage actual-component raster matrix, both styles/roles, narrow/landscape,
  // real Indic overlap, ligatures, contextual RTL and emoji fallback.
  const data=[
    ['indic','देख लो','indic',[{text:'देख',offset:0,end:1000},{text:'लो',offset:4,start:1000}]],
    ['indic-emphasis','देख','indic',[{text:'देख',offset:0,emphasized:true,letters:['दे','ख']}]],
    ['latin','office hello world','latin',[{text:'office',offset:0,emphasized:true,letters:['o','f','f','i','c','e']},{text:'hello',offset:7},{text:'world',offset:13}]],
    ['emoji','hello 😀','latin',[{text:'hello',offset:0},{text:'😀',offset:6}],false,'emoji'],
    ['rtl','لا','arabic',[{text:'لا',offset:0,emphasized:true,letters:['ل','ا']}],true],
  ];
  const sequence=[['future',-100,false],['attack',0,true],...Array.from({length:75},(_,i)=>[i===29?'reveal':i===53?'emphasis':i===74?'release':null,(i+1)*1000/60,i<74]),...Array.from({length:30},(_,i)=>[i===29?'paused-release':null,1250,false]),['forward-seek',3000,false],['backward-seek',250,true]];
  function raster(picture,width,name) {
    const s=Skia.Surface.Make(width+128,360),c=s.getCanvas();c.clear(Skia.Color('transparent'));c.translate(48.25,64.125);c.drawPicture(picture);s.flush();
    const img=s.makeImageSnapshot();const bytes=img.ref.readPixels(0,0,{width:width+128,height:360,colorType:ck.ColorType.RGBA_8888,alphaType:ck.AlphaType.Unpremul,colorSpace:ck.ColorSpace.SRGB});
    c.clear(Skia.Color('#161c28'));c.drawImage(img,0,0);const display=s.makeImageSnapshot();fs.writeFileSync(path.join(out,name+'.png'),display.encodeToBytes());display.dispose();img.dispose();s.dispose();return bytes;
  }
  const rasters=[];
  for(const width of [260,650])for(const [label,text,font,parts,rtl,fallback] of data)for(const spicy of [true,false])for(const background of [false,true]) {
    const f=fixture(text,font,parts,rtl,fallback,width),words=f.shape(spicy),options={width,spicy,background,fontSize:64,lineEnd:2000};
    const off=mount('off',words,options),on=mount('on',words,options);
    for(const [phase,time,active] of sequence) {
      const sample={time,active,dt:1000/60};off.tick(sample);on.tick(sample);
      if(!phase)continue;
      const prefix=`${width}-${label}-${spicy?'spicy':'amll'}-${background?'bg':'fg'}-${phase}`;
      const a=raster(off.output.picture.value,width,prefix+'-off'),b=raster(on.output.picture.value,width,prefix+'-on');
      let max=0,count=0;for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]);max=Math.max(max,d);if(d)count++;}
      assert.equal(max,0,prefix+' exact alpha/visible pixels');rasters.push({prefix,max,count});
    }
    off.unmount();on.unmount();
    fs.writeFileSync(path.join(out,'raster-progress.json'),JSON.stringify({provenance,rasters},null,2));
  }
  resources.forEach(r=>r.delete?.());
  fs.writeFileSync(path.join(out,'raster.json'),JSON.stringify({provenance,rasters},null,2));
  console.log(`${rasters.length} exact RGBA pairs; callback and pipeline measurements saved. Host simulation only.`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
