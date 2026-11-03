// Measurement correctness and release parity. Mock hosts are not device evidence.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'components/lyrics/native');
const baseline = file => execFileSync('git', ['show', `c2aaa20:${path.relative(path.resolve(root, '..'), file)}`], { encoding: 'utf8' });
function build(file, dev, original, extra = '') {
  return buildSync({ stdin: { contents: (original ?? fs.readFileSync(file, 'utf8')) + extra, resolveDir: path.dirname(file), loader: 'tsx' },
    bundle: true, platform: 'node', format: 'cjs', write: false, minifySyntax: true, define: { __DEV__: String(dev) },
    external: ['react', 'react/jsx-runtime', 'react-native-reanimated', 'react-native-worklets', '@shopify/react-native-skia'] }).outputFiles[0].text;
}
function evaluate(code, modules, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, setTimeout, clearTimeout, performance, console, ...globals,
    require: name => { assert.ok(name in modules, `unmocked ${name}`); return modules[name]; } });
  return module.exports;
}
function hooks() {
  const slots = [], effects = [], calls = []; let cursor = 0;
  const memo = (factory, deps) => {
    const index = cursor++, old = slots[index];
    if (!old || !deps || deps.some((value, i) => !Object.is(value, old.deps[i]))) slots[index] = { deps, value: factory() };
    return slots[index].value;
  };
  const react = { memo: fn => fn, createContext: value => ({ value }), useContext: context => { calls.push('context'); return context.value; },
    useMemo: (fn, deps) => { calls.push('memo'); return memo(fn, deps); },
    useCallback: (fn, deps) => { calls.push('callback'); return memo(() => fn, deps); },
    useEffect(fn, deps) { calls.push('effect'); memo(() => { effects.push(() => { const cleanup = fn(); return cleanup; }); return 0; }, deps); },
    createElement: (type, props, children) => ({ type, props: { ...props, children } }),
  };
  // Effects own cleanup cells independent of memo; run old cleanup before setup.
  react.useEffect = (fn, deps) => {
    calls.push('effect'); const index = cursor++, old = slots[index];
    if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) {
      const cell = { deps }; slots[index] = cell;
      effects.push(() => { old?.cleanup?.(); cell.cleanup = fn(); });
    }
  };
  return { react, calls, memo, begin() { cursor = 0; }, commit() { while (effects.length) effects.shift()(); },
    unmount() { for (const cell of slots) cell?.cleanup?.(); } };
}
function pictureDriver(dev, original) {
  const h = hooks(), queue = [], frames = [], rnCalls = [], commandFrames = [];
  let mutables = 0, shared = 0, pictures = 0, paintCreates = 0, filters = 0, shaders = 0;
  const mutable = value => ({ value, modify(fn) { this.value = fn(this.value); } });
  const paint = () => { paintCreates++; return { setAntiAlias() {}, setBlendMode() {}, setColor() {}, setAlphaf() {}, setShader() {}, setImageFilter() {} }; };
  const skia = { XYWHRect: (x,y,width,height) => ({x,y,width,height}), Paint: paint, Color: value => value,
    ImageFilter: { MakeBlur: () => { filters++; return {}; } }, Shader: { MakeLinearGradient: () => { shaders++; return {}; } } };
  const createPicture = draw => {
    pictures++; const commands = [];
    draw(new Proxy({}, { get: (_, name) => (...args) => commands.push(String(name)) }));
    commandFrames.push(commands); return { picture: pictures };
  };
  const modules = { react: h.react, 'react/jsx-runtime': { jsx: (type, props) => ({type,props}) },
    '@shopify/react-native-skia': { Skia: skia, createPicture, Picture:'Picture', BlendMode:{SrcIn:5,SrcOver:3}, ClipOp:{Intersect:0}, TileMode:{Clamp:0,Decal:1} },
    'react-native-reanimated': {
      makeMutable(value) { mutables++; return mutable(value); },
      useSharedValue(value) { h.calls.push('shared'); return h.memo(() => { shared++; return mutable(value); }, []); },
      useFrameCallback(fn) { h.calls.push('frame'); const frame = h.memo(() => { const frame = { active:false }; frames.push(frame); return frame; }, []); frame.fn = fn;
        return h.memo(() => ({ setActive(value) { frame.active = value; } }), []); },
    },
    'react-native-worklets': { scheduleOnUI: (fn,...args) => queue.push(() => fn(...args)), scheduleOnRN: (fn,...args) => { rnCalls.push(fn.name); fn(...args); } },
  };
  const extra = original ? '' : '\nexport { startArrivalCapture, beginArrival, flushArrivalUiCounts, snapshotArrivalCapture, registerArrivalUiReader, requestArrivalUiSample, receiveArrivalUiSample } from "@/lib/lyrics-arrival-trace";';
  const api = evaluate(build(path.join(directory, 'native-glyph-picture.tsx'), dev, original, extra), modules);
  const rect = {x:0,y:0,width:20,height:24};
  const words = [{ word:{text:'sing',start:0,end:1000,offset:0,letters:['s','i','n','g'],emphasized:false,joined:false},
    rects:[rect],letters:[],revealRects:[rect],width:20,before:0,clips:[{}],pictures:[{}],emojiMask:[false],
    runs:[[{glyphs:[1],positions:[{x:0,y:20}],font:{}}]] }];
  const props = { words,width:100,height:24,position:{value:0},active:{value:true},spicy:true,background:false,fontSize:36,lineEnd:1000,
    lineMotion:{value:{dark:.2,bright:.8}} };
  return { api, props, h, rnCalls, commandFrames,
    render(next={}) { Object.assign(props,next); h.begin(); const tree=api.NativeGlyphPicture(props); h.commit(); return tree; },
    tick(time) { props.position.value=time; props.lineMotion.value={...props.lineMotion.value,dark:.2+time/10000};
      for(const frame of frames) if(frame.active) frame.fn({timeSincePreviousFrame:16}); },
    drain() { while(queue.length) queue.shift()(); },
    async flush() { const pending=api.flushArrivalUiCounts(); this.drain(); return pending; },
    stats:()=>({mutables,shared,frames:frames.length,pictures,paintCreates,filters,shaders}),
  };
}
(async () => {
  const file=path.join(directory,'native-glyph-picture.tsx');
  const old=pictureDriver(false,baseline(file)), release=pictureDriver(false);
  old.render(); release.render();
  for(const time of [100,200,300,800,1200]) { old.tick(time);release.tick(time); }
  assert.deepEqual(release.h.calls,old.h.calls,'release hook/shared/frame ownership equals c2aaa20');
  assert.deepEqual(release.stats(),old.stats());
  assert.deepEqual(release.commandFrames,old.commandFrames,'instrumentation preserves release draw calls');
  assert.equal(release.stats().mutables,0);

  const d=pictureDriver(true); d.api.startArrivalCapture();
  const a=d.api.beginArrival({},'a'), b=d.api.beginArrival({},'b');
  d.render({arrivalOwner:a,arrivalGeneration:1});d.tick(100);d.tick(200);
  assert.equal(d.api.snapshotArrivalCapture().counters.firstPicturePublications,1);
  const aCounts=(await d.flush()).uiCounts;
  assert.equal(aCounts.totals.pictureBuilds,2);assert.equal(aCounts.complete,true);
  // Recycle and draw before the old owner's asynchronous retirement sample.
  d.render({arrivalOwner:b}); d.tick(300);d.drain();
  assert.equal(d.api.snapshotArrivalCapture().counters.firstPicturePublications,2);
  d.render({arrivalGeneration:2});d.tick(400);
  d.render({width:120});d.tick(500);
  d.render({words:[...d.props.words]});d.tick(600);
  let snapshot=await d.flush();
  assert.equal(snapshot.counters.firstPicturePublications,5,'owner, generation, geometry and words each reset first-record scope');
  assert.equal(snapshot.uiCounts.totals.pictureBuilds,6,'all dynamic builds, not just five first reports');
  assert.equal(snapshot.uiCounts.owners.length,5);
  const pictureEpochs=snapshot.records.filter(r=>r.pictureEpoch!==undefined).map(r=>r.pictureEpoch);
  assert.equal(new Set(pictureEpochs).size,5,'first-record events join distinct geometry epochs to scoped UI samples');
  assert.equal(snapshot.uiCounts.owners[0].packet,a.packet);
  assert.equal(snapshot.uiCounts.owners[0].totals.pictureBuilds,2,'retirement reads old cell after new owner draws');
  assert.equal(snapshot.uiCounts.totals.paintConstructors,d.stats().paintCreates);
  assert.equal(snapshot.uiCounts.totals.blurFilterConstructors,d.stats().filters);
  assert.equal(snapshot.uiCounts.totals.shaderConstructors,d.stats().shaders);
  const same=await d.flush();assert.equal(same.uiCounts.totals.pictureBuilds,6,'repeated flush never double counts');
  const jsBefore=d.rnCalls.length;for(let i=0;i<20;i++)d.tick(650+i);
  assert.equal(d.rnCalls.length,jsBefore,'no per-frame measurement JS traffic');
  assert.equal((await d.flush()).uiCounts.totals.pictureBuilds,26);
  d.api.startArrivalCapture();d.drain();assert.equal(d.api.snapshotArrivalCapture().uiCounts.totals.pictureBuilds,0);
  const c=d.api.beginArrival({},'c');d.render({arrivalOwner:c});d.tick(800);d.drain();
  snapshot=await d.flush();assert.equal(snapshot.counters.firstPicturePublications,1);
  assert.equal(snapshot.uiCounts.totals.pictureBuilds,1,'old captures never enter new totals');
  d.h.unmount();d.drain();assert.equal((await d.flush()).uiCounts.liveReaders,0);

  const idle=pictureDriver(true);idle.api.startArrivalCapture();
  const idleA=idle.api.beginArrival({},'idle-a'),idleB=idle.api.beginArrival({},'idle-b');
  idle.render({arrivalOwner:idleA,arrivalGeneration:1,active:{value:false}});
  for(let i=0;i<100;i++)idle.tick(0);
  const idleBuilds=idle.stats().pictures, idleFirst=idle.api.snapshotArrivalCapture().counters.firstPicturePublications;
  idle.render({arrivalOwner:idleB});idle.tick(0);
  assert.equal(idle.stats().pictures,idleBuilds,'ownership observation must not force an idle picture rebuild');
  assert.equal(idle.api.snapshotArrivalCapture().counters.firstPicturePublications,idleFirst);
  idle.props.active.value=true;idle.tick(200);
  assert.equal(idle.api.snapshotArrivalCapture().counters.firstPicturePublications,idleFirst+1,'new owner reports its next actual record');
  await idle.flush();idle.h.unmount();idle.drain();

  // Release adapters must not invoke any React hook or native scheduler.
  const contextFile=path.join(root,'lib/lyrics-arrival-context.ts');
  const fail=()=>{throw Error('production measurement hook or scheduler');};
  const releaseAdapters=evaluate(build(contextFile,false),{react:new Proxy({},{get:()=>fail})});
  releaseAdapters.useArrivalVoice();releaseAdapters.useArrivalIdentity();releaseAdapters.useArrivalGeometry();
  const normalize=node=>typeof node==='function'?'function':Array.isArray(node)?Array.from(node,normalize):node&&typeof node==='object'?Object.fromEntries(Object.entries(node).map(([key,value])=>[key,normalize(value)])):node;
  const {createVoiceHarness,bundle}=require('./check-native-translation-toggle.cjs');
  const voiceFile=path.join(directory,'native-skia-voice.tsx');
  for(const spicy of [false,true]) {
    const before=createVoiceHarness(bundle(baseline(voiceFile)),spicy);
    const after=createVoiceHarness(bundle(fs.readFileSync(voiceFile,'utf8')),spicy,{arrivalContextModule:releaseAdapters});
    const voice={words:[],paintWords:[],paintText:'',start:0,end:100,translation:''};
    before.render(voice).props.onLayout({nativeEvent:{layout:{width:240}}});
    after.render(voice).props.onLayout({nativeEvent:{layout:{width:240}}});
    assert.deepEqual(normalize(after.render(voice)),normalize(before.render(voice)), 'release voice tree/props equal baseline');
    assert.deepEqual(after.hookCalls,before.hookCalls,'release voice hook sequence equals baseline');
  }
  const {harness}=require('./check-native-translation-scroll.cjs');
  const viewFile=path.join(directory,'native-lyrics-view.tsx');
  const compileView=source=>buildSync({jsx:'automatic',stdin:{contents:source,resolveDir:directory,loader:'tsx'},bundle:true,platform:'node',format:'cjs',write:false,external:['*'],define:{__DEV__:'false'},minifySyntax:true}).outputFiles[0].text;
  for(const style of ['amll','spicy'])for(const list of ['flash','flat']) {
    const before=harness(style,list,{code:compileView(baseline(viewFile))});
    const after=harness(style,list,{code:compileView(fs.readFileSync(viewFile,'utf8')),arrivalContextModule:releaseAdapters});
    assert.deepEqual(after.hookCalls,before.hookCalls,'release view hook sequence equals baseline');
    assert.deepEqual(normalize(after.treeSnapshot()),normalize(before.treeSnapshot()),'release native tree has no trace wrapper');
  }
  let contextApi, fontProvider = {};
  const contextExtra = '\nexport { startArrivalCapture, beginArrival, arrivalSpan, arrivalEvent, snapshotArrivalCapture } from "./lyrics-arrival-trace";';
  const devView=buildSync({jsx:'automatic',stdin:{contents:fs.readFileSync(viewFile,'utf8'),resolveDir:directory,loader:'tsx'},bundle:true,platform:'node',format:'cjs',write:false,external:['*'],define:{__DEV__:'true'}}).outputFiles[0].text;
  const devHost=harness('spicy','flash',{code:devView,dev:true,fontProvider:()=>fontProvider,arrivalContextFactory(react,state){
    contextApi=evaluate(build(contextFile,true,undefined,contextExtra),{react});
    contextApi.startArrivalCapture();contextApi.beginArrival(state.lyrics,'fixture');return contextApi;
  }});
  const initial=contextApi.snapshotArrivalCapture();
  const initialOrigin=initial.records.filter(r=>r.stage==='stage-producer-attribution').at(-1);
  const modelCalls=initial.counters.modelCalls, cueCalls=initial.counters.cueBuilds;
  devHost.viewport(650);
  const resized=contextApi.snapshotArrivalCapture();
  const resizedOrigin=resized.records.filter(r=>r.stage==='stage-producer-attribution').at(-1);
  assert.notEqual(resizedOrigin.generation,initialOrigin.generation,'geometry gets a distinct observation generation');
  assert.equal(resizedOrigin.producers.model,initialOrigin.producers.model);
  assert.equal(resizedOrigin.producers.cues,initialOrigin.producers.cues);
  assert.equal(resized.counters.modelCalls,modelCalls);assert.equal(resized.counters.cueBuilds,cueCalls);
  fontProvider = {};devHost.render({fontScale:1.1});
  const fontChanged=contextApi.snapshotArrivalCapture();
  const fontOrigin=fontChanged.records.filter(r=>r.stage==='stage-producer-attribution').at(-1);
  assert.notEqual(fontOrigin.generation,resizedOrigin.generation);
  assert.equal(fontOrigin.producers.model,initialOrigin.producers.model);
  assert.equal(fontChanged.counters.modelCalls,modelCalls);assert.equal(fontChanged.counters.cueBuilds,cueCalls);
  devHost.state.lyrics=JSON.parse(JSON.stringify(devHost.state.lyrics));
  contextApi.beginArrival(devHost.state.lyrics,'fixture');devHost.render();
  const replaced=contextApi.snapshotArrivalCapture();
  assert.equal(replaced.counters.modelCalls,modelCalls+1);assert.equal(replaced.counters.cueBuilds,cueCalls+1);
  // Bounded live registry: saturation makes exports incomplete, never a zero baseline.
  d.api.startArrivalCapture();const bounded=d.api.beginArrival({},'bounded');
  for(let i=0;i<513;i++)d.api.registerArrivalUiReader(bounded,10000+i,()=>Promise.resolve());
  const saturated=await d.flush();assert.equal(saturated.uiCounts.complete,false);
  assert.equal(saturated.uiCounts.droppedOwners,1);assert.equal(saturated.uiCounts.liveReaders,512);
  const {compare}=require('./compare-lyrics-arrival-counts.cjs');
  const meta={schema:1,counterSchema:1,buildMode:'development',runId:'review-unit',sourceSha:'a'.repeat(40),fixtureSha:'b'.repeat(40),instrumentationSha:'c'.repeat(40),configuration:'spicy',scenario:'cold',counters:snapshot.counters,uiCounts:snapshot.uiCounts};
  const paired=compare({...meta,variant:'baseline'},{...meta,variant:'candidate'});
  assert.equal(paired.uiMetrics.pictureBuilds.delta,0);
  assert.equal(compare({...meta,variant:'baseline'},{...meta,variant:'candidate',uiCounts:saturated.uiCounts}).uiMetrics,undefined);
  const timers=new Map();let timerSequence=0;
  const timeoutTrace=evaluate(build(path.join(root,'lib/lyrics-arrival-trace.ts'),true),{}, {
    setTimeout(fn){const id=++timerSequence;timers.set(id,fn);return id;}, clearTimeout(id){timers.delete(id);}
  });
  timeoutTrace.startArrivalCapture();const timeoutOwner=timeoutTrace.beginArrival({},'timeout');
  timeoutTrace.registerArrivalUiReader(timeoutOwner,1,()=>timeoutTrace.requestArrivalUiSample(()=>{}));
  const timeoutFlush=timeoutTrace.flushArrivalUiCounts();for(const fn of [...timers.values()])fn();
  const timeoutResult=await timeoutFlush;
  assert.equal(timeoutResult.uiCounts.complete,false);assert.equal(timeoutResult.uiCounts.timeouts,1);
  timeoutTrace.receiveArrivalUiSample(timeoutOwner,1,1,{pictureBuilds:99,paintConstructors:0,blurFilterConstructors:0,shaderConstructors:0},1);
  assert.equal(timeoutTrace.snapshotArrivalUiCounts().totals.pictureBuilds,0,'timed-out replies cannot resurrect counts');
  timeoutTrace.startArrivalCapture();const historyOwner=timeoutTrace.beginArrival({},'history');
  for(let i=0;i<2049;i++) await timeoutTrace.requestArrivalUiSample(request=>timeoutTrace.receiveArrivalUiSample(historyOwner,i,1,{pictureBuilds:1,paintConstructors:0,blurFilterConstructors:0,shaderConstructors:0},request));
  assert.equal(timeoutTrace.snapshotArrivalUiCounts().owners.length,2048);
  assert.equal(timeoutTrace.snapshotArrivalUiCounts().droppedOwners,1);
  assert.equal((await timeoutTrace.flushArrivalUiCounts()).uiCounts.complete,false);
  const expectedProduction=baseline(file).split('export const NativeGlyphPicture = memo(')[1].trim().slice(0,-2);
  assert.ok(fs.readFileSync(file,'utf8').includes('const NativeGlyphPictureProduction = '+expectedProduction), 'production component body remains byte-identical to c2aaa20');
  console.log('review regressions passed: recycled UI epochs, complete dynamic counts, retirement/flush/capture isolation, no per-frame JS and release hook/tree/worklet parity against c2aaa20; mocked hosts only');
})().catch(error=>{console.error(error);process.exitCode=1;});
