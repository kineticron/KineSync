/* global __dirname */
'use strict';
require('./check-spicy-progressive-blur.cjs');
const assert=require('node:assert/strict'),path=require('node:path'),vm=require('node:vm'),{execFileSync}=require('node:child_process'),{buildSync}=require('esbuild');
const {bundle,createVoiceHarness,currentCode}=require('./check-native-translation-toggle.cjs');
function load(file,modules,dev=true){const module={exports:{}};const code=buildSync({entryPoints:[path.join(__dirname,'..',file)],bundle:true,external:['*'],platform:'node',format:'cjs',write:false}).outputFiles[0].text;vm.runInNewContext(code,{__DEV__:dev,module,exports:module.exports,require:name=>{if(name==='./native-progressive-blur'&&progModule)return progModule;assert(name in modules,name);return modules[name];}});return module.exports;}
const progModule=load('components/lyrics/native/native-progressive-blur.ts',{
 react:{createContext:value=>({value}),useMemo:fn=>fn()},'react-native-reanimated':{useSharedValue:x=>({value:x}),useAnimatedReaction:()=>{},withTiming:x=>x},
 './native-shared-blur':{},
});
function fastHost(enabled=true,dev=true){
 const slots=[];let cursor=0;const queue=[];
 const memo=(fn,deps)=>{const i=cursor++;if(!slots[i]||deps.some((x,n)=>x!==slots[i].deps[n]))slots[i]={deps,value:fn()};return slots[i].value;};
 const react={useMemo:memo,useCallback:(fn,deps)=>memo(()=>fn,deps),useRef:value=>memo(()=>({current:value}),[]),useState:initial=>{const cell=memo(()=>({value:typeof initial==='function'?initial():initial}),[]);return [cell.value,value=>{cell.value=value;}];},createElement:(type,props)=>({type,props})};
 const api=load('components/lyrics/native/native-fast-voice.tsx',{react,'./native-skia-voice':{NativeSkiaVoice:'exact'},'./native-lazy-skia-voice':{NativeLazySkiaVoice:'lazy'},'@/lib/fast-lyric-loading':{useFastLyricLoading:()=>enabled},'react-native-worklets':{scheduleOnRN:fn=>queue.push(fn)},'react-native-reanimated':{useAnimatedReaction(prepare,react){const cell=memo(()=>({previous:null}),[]);cell.tick=()=>{const value=prepare();react(value,cell.previous);cell.previous=value;};}},'react/jsx-runtime':{jsx:(type,props)=>({type,props})}},dev);
 return {...api,render(props){cursor=0;return api.NativeFastVoice(props);},tick(){slots.forEach(cell=>cell?.value?.tick?.());},flush(){queue.splice(0).forEach(fn=>fn());}};
}
const fs=require('node:fs');
const lazyCode=bundle(fs.readFileSync(path.join(__dirname,'../components/lyrics/native/native-lazy-skia-voice.tsx'),'utf8').replaceAll('NativeLazySkiaVoice','NativeSkiaVoice'));
const baseline=bundle(execFileSync('git',['show','b8342083c617a56cebe18822ce589ce12a34d515:ExpoLyrics/components/lyrics/native/native-skia-voice.tsx'],{encoding:'utf8'}));
const trace={arrivalCounter(){},arrivalNow(){},arrivalEvent(){},arrivalProduced:(_h,_g,value)=>value,arrivalSpan:(_h,_g,_name,fn)=>fn()};
const voice={start:100000,end:101000,words:[{text:'क्‍ष ffi 👩‍🚀',starts:[100000],ends:[101000],weights:[3]}],paintText:'क्‍ष ffi 👩‍🚀',paintWords:[{text:'क्‍ष ffi 👩‍🚀',offset:0,start:100000,end:101000,letters:['क्‍ष',' ','ffi',' ','👩‍🚀'],emphasized:true,joined:false}],translation:'translation'};
function find(node,type){if(!node||typeof node!=='object')return null;if(node.type===type)return node;for(const child of [node.props?.children].flat()){const found=find(child,type);if(found)return found;}return null;}
const plain=x=>JSON.parse(JSON.stringify(x));
function mount(code,spicy,props,dev=false){const h=createVoiceHarness(code,spicy,{dev,arrivalTrace:trace});let tree=h.render(voice,props);tree.props.onLayout({nativeEvent:{layout:{width:320.125}}});tree=h.render(voice,props);return {h,tree};}
for(const spicy of [false,true]){
 const before=mount(baseline,spicy,{}),off=mount(currentCode,spicy,{});
 const output=({h,tree})=>plain({height:tree.props.style[0].height,glyphs:find(tree,h.NativeGlyphPicture)?.props});
 assert.deepEqual(output(off),output(before),'OFF output equals original source');assert.deepEqual(off.h.counters,before.h.counters,'OFF work counts equal original');
 assert.deepEqual(output(mount(currentCode,spicy,{prepareGlyphs:false})),output(off),'release baseline ignores experiment');
 const {h,tree}=mount(lazyCode,spicy,{prepareGlyphs:false},true);assert.equal(h.counters.glyphShapePasses,0);assert.equal(find(tree,h.NativeGlyphPicture),null);
 const layouts=h.counters.mainParagraphLayouts,upgraded=h.render(voice,{prepareGlyphs:true});assert.equal(h.counters.glyphShapePasses,1);assert.equal(h.counters.mainParagraphLayouts,layouts,'promotion reuses paragraph');
 assert.deepEqual(plain(find(upgraded,h.NativeGlyphPicture).props.words),plain(find(off.tree,off.h.NativeGlyphPicture).props.words),'exact upgraded Unicode inputs');
 const words=find(upgraded,h.NativeGlyphPicture).props.words,hidden=h.render(voice,{prepareGlyphs:true,showTranslation:false});assert.equal(find(hidden,h.NativeGlyphPicture).props.words,words);
 hidden.props.onLayout({nativeEvent:{layout:{width:640.25}}});h.render(voice,{prepareGlyphs:true});assert.equal(h.counters.glyphShapePasses,2,'rotation shapes new geometry');
 let shapes=0;for(let i=0;i<30;i++)shapes+=mount(lazyCode,spicy,{prepareGlyphs:false},true).h.counters.glyphShapePasses;assert.equal(shapes,0);
}
for(const [enabled,dev] of [[false,true],[true,false]]) {
 const gate=fastHost(enabled,dev),node=gate.NativeDevelopmentVoice({voice,batched:true,staticLyrics:false,rowIndex:20,presentationWindow:{value:{}},position:{value:0}});
 assert.equal(node.type,'exact','actual wrapper disables experimental component');
}
const gate=fastHost();assert.equal(gate.NativeDevelopmentVoice({voice,batched:false,presentationWindow:{value:{}}}).type,'exact','tree retains original');assert.equal(gate.NativeDevelopmentVoice({voice,staticLyrics:true,presentationWindow:{value:{}}}).type,'exact','static retains original');
function paragraphAlpha(node){if(!node||typeof node!=='object')return undefined;if(node.type==='Group'&&node.props.layer?.props?.opacity)return node.props.layer.props.opacity.value;if(node.type==='Group'&&node.props.opacity)return node.props.opacity.value;for(const child of [node.props?.children].flat()){const alpha=paragraphAlpha(child);if(alpha!==undefined)return alpha;}}
for(const background of [false,true])for(const sung of [false,true]){
 const {tree}=mount(lazyCode,true,{prepareGlyphs:false,background,position:{value:sung?200000:0}},true);
 assert.equal(paragraphAlpha(tree),sung?background?0.6:0.85:background?0.3:0.5,'paragraph preserves Spicy lead/background sung/unsung paint alpha');
}
// Production Fast Spicy has no shared provider: cold and promoted glyphs
// both carry the real Gaussian layer; cold RN Text cannot represent this blur.
{
 const {h,tree}=mount(lazyCode,true,{prepareGlyphs:false,blur:{value:4},lineActive:{value:false}},true);
 function gaussian(node){if(!node||typeof node!=='object')return null;const blur=find(node.props?.layer,'Blur');if(blur)return blur;for(const child of [node.props?.children].flat()){const result=gaussian(child);if(result)return result;}return null;}
 assert.equal(find(tree,'Text'),null);assert(find(tree,'Glyphs'));
 assert.equal(gaussian(tree).props.blur.value,2);
 const promoted=h.render(voice,{prepareGlyphs:true,blur:{value:4},lineActive:{value:false}});
 assert(find(promoted,h.NativeGlyphPicture));assert.equal(gaussian(promoted).props.blur.value,2);
}
const host=fastHost(),window={visualActiveLineStartIndex:5,visualActiveLineEndIndex:9,focusLineIndex:5};
for(let i=0;i<15;i++)assert.equal(host.needsExactGlyphs(i,100000,101000,0,window),i>=5&&i<=11);
assert.equal(host.needsExactGlyphs(20,1000,9000,2000,window),true,'independent overlapping background');
assert.equal(host.needsExactGlyphs(20,10000,11000,8499,window),false);assert.equal(host.needsExactGlyphs(20,10000,11000,8500,window),true);
const props={voice,rowIndex:20,position:{value:0},presentationWindow:{value:window}};
assert.equal(host.render(props).props.prepareGlyphs,false);host.tick();host.flush();props.position.value=99000;host.tick();host.flush();assert.equal(host.render(props).props.prepareGlyphs,true,'approach promotion');
props.position.value=200000;host.tick();host.flush();assert.equal(host.render(props).props.prepareGlyphs,true,'settling/outgoing owner retained');
const fresh={...props,voice:{...voice,paintWords:[...voice.paintWords]}};assert.equal(host.render(fresh).props.prepareGlyphs,false,'recycling resets demand');fresh.position.value=100000;host.tick();
const replacement={...fresh,position:{value:0},voice:{...voice,paintWords:[...voice.paintWords]}};host.render(replacement);host.flush();assert.equal(host.render(replacement).props.prepareGlyphs,false,'stale callback rejected');
replacement.position.value=99000;host.tick();replacement.position.value=0;host.flush();assert.equal(host.render(replacement).props.prepareGlyphs,false,'seek supersedes queued approach');
replacement.presentationWindow.value={...window,visualActiveLineStartIndex:20,visualActiveLineEndIndex:20};host.tick();host.flush();assert.equal(host.render(replacement).props.prepareGlyphs,true,'seek promotes target');
(async()=>{
 const disk=new Map(),storage={getItem:async key=>disk.get(key)??null,setItem:async(key,value)=>{disk.set(key,value);}},modules={'@react-native-async-storage/async-storage':storage,react:{}},setting=()=>load('lib/fast-lyric-loading.ts',modules);
 const first=setting();assert.equal(first.getFastLyricLoading(),false);await first.loadFastLyricLoading();await first.setFastLyricLoading(true);const restart=setting();await restart.loadFastLyricLoading();assert.equal(restart.getFastLyricLoading(),true);await restart.setFastLyricLoading(false);const off=setting();await off.loadFastLyricLoading();assert.equal(off.getFastLyricLoading(),false);
 let reads=0;const release=load('lib/fast-lyric-loading.ts',{...modules,'@react-native-async-storage/async-storage':{getItem(){reads++;},setItem(){throw Error('release write');}}},false);await release.loadFastLyricLoading();release.setFastLyricLoading(true);assert.equal(release.getFastLyricLoading(),false);assert.equal(reads,0);
 let resolve;const pending=load('lib/fast-lyric-loading.ts',{...modules,'@react-native-async-storage/async-storage':{...storage,getItem:()=>new Promise(done=>{resolve=done;})}});const loading=pending.loadFastLyricLoading();await pending.setFastLyricLoading(true);resolve('false');await loading;assert.equal(pending.getFastLyricLoading(),true);
 console.log('Fast lyric loading PASS: persistence/release gate, actual OFF differential, active+next2/overlap/background/approach, 60 cold distant mounts = 0 word/letter shaping (whole-run extraction used), upgrade/seek/rotation/translation/Indic/recycling/stale callbacks/settling retention. Native mocks; phone raster acceptance pending.');
})().catch(error=>{console.error(error);process.exitCode=1;});

// Dormant prototype coverage: execute the RN cold branch with the same prepared paragraph and fixed outer height.
{
 const h=createVoiceHarness(lazyCode,true,{dev:true,sharedBlur:true,arrivalTrace:trace});
 const latin={...voice,paintText:'hello\nworld',paintWords:[],translation:''};
 let cold=h.render(latin,{prepareGlyphs:false,showTranslation:false});
 cold.props.onLayout({nativeEvent:{layout:{width:320}}});
 cold=h.render(latin,{prepareGlyphs:false,showTranslation:false});
 assert.equal(find(cold,'Canvas'),null); assert.equal(find(cold,h.NativeGlyphPicture),null);
 assert.equal(find(cold,'Text').props.children,'hello\nworld');
 assert.equal(h.counters.coldRunExtractions,0);
 find(cold,'Text').props.onTextLayout({nativeEvent:{lines:[{text:'hello',width:40,x:0,y:-1,height:21,ascender:17},{text:'world',width:40,x:0,y:20,height:21,ascender:17}]}});
 const height=cold.props.style[0].height;
 const promoted=h.render(latin,{prepareGlyphs:true,showTranslation:false});
 assert.equal(promoted.props.style[0].height,height);assert(find(promoted,'Canvas'));
 assert.equal(find(h.render(latin,{prepareGlyphs:false,showTranslation:false,right:true}),'Text'),null);
 assert.equal(find(h.render(latin,{prepareGlyphs:false,showTranslation:false,hasDuet:true,right:false}),'Text'),null,'left duet retains Skia');
 assert.equal(find(h.render({...latin,translation:'translation'},{prepareGlyphs:false}),'Text'),null);
 const rotated=h.render(latin,{prepareGlyphs:false,showTranslation:false});
 rotated.props.onLayout({nativeEvent:{layout:{width:640}}});
 const resized=h.render(latin,{prepareGlyphs:false,showTranslation:false});
 assert.equal(resized.props.style[0].height,height);
 find(resized,'Text').props.onTextLayout({nativeEvent:{lines:[{text:'hel'},{text:'lo world'}]}});
 assert.equal(find(h.render(latin,{prepareGlyphs:false,showTranslation:false}),'Text'),null,'incompatible native breaks retain Skia');
 const fallback=h.render(latin,{prepareGlyphs:false,showTranslation:false});
 fallback.props.onLayout({nativeEvent:{layout:{width:960}}});
 const newLayout=h.render(latin,{prepareGlyphs:false,showTranslation:false});
 find(newLayout,'Text').props.onTextLayout({nativeEvent:{lines:[{text:'hello'},{text:'wor'},{text:'ld'}]}});
 const extraWrap=h.render(latin,{prepareGlyphs:false,showTranslation:false});
 assert.equal(find(extraWrap,'Text'),null,'extra RN wrap retains Skia');
 assert.equal(extraWrap.props.style[0].height,height,'fallback keeps reserved geometry');
}
{
 const progModule=load('components/lyrics/native/native-progressive-blur.ts',{
  react:{createContext:value=>({value}),useMemo:fn=>fn()},'react-native-reanimated':{useSharedValue:x=>({value:x}),useAnimatedReaction:()=>{},withTiming:x=>x},
  './native-shared-blur':{},
 });
 const {sharedBlurRegion}=load('components/lyrics/native/native-shared-blur.tsx',{
  react:{createContext:value=>({value})},'react-native':{StyleSheet:{},View:'View'},'expo-blur':{},
  '@react-native-masked-view/masked-view':{},'expo-linear-gradient':{},'react-native-reanimated':{},'react/jsx-runtime':{},
  './native-progressive-blur':progModule,
 });
 const rows=Array.from({length:12},(_,i)=>({y:i*100,height:100,start:100000,end:101000}));
 const w={visualActiveLineStartIndex:3,visualActiveLineEndIndex:3,focusLineIndex:3};
 const a=sharedBlurRegion(rows,w,0,0),b=sharedBlurRegion(rows,w,0,137);
 assert.equal(a.top-b.top,137);assert.equal(a.bottom-b.bottom,137);
 assert.equal(a.bottom,500); // next whole row 4 (y=400, h=100) protected strictly to 500 without constant offset
 assert.equal(a.top,300); // active row 3 top strictly at 300 without constant offset
 assert.equal(sharedBlurRegion([],w,0,0).top,-Infinity);
 assert(sharedBlurRegion(rows,w,0,2000).bottom<0,'offscreen content stays offscreen');
 assert.equal(sharedBlurRegion(rows,{...w,visualActiveLineStartIndex:7,visualActiveLineEndIndex:7},0,0).top,700);
 const rotated=rows.map(r=>({...r,y:r.y*2,height:200}));
 assert.equal(sharedBlurRegion(rotated,w,0,0).top,600);
 console.log('Shared blur prototype PASS: cold RN no Canvas/Picture/run extraction, fixed promotion/rotation height, RTL/translation fallback, actual-offset mask/seek/offscreen/rotation geometry.');
}
// Run the actual overlay hooks: scroll frames must never rescan song geometry.
{
 const progModule=load('components/lyrics/native/native-progressive-blur.ts',{
  react:{createContext:value=>({value}),useMemo:fn=>fn()},'react-native-reanimated':{useSharedValue:x=>({value:x}),useAnimatedReaction:()=>{},withTiming:x=>x},
  './native-shared-blur':{},
 });
 const styles=[], timings=[], shared=[];let prepare,react;
 const advance=fraction=>shared.forEach(v=>{if(v.animation)v.current=v.animation.from+(v.animation.to-v.animation.from)*fraction;});
 const modules={react:{createContext:value=>({value})},'react-native':{StyleSheet:{absoluteFill:{}},View:'View'},'expo-blur':{BlurView:'BlurView'},
 '@react-native-masked-view/masked-view':'MaskedView','expo-linear-gradient':{LinearGradient:'LinearGradient'},'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})},
 './native-progressive-blur':progModule,
 'react-native-reanimated':{default:{View:'Animated.View'},__esModule:true,withTiming:(value,config)=>{assert(Number.isFinite(value));timings.push({value,config});return {timing:value};},useSharedValue:value=>{const v={current:value,animation:null,get value(){return this.current;},set value(next){if(next && typeof next==='object' && 'timing' in next)this.animation={from:this.current,to:next.timing};else {this.current=next;this.animation=null;}}};shared.push(v);return v;},useAnimatedStyle:fn=>{styles.push(fn);return {};},useAnimatedReaction:(p,r)=>{prepare=p;react=r;}}};
 const api=load('components/lyrics/native/native-shared-blur.tsx',modules);
 let scans=0;
 const geometry=Array.from({length:1000},(_,i)=>({y:i*100,height:100,start:100000,end:101000}));
 geometry.forEach=function(fn){scans++;Array.prototype.forEach.call(this,fn);};
 const rows={value:geometry},offset={value:0},position={value:0},window={value:{visualActiveLineStartIndex:3,visualActiveLineEndIndex:3,focusLineIndex:3}};
 const seekVersion={value:0};
 api.NativeSharedBlur({target:{current:null},rows,window,position,offset,height:800,seekVersion,deadlines:[98500,100000,101000.001]});
 let previous=prepare();react(previous,null);assert.equal(scans,1);
 for(let frame=0;frame<120;frame++){offset.value=frame*20;position.value=frame;const next=prepare();react(next,previous);previous=next;styles.forEach(fn=>fn());}
 assert.equal(timings.length,0,'initial geometry and direct scroll never animate');
 assert.equal(scans,1,'no song scan in scroll or ordinary playback frames');
 offset.value=0;
 position.value=98500;let next=prepare();react(next,previous);previous=next;assert.equal(scans,2);
 assert.equal(timings.length,0,'unchanged destination does not restart timing');
 window.value={...window.value,visualActiveLineStartIndex:4,visualActiveLineEndIndex:4};next=prepare();react(next,previous);previous=next;
 assert.equal(styles[1]().transform[0].translateY,600,'forward cue protects row 5 immediately via max(animated, target)');
 advance(.5);assert.equal(styles[1]().transform[0].translateY,600);assert.equal(styles[0]().transform[0].translateY,350);
 rows.value=geometry.map(r=>({...r}));next=prepare();react(next,previous);previous=next;
 assert.equal(styles[1]().transform[0].translateY,600,'identical geometry preserves intermediate motion');assert.equal(timings.length,2);
 advance(1.0);
 window.value={...window.value,visualActiveLineStartIndex:3,visualActiveLineEndIndex:3};next=prepare();react(next,previous);previous=next;
 assert.equal(styles[1]().transform[0].translateY,600,'rapid reverse retarget starts at previous position');advance(.5);assert.equal(styles[1]().transform[0].translateY,550);
 offset.value=37;assert.equal(styles[1]().transform[0].translateY,513,'scroll subtracts actual offset during animation');offset.value=0;
 seekVersion.value++;next=prepare();react(next,previous);previous=next;assert.equal(styles[1]().transform[0].translateY,500,'explicit seek initializes immediately');
 position.value=100000;next=prepare();react(next,previous);previous=next;assert.equal(styles[1]().transform[0].translateY,960,'background actual onset retargets and protects, clamped safely');
 position.value=0;seekVersion.value++;next=prepare();react(next,previous);previous=next;
 const missing=geometry.map((r,i)=>i===3?{...r,height:0}:r);
 rows.value=missing;next=prepare();react(next,previous);previous=next;
 const bounded=api.sharedBlurRegion(missing,window.value,0,0);assert.equal(bounded.top,-Infinity,'unknown active bounded opens top safe zone');assert.equal(bounded.bottom,500,'known safe lookahead retained');
 const open=api.sharedBlurRegion([],window.value,0,0);
 assert.deepEqual(plain(api.sharedBlurViewport(open,1e7,800)),{top:-960,bottom:960},'unknown geometry stays open for any offset');
 rows.value=[];next=prepare();react(next,previous);previous=next;
 assert.equal(styles[0]().transform[0].translateY,-960,'track invalidation clears previous mask');
 rows.value=geometry.map(r=>({...r,y:r.y*2,height:200}));position.value=0;next=prepare();react(next,previous);
 offset.value=0;assert.equal(styles[0]().transform[0].translateY,600,'fresh rotation/reuse snapshot replaces stale bounds');
 const exact=createVoiceHarness(currentCode,true,{dev:true,sharedBlur:true,arrivalTrace:trace});
 let tree=exact.render(voice);tree.props.onLayout({nativeEvent:{layout:{width:320}}});tree=exact.render(voice);
 function outerBlur(node){if(!node||typeof node!=='object')return false;const layer=node.props?.layer;if(layer?.props?.children?.type==='Blur')return true;return [node.props?.children].flat().some(outerBlur);}
 assert.equal(outerBlur(tree),false,'experimental exact Skia owner omits outer blur');
 console.log('Dormant shared blur prototype hook checks PASS: 1000 rows/120 frames one scan; approach/geometry updates; missing geometry/track reset/rotation; exact Skia outer blur disabled.');
}
{
 const ts=require('typescript'),source=fs.readFileSync(path.join(__dirname,'../components/lyrics/native/native-lyrics-view.tsx'),'utf8');
 const ast=ts.createSourceFile('view.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let callback;
 let deadlineFactory;
 function deadlineVisit(node){if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='blurDeadlines')deadlineFactory=node.initializer.arguments[0].getText(ast);ts.forEachChild(node,deadlineVisit);}deadlineVisit(ast);
 const makeDeadlines=new Function('rows','sharedBlurEnabled','measuredBlurEnabled',`return (${deadlineFactory})();`);
 assert.deepEqual(makeDeadlines([{lead:{start:2000,end:4000},backgrounds:[{start:2500,end:4500}]}],true),[500,1000,2000,2500,4000.001,4500.001],'actual lead/background starts join protection deadlines');

 function visit(node){if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='refreshBlurGeometry')callback=node.initializer.getText(ast);ts.forEachChild(node,visit);}visit(ast);
 let measured;const cell={lead:{start:10000,end:11000},backgrounds:[{start:8000,end:12000}]};
 const context={useCallback:fn=>fn,sharedBlurEnabled:true,measuredBlurEnabled:false,blurGeometryKey:'song:portrait',setBlurReadyKey:value=>{context.ready=value;},hasBlurGeometry:rows=>rows.length>0&&rows.every(row=>Number.isFinite(row.y)&&Number.isFinite(row.height)&&row.height>0),blurRows:{value:[]},rows:[cell],flashRef:{current:{getLayout:()=>measured,getFirstItemOffset:()=>150}}};
 const refresh=vm.runInNewContext(callback,context);refresh();
 assert.equal(context.blurRows.value[0].height,0,'unmeasured rows stay explicitly unknown');assert.equal(context.ready,'','no safe geometry restores original per-voice blur');
 measured={y:300,height:80};refresh();assert.equal(context.blurRows.value[0].y,450);assert.equal(context.ready,'song:portrait');assert.equal(context.blurRows.value[0].start,8000);
 measured={y:600,height:160};refresh();assert.equal(context.blurRows.value[0].y,750);assert.equal(context.blurRows.value[0].height,160);
 context.rows=[{lead:{start:40000,end:41000},backgrounds:[]}];measured=undefined;refresh();
 assert.equal(context.blurRows.value[0].height,0,'reused content cannot retain old measured height');assert.equal(context.ready,'');
 context.sharedBlurEnabled=true;
 measured={y:600,height:160,isHeightMeasured:false};refresh();assert.equal(context.blurRows.value[0].height,0,'FlashList estimate cannot set protected edge');
 measured.isHeightMeasured=true;refresh();assert.equal(context.blurRows.value[0].height,160);
 context.flashRef.current.getFirstItemOffset=()=>undefined;refresh();assert.equal(context.blurRows.value[0].height,0,'Unknown content origin protects rows');
 const rowSource=fs.readFileSync(path.join(__dirname,'../components/lyrics/native/native-lyric-row.tsx'),'utf8');
 assert(rowSource.includes('onLayout={refreshGeometry}'));assert(rowSource.includes('[refreshGeometry, row]'));
 assert(source.includes('blurRows.value = []'));assert(source.includes('const sharedBlurEnabled = __DEV__ && fastLoading'));
 console.log('Shared geometry refresh PASS: missing/rotation/reuse snapshots, row layout+identity wiring, dormant production gate and invalidation wiring.');
}
// Execute onTextLayout with matching strings and independently altered native
// measurements. These mock coordinates exercise rejection, not phone parity.
{
 const latin={...voice,paintText:'hello\nworld',paintWords:[],translation:''};
 const matching=()=>[{text:'hello',width:40,x:0,y:-1,height:21,ascender:17},{text:'world',width:40,x:0,y:20,height:21,ascender:17}];
 for(const field of ['width','x','y','height','ascender','baseline','missing','skia-width','skia-baseline','within-tolerance']){
  let metricReads=0;
  const h=createVoiceHarness(lazyCode,true,{dev:true,sharedBlur:true,arrivalTrace:trace,lineMetrics:()=>{
   metricReads++;return [0,1].map(i=>({left:0,width:field==='skia-width'?45:40,height:21,baseline:17+i*21+(field==='skia-baseline'?4:0),ascent:17}));
  }});
  let tree=h.render(latin,{prepareGlyphs:false,showTranslation:false});tree.props.onLayout({nativeEvent:{layout:{width:320}}});
  tree=h.render(latin,{prepareGlyphs:false,showTranslation:false});const height=tree.props.style[0].height;
  const lines=matching();
  if(field==='baseline')lines[0].baseline=20;
  else if(field==='missing')delete lines[0].width;
  else if(field==='within-tolerance')lines[0].width+=0.75;
  else if(!field.startsWith('skia-'))lines[0][field]+=4;
  find(tree,'Text').props.onTextLayout({nativeEvent:{lines}});
  const result=h.render(latin,{prepareGlyphs:false,showTranslation:false});
  assert.equal(metricReads,1,'uses paragraph.getLineMetrics from the actual prepared layout');
  assert.equal(!!find(result,'Text'),field==='within-tolerance',field+' metric validation');
  assert.equal(result.props.style[0].height,height,'metric rejection preserves outer geometry');
 }
 const api=load('components/lyrics/native/native-shared-blur.tsx',{
 react:{createContext:value=>({value})},'react-native':{StyleSheet:{},View:'View'},'expo-blur':{},
 '@react-native-masked-view/masked-view':{},'expo-linear-gradient':{},'react-native-reanimated':{},'react/jsx-runtime':{}});
 const rows=Array.from({length:8},(_,i)=>({y:i*100,height:100,start:100000,end:101000}));
 const w={visualActiveLineStartIndex:3,visualActiveLineEndIndex:3,focusLineIndex:3};
 rows[5]={...rows[5],y:0,height:0};
 let region=api.sharedBlurRegion(rows,w,0,0);
 assert.equal(region.top,300);assert.equal(region.bottom,500,'unknown lookahead protected up to real following anchor');
 rows[6]={...rows[6],height:0};rows[7]={...rows[7],height:0};
 region=api.sharedBlurRegion(rows,w,0,0);assert.equal(region.top,300);assert.equal(region.bottom,500);
 assert.equal(api.sharedBlurViewport(region,0,800).top,300,'top distant text still blurred when lower extent unknown');
 rows[3]={...rows[3],y:0,height:0};region=api.sharedBlurRegion(rows,w,0,0);
 assert.equal(region.top,-Infinity,'unknown active never uses guessed zero origin');
 assert.equal(api.hasBlurGeometry([]),false);assert.equal(api.hasBlurGeometry(rows.map(r=>({...r,height:0}))),false);
 assert.equal(api.hasBlurGeometry(rows),false,'partial geometry never enables shared context');
 assert.equal(api.hasBlurGeometry(rows.map((r,i)=>({...r,y:i*100,height:100}))),true);
 console.log('Review regressions PASS: actual metric callback rejects width/x/y/height/baseline differences; tolerance; fixed fallback height; partial missing-lookahead preserves safe blur; no geometry restores fallback; left duet excluded.');
}

// Exact independent-review counterexample, plus actual readiness expression,
// geometry callback and source/layout invalidation guards across transitions.
{
 const api=load('components/lyrics/native/native-shared-blur.tsx',{
 react:{createContext:value=>({value})},'react-native':{StyleSheet:{},View:'View'},'expo-blur':{},
 '@react-native-masked-view/masked-view':{},'expo-linear-gradient':{},'react-native-reanimated':{},'react/jsx-runtime':{}});
 const ts=require('typescript'),source=fs.readFileSync(path.join(__dirname,'../components/lyrics/native/native-lyrics-view.tsx'),'utf8');
 const ast=ts.createSourceFile('view.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 let callback,readiness,trackGuard,layoutGuard;
 function visit(node){
  if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='refreshBlurGeometry')callback=node.initializer.getText(ast);
  if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='sharedBlurReady')readiness=node.initializer.getText(ast);
  if(ts.isIfStatement(node)&&node.expression.getText(ast)==='previousScrollSourceKey.current !== scrollSourceKey')trackGuard=node.getText(ast);
  if(ts.isIfStatement(node)&&node.expression.getText(ast)==='previousLayoutConfiguration.current !== layoutConfiguration')layoutGuard=node.getText(ast);
  ts.forEachChild(node,visit);
 }visit(ast);
 let layouts=[undefined,{y:100,height:100},undefined];
 const rows=[{lead:{start:0,end:9000},backgrounds:[]},{lead:{start:1000,end:9000},backgrounds:[]},{lead:{start:20000,end:21000},backgrounds:[]}];
 const context={useCallback:fn=>fn,sharedBlurEnabled:true,measuredBlurEnabled:false,blurGeometryKey:'A:portrait',blurReadyKey:'',setBlurReadyKey:value=>{context.blurReadyKey=value;},hasBlurGeometry:api.hasBlurGeometry,blurRows:{value:[]},rows,flashRef:{current:{getLayout:i=>layouts[i],getFirstItemOffset:()=>0}}};
 const refresh=vm.runInNewContext(callback,context),ready=()=>vm.runInNewContext(readiness,context);
 refresh();const w={visualActiveLineStartIndex:1,visualActiveLineEndIndex:1,focusLineIndex:1};
 const unsafe=api.sharedBlurRegion(context.blurRows.value,w,1000,0);
 assert.equal(unsafe.top,-Infinity);assert.equal(unsafe.bottom,Infinity,'unmeasured next row opens safe zone to Infinity');
 assert.equal(ready(),false,'two-sided unknown geometry restores original blur, no shared overlay');
 // Cue/seek changes cannot accidentally activate partial geometry.
 for(const index of [0,1,2,1]){api.sharedBlurRegion(context.blurRows.value,{...w,visualActiveLineStartIndex:index,visualActiveLineEndIndex:index,focusLineIndex:index},index*1000,0);assert.equal(ready(),false);}
 layouts=[{y:0,height:100},{y:100,height:100},{y:200,height:100}];refresh();assert.equal(ready(),true);
 for(const index of [0,1,2]){const region=api.sharedBlurRegion(context.blurRows.value,{...w,visualActiveLineStartIndex:index,visualActiveLineEndIndex:index,focusLineIndex:index},index*1000,0);assert(Number.isFinite(region.top)&&Number.isFinite(region.bottom),'all-valid geometry bounds every cue');}
 layouts[2]=undefined;refresh();assert.equal(ready(),false,'losing any geometry restores original blur');
 layouts[2]={y:200,height:100};refresh();assert.equal(ready(),true);
 Object.assign(context,{previousScrollSourceKey:{current:'A'},scrollSourceKey:'B',translationOnlyLayout:{current:true},previousRows:{current:null}});
 vm.runInNewContext(trackGuard,context);context.blurGeometryKey='B:portrait';assert.equal(ready(),false);assert.equal(context.blurRows.value.length,0);
 layouts=[undefined,{y:100,height:100},undefined];refresh();assert.equal(ready(),false,'new track partial geometry stays baseline');
 layouts=[{y:0,height:100},{y:100,height:100},{y:200,height:100}];refresh();assert.equal(ready(),true);
 Object.assign(context,{previousLayoutConfiguration:{current:'portrait'},layoutConfiguration:'landscape'});
 vm.runInNewContext(layoutGuard,context);context.blurGeometryKey='B:landscape';assert.equal(ready(),false);assert.equal(context.blurRows.value.length,0);
 layouts=layouts.map(r=>({y:r.y*2,height:200}));refresh();assert.equal(ready(),true,'complete rotated snapshot re-enables prototype');
 layouts[1]={y:NaN,height:200};refresh();assert.equal(ready(),false,'nonfinite geometry rejected');
 console.log('Two-sided geometry regression PASS: exact three-row counterexample, cue/seek invariance, completeness gain/loss, actual source/layout reset and recovery.');
}
