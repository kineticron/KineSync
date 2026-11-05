/* global __dirname */
'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),vm=require('node:vm'),{execFileSync}=require('node:child_process'),{buildSync}=require('esbuild');
const {bundle,createVoiceHarness,currentCode}=require('./check-native-translation-toggle.cjs');
function load(file,modules,dev=true){const module={exports:{}};const code=buildSync({entryPoints:[path.join(__dirname,'..',file)],bundle:true,external:['*'],platform:'node',format:'cjs',write:false}).outputFiles[0].text;vm.runInNewContext(code,{__DEV__:dev,module,exports:module.exports,require:name=>{assert(name in modules,name);return modules[name];}});return module.exports;}
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

// Execute the RN cold branch with the same prepared paragraph and fixed outer height.
{
 const h=createVoiceHarness(lazyCode,true,{dev:true,sharedBlur:true,arrivalTrace:trace});
 const latin={...voice,paintText:'hello\nworld',paintWords:[],translation:''};
 let cold=h.render(latin,{prepareGlyphs:false,showTranslation:false});
 cold.props.onLayout({nativeEvent:{layout:{width:320}}});
 cold=h.render(latin,{prepareGlyphs:false,showTranslation:false});
 assert.equal(find(cold,'Canvas'),null); assert.equal(find(cold,h.NativeGlyphPicture),null);
 assert.equal(find(cold,'Text').props.children,'hello\nworld');
 assert.equal(h.counters.coldRunExtractions,0);
 find(cold,'Text').props.onTextLayout({nativeEvent:{lines:[{text:'hello'},{text:'world'}]}});
 const height=cold.props.style[0].height;
 const promoted=h.render(latin,{prepareGlyphs:true,showTranslation:false});
 assert.equal(promoted.props.style[0].height,height);assert(find(promoted,'Canvas'));
 assert.equal(find(h.render(latin,{prepareGlyphs:false,showTranslation:false,right:true}),'Text'),null);
 assert.equal(find(h.render({...latin,translation:'translation'},{prepareGlyphs:false}),'Text'),null);
 const rotated=h.render(latin,{prepareGlyphs:false,showTranslation:false});
 rotated.props.onLayout({nativeEvent:{layout:{width:640}}});
 const resized=h.render(latin,{prepareGlyphs:false,showTranslation:false});
 assert.equal(resized.props.style[0].height,height);
 find(resized,'Text').props.onTextLayout({nativeEvent:{lines:[{text:'unexpected wrapping'}]}});
 assert.equal(find(h.render(latin,{prepareGlyphs:false,showTranslation:false}),'Text'),null,'incompatible native breaks retain Skia');
}
{
 const {sharedBlurRegion}=load('components/lyrics/native/native-shared-blur.tsx',{
 react:{createContext:value=>({value})},'react-native':{StyleSheet:{},View:'View'},'expo-blur':{},
 '@react-native-masked-view/masked-view':{},'expo-linear-gradient':{},'react-native-reanimated':{},'react/jsx-runtime':{}});
 const rows=Array.from({length:12},(_,i)=>({y:i*100,height:100,start:100000,end:101000}));
 const w={visualActiveLineStartIndex:3,visualActiveLineEndIndex:3,focusLineIndex:3};
 const a=sharedBlurRegion(rows,w,0,0),b=sharedBlurRegion(rows,w,0,137);
 assert.equal(a.top-b.top,137);assert.equal(a.bottom-b.bottom,137);
 assert.equal(a.bottom,696); // active + next two + transition clearance
 assert.equal(sharedBlurRegion([],w,0,0).top,-100000);
 assert(sharedBlurRegion(rows,w,0,2000).bottom<0,'offscreen content stays offscreen');
 assert.equal(sharedBlurRegion(rows,{...w,visualActiveLineStartIndex:7,visualActiveLineEndIndex:7},0,0).top,604);
 const rotated=rows.map(r=>({...r,y:r.y*2,height:200}));
 assert.equal(sharedBlurRegion(rotated,w,0,0).top,504);
 console.log('Shared blur prototype PASS: cold RN no Canvas/Picture/run extraction, fixed promotion/rotation height, RTL/translation fallback, actual-offset mask/seek/offscreen/rotation geometry.');
}
