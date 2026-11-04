/* global __dirname */
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const {buildSync} = require('esbuild');
const code = buildSync({entryPoints:[path.join(__dirname,'../components/lyrics/native/native-geometry-cache.ts')],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text;
const mod={exports:{}};vm.runInNewContext(code,{module:mod,exports:mod.exports});
const cache=mod.exports.createNativeGeometryCache(2,100),fonts={},otherFonts={};let builds=0;
const make=()=>({id:++builds,dispose(){throw Error('live handle disposed');}});
const a=cache.get(fonts,['amll',320.125,{text:'क्‍ष',timing:[0,10]}],20,make);
assert.equal(cache.get(fonts,['amll',320.125,{text:'क्‍ष',timing:[0,10]}],20,make),a);
assert.notEqual(cache.get(fonts,['amll',320.126,{text:'क्‍ष',timing:[0,10]}],20,make),a);
cache.get(fonts,['spicy',320.125],20,make);assert.equal(cache.size,2);assert.equal(a.id,1);
assert.notEqual(cache.get(otherFonts,['spicy',320.125],20,make),cache.get(fonts,['spicy',320.125],20,make));
const start=builds;
for(const key of [[undefined],[null],[-0],[0],[{a:undefined}],[{}]]) cache.get(fonts,key,20,make);
assert.equal(builds-start,6);assert.equal(cache.size,2);
cache.get(fonts,['oversized'],101,make);assert.equal(cache.size,2);assert.ok(cache.weight<=100);
console.log('Exact cache invalidation, fractional width, font ownership, bounds and retained handles passed.');
// Execute actual baseline/candidate components in the same invocation with
// identical native mocks. Counts prove work reduction, never native latency.
const {execFileSync}=require('node:child_process');
const {bundle,createVoiceHarness,currentCode}=require('./check-native-translation-toggle.cjs');
const sha='0b3c5ce31492146095d6537ed40b6894f0f5f45a';
const baseline=bundle(execFileSync('git',['show',`${sha}:ExpoLyrics/components/lyrics/native/native-skia-voice.tsx`],{encoding:'utf8'}));
const voice={start:0,end:1000,words:[{text:'क्‍ष ffi 👩‍🚀',starts:[0],ends:[1000],weights:[3]}],paintText:'क्‍ष ffi 👩‍🚀',paintWords:[{text:'क्‍ष ffi 👩‍🚀',offset:0,start:0,end:1000,letters:['क्‍ष',' ','f','f','i',' ','👩‍🚀'],emphasized:true,joined:false}]};
function find(node,type){if(!node||typeof node!=='object')return null;if(node.type===type)return node;for(const child of [node.props?.children].flat()){const result=find(child,type);if(result)return result;}return null;}
function measure(source,cacheModule){
 const totals={mountedVoices:0,paragraphConstructors:0,shapeCalls:0,maskPictureInputs:0},outputs=[];const fonts={};
 for(const [spicy,width] of [[false,320.125],[true,320.125],[false,320.125],[false,640.25],[false,320.125],[true,320.125]]){
  const h=createVoiceHarness(source,spicy,{fonts,geometryCache:cacheModule});totals.mountedVoices++;
  let tree=h.render(JSON.parse(JSON.stringify(voice)));tree.props.onLayout({nativeEvent:{layout:{width}}});tree=h.render(JSON.parse(JSON.stringify(voice)));
  const glyph=find(tree,h.NativeGlyphPicture);assert.ok(glyph);
  outputs.push(JSON.parse(JSON.stringify({height:tree.props.style[0].height,words:glyph.props.words})));
  totals.paragraphConstructors+=h.counters.paragraphBuilds;totals.shapeCalls+=h.counters.glyphShapePasses;totals.maskPictureInputs+=h.counters.spicyGlyphPictures;
 }
 return {totals,outputs};
}
const before=measure(baseline),after=measure(currentCode,{nativeGeometryCache:mod.exports.createNativeGeometryCache()});
assert.deepEqual(after.outputs,before.outputs,'hit/miss preserve drawing inputs and heights');
assert.ok(after.totals.shapeCalls<before.totals.shapeCalls);assert.ok(after.totals.paragraphConstructors<before.totals.paragraphConstructors);
console.log(JSON.stringify({method:'same-process component execution; mocked native hosts; fresh mounts, style switches and rotation returns',baseline:sha,before:before.totals,after:after.totals,dynamicPictureBuilds:'not measured by component mock; unchanged picture implementation'},null,2));
