/* global __dirname */
// Host experiment only: actual component callback and CanvasKit picture factory.
// Allocations count executed application literals and array-producing calls;
// they exclude JS engine, Reanimated internals and Skia native allocations.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance, PerformanceObserver } = require('node:perf_hooks');
module.exports = async function benchmark({ original, source, priorSource, load, Skia, fixture, out, provenance }) {
  const shaped = fixture('office hello world', 'latin', [
    { text: 'office', offset: 0, end: 1000, emphasized: true, letters: ['o','f','f','i','c','e'] },
    { text: 'hello', offset: 7, start: 1000, end: 2000 }, { text: 'world', offset: 13, start: 2000, end: 3000 },
  ]);
  const gc = [];
  const observer = new PerformanceObserver(list => gc.push(...list.getEntries().map(e => ({ startTime: e.startTime, duration: e.duration, kind: e.detail.kind }))));
  observer.observe({ entryTypes: ['gc'] });
  const replay = Array.from({ length: 1000 }, (_, frame) => {
    const segment = frame % 250;
    return { time: segment < 180 ? segment * 16.6666666667 : segment < 210 ? 2000 : segment < 230 ? 7000 : 250 + (segment - 230) * 16.6666666667,
      active: segment < 180 || segment >= 230, dt: 1000/60 };
  });
  function mount(contents, retained, words, options, instrument) {
    const frames = [], cleanups = [], shared = [];
    const counts = { arrays: 0, objects: 0, arrayResults: 0, regexps: 0, functions: 0, pictureWrappers: 0, sharedModifications: 0 };
    const mutable = value => {
      const cell = { value, _isReanimatedSharedValue: true, modify(fn) { counts.sharedModifications++; this.value = fn(this.value); } };
      shared.push(cell); return cell;
    };
    const react = { memo: f => f, useMemo: f => f(), useCallback: f => f, useEffect: f => { cleanups.push(f()); }, createElement: (_type, props) => props };
    const currentPictures = [];
    const mocks = { react, reanimated: { makeMutable: mutable, useSharedValue: mutable, useFrameCallback: f => { const frame = { fn: f, active: false }; frames.push(frame); return { setActive(v) { frame.active = v; } }; } },
      skia: { createPicture(draw, bounds) { counts.pictureWrappers++; const recorder = Skia.PictureRecorder(); draw(recorder.beginRecording(bounds));
        const p = recorder.finishRecordingAsPicture(); recorder.dispose();
        // Release the previous host frame only after recording its replacement.
        currentPictures.pop()?.dispose(); currentPictures.push(p); return p;
      } }, allocate(kind, value) { if (kind !== 'arrayResults' || Array.isArray(value)) counts[kind]++; return value; } };
    const exports = load(contents, mocks, instrument), position = mutable(0), active = mutable(false);
    const lineMotion = mutable({ scale: 1, velocity: 0, bright: 0.85, dark: 0.5 });
    const output = exports[retained ? 'RetainedGlyphPicture' : 'NativeGlyphPicture']({ words, position, active, lineMotion, width: 650, height: 320, ...options });
    return { output, counts, tick(sample) { position.value = sample.time; active.value = sample.active; for(const f of frames) if(f.active)f.fn({ timeSincePreviousFrame: sample.dt }); },
      get clock() { return retained ? shared.find(s=>s.value?.clock)?.value.clock : shared.find(s=>s.value?.floatClock)?.value.floatClock; },
      get motions() { return retained ? shared.find(s => s.value?.clock)?.value.words.map(w => w.motion) : shared.find(s => s.value?.floatClock)?.value.motions; },
      unmount() { for(const f of cleanups) f?.(); for(const p of currentPictures)p.dispose(); } };
  }
  const results=[];
  const equations=load(original+'\nexport {amllFloat,amllWordFloatPosition};');
  for(const spicy of [true,false]) for(const background of [false,true]) {
    const words=shaped.shape(spicy), options={spicy,background,fontSize:64,lineEnd:3000};
    for(const variant of ['original','current-retained','notification-fix','no-mask']) {
      const retained = variant !== 'original';
      const variantSource = variant === 'current-retained' ? priorSource : source;
      const variantOptions = {...options, clipMode: variant === 'no-mask' ? 'group' : 'mask'};
      const name=`${spicy?'spicy':'amll'}-${background?'bg':'fg'}-${variant}`;
      const instance=mount(retained?variantSource:original,retained,words,variantOptions,false);
      for(const sample of replay.slice(0,100))instance.tick(sample);
      const before={...instance.counts}, times=[], start=performance.now();
      for(const sample of replay) { const t=performance.now();instance.tick(sample);times.push(performance.now()-t); }
      const end=performance.now(); await new Promise(resolve=>setImmediate(resolve)); await new Promise(resolve=>setTimeout(resolve,20));
      const events=gc.filter(e=>e.startTime>=start&&e.startTime<end);
      const counters=Object.fromEntries(Object.keys(before).map(k=>[k,instance.counts[k]-before[k]]));instance.unmount();
      const measured=mount(retained?variantSource:original,retained,words,variantOptions,true);
      for(const sample of replay.slice(0,100))measured.tick(sample);
      const allocated={...measured.counts};for(const sample of replay)measured.tick(sample);
      const allocations=Object.fromEntries(['arrays','objects','arrayResults','regexps','functions'].map(k=>[k,measured.counts[k]-allocated[k]]));
      measured.unmount();
      times.sort((a,b)=>a-b);
      results.push({name,frames:1000,meanMs:times.reduce((a,b)=>a+b,0)/1000,p95Ms:times[949],counters,allocations,
        gc:{count:events.length,durationMs:events.reduce((n,e)=>n+e.duration,0),kinds:events.map(e=>e.kind)},
        scope:retained?'UI property updater only; native C++ command replay excluded':'UI callback plus CanvasKit-backed nested picture recording; native parent Canvas replay excluded'});
      fs.writeFileSync(path.join(out,'four-way-benchmark-progress.json'),JSON.stringify(results,null,2));
    }
    // Independent mounts must agree throughout the same complete replay.
    for (const [candidate,clipMode] of [[priorSource,'mask'],[source,'mask'],[source,'group']]) {
    const old=mount(original,false,words,options,false), next=mount(candidate,true,words,{...options,clipMode},false);
    for(const sample of replay) { old.tick(sample); next.tick(sample);
      if(spicy)assert.equal(JSON.stringify(next.motions),JSON.stringify(old.motions),'Full replay preserves springs, pause/release and seek resets');
      else for(const w of words)assert.equal(equations.amllFloat(equations.amllWordFloatPosition(next.clock,sample.time,w.word.start,w.word.end),w.word.start,w.word.end,background),equations.amllFloat(equations.amllWordFloatPosition(old.clock,sample.time,w.word.start,w.word.end),w.word.start,w.word.end,background),'AMLL full replay release/seek float parity'); }
    old.unmount();next.unmount();
    }
  }
  // Complete bounded host pipeline: actual callback + parent picture + CPU raster.
  const installed = path.dirname(require.resolve('@shopify/react-native-skia/package.json'));
  const renderer = load(['Recorder','Visitor','Player','DrawingContext'].map((file,i) =>
    `export {${['Recorder','visit','replay','createDrawingContext'][i]}} from ${JSON.stringify(path.join(installed,'src/sksg/Recorder',file))};`).join('\n'));
  const React = require('react');
  function expand(element) {
    if (element == null || typeof element === 'boolean') return null;
    if (Array.isArray(element)) return element.flatMap(e => expand(e) ?? []);
    if (typeof element.type === 'function') return expand(element.type(element.props));
    const { children, ...props } = element.props;
    return { type:element.type, props, children:React.Children.toArray(children).flatMap(e=>expand(e)??[]) };
  }
  const pipeline=[];
  for(const spicy of [true,false]) for(const [phase,index] of [['reveal',30],['emphasis',54]]) {
    const words=shaped.shape(spicy), options={spicy,background:false,fontSize:64,lineEnd:3000};
    for(const variant of ['original','current-retained','notification-fix','no-mask']) {
      const retained=variant!=='original', contents=variant==='current-retained'?priorSource:source;
      const clipMode=variant==='no-mask'?'group':'mask';
      const instance=mount(retained?contents:original,retained,words,{...options,clipMode},false);
      for(const sample of replay.slice(0,index))instance.tick(sample);
      let recording;
      if(retained) {
        const graph=load(contents), rec=new renderer.Recorder();
        renderer.visit(rec,[expand(React.createElement(graph.RetainedGlyphGraph,{words,state:instance.output.state,spicy,clipMode}))]);
        recording=rec.getRecording();
      }
      const surface=Skia.Surface.Make(778,320), canvas=surface.getCanvas(), samples=[];
      for(let trial=0;trial<4;trial++) {
        const modifications=instance.counts.sharedModifications, start=performance.now();
        instance.tick(replay[index+trial]); const updated=performance.now();
        const rec=Skia.PictureRecorder(), c=rec.beginRecording(Skia.XYWHRect(0,0,778,320));c.translate(48.25,64.125);
        if(retained) {
          const clip=c.clipPath.bind(c);c.clipPath=(p,op)=>clip(p,op,false);
          const ctx=renderer.createDrawingContext(Skia,recording.paintPool,c);renderer.replay(ctx,recording.commands);ctx.dispose();
        } else c.drawPicture(instance.output.picture.value);
        const picture=rec.finishRecordingAsPicture(), recorded=performance.now();
        canvas.clear(Skia.Color('transparent'));canvas.drawPicture(picture);surface.flush();const end=performance.now();
        if(trial>=2)samples.push({callbackMs:updated-start,parentRecordMs:recorded-updated,rasterFlushMs:end-recorded,totalMs:end-start,forcedModify:instance.counts.sharedModifications-modifications});
        picture.dispose();rec.dispose();
      }
      pipeline.push({style:spicy?'spicy':'amll',phase,variant,width:650,warmups:2,samples});
      for(const paint of recording?.paintPool??[])paint.dispose();surface.dispose();instance.unmount();
      fs.writeFileSync(path.join(out,'pipeline-progress.json'),JSON.stringify(pipeline,null,2));
    }
  }
  fs.writeFileSync(path.join(out,'pipeline.json'),JSON.stringify({scope:'Actual mocked-hook callbacks + installed JS parent replay + CPU CanvasKit software raster/flush; no Reanimated/native C++/phone GPU; 650px Latin fg only',provenance,pipeline},null,2));
  observer.disconnect();
  const report={priorSourceHash:require('node:crypto').createHash('sha256').update(priorSource).digest('hex'),provenance,engine:`Node ${process.version}; CanvasKit ${require('canvaskit-wasm/package.json').version}`,release:false,
    allocationMethod:'Executed app object/array literals and array-producing map/filter/flat/flatMap/slice/concat/from calls instrumented with Babel after bundling. Array literals and producer results separate. External library allocations, engine allocations and function expressions and regular-expression literals counted separately; external callback/runtime allocations excluded. Timings use a separate uninstrumented run.',
    nativeRecordings:'Not measured. Installed native recorder still records a picture per animated Canvas replay, reusing a JS wrapper. CanvasKit wrapper counts above are host baseline component factory calls only.',
    replay,results};
  fs.writeFileSync(path.join(out,'four-way-benchmark.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(results,null,2));
};
