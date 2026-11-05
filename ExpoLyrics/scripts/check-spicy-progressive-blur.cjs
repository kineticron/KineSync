/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { buildSync } = require('esbuild');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const rowPath = 'components/lyrics/native/native-lyric-row.tsx';
function radiusFactory(source) {
 const ast = ts.createSourceFile('row.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
 let body; function visit(node) { if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='blurValue') body=node.initializer.arguments[0].body.getText(ast); ts.forEachChild(node,visit); }
 visit(ast);assert(body);
 return new Function('row','presentationWindow','rowActive','staticLyrics','spicy','progressiveBlur','measuredBlurRadius','withTiming','Easing','fastLoading = true',body);
}
let reaction, previous;
const cells=[];
const shared=initial=>{let value=initial;const cell={animation:null,get value(){return value;},set value(next){if(next?.timing){cell.animation={from:value,to:next.target};}else{value=next;cell.animation=null;}},advance(fraction){value=this.animation.from+(this.animation.to-this.animation.from)*fraction;}};cells.push(cell);return cell;};
const modules={react:{createContext:value=>({value}),useMemo:fn=>fn()},'react-native-reanimated':{useSharedValue:shared,useAnimatedReaction:(prepare,apply)=>{reaction=()=>{const next=prepare();apply(next,previous);previous=next;};},withTiming:(target,options)=>{assert.equal(options.duration,240);return {timing:true,target};}}};
const code=buildSync({entryPoints:[path.join(root,'components/lyrics/native/native-progressive-blur.ts')],bundle:true,external:['*'],platform:'node',format:'cjs',write:false}).outputFiles[0].text;
const moduleObject={exports:{}};vm.runInNewContext(code,{module:moduleObject,exports:moduleObject.exports,require:name=>{assert(name in modules,name);return modules[name];}});
const api=moduleObject.exports;
const rows=shared([
 {y:0,height:84,start:1000,end:2000},
 // Entire three-wrap next semantic row, including its translation block.
 {y:84,height:230,start:2000,end:3000},
 {y:314,height:90,start:3000,end:4000},
 {y:404,height:110,start:4000,end:5000},
 {y:514,height:100,start:5000,end:6000},
 {y:614,height:100,start:6000,end:7000},
]);
const window=shared({focusLineIndex:0,visualActiveLineStartIndex:0,visualActiveLineEndIndex:0});
const position=shared(1500),seek=shared(0);
const context=api.useMeasuredProgressiveBlur(true,rows,window,position,seek,[1000,2000,3000,4000,5000,6000]);
reaction();assert.equal(context.protection.value.bottom,314);assert.equal(context.anchor.value,314);
const rowFactory=radiusFactory(process.env.SPICY_SOURCE_REV ? execFileSync('git',['show',`${process.env.SPICY_SOURCE_REV}:ExpoLyrics/${rowPath}`],{cwd:root,encoding:'utf8'}) : read(rowPath));
const output=index=>rowFactory({index},window,{value:index>=window.value.visualActiveLineStartIndex&&index<=window.value.visualActiveLineEndIndex},false,true,context,api.measuredBlurRadius,x=>x,{bezier(){}});
assert.equal(output(0),0);assert.equal(output(1),0,'Whole wrapped+translated next row is sharp');
assert.equal(output(2),0,'Ramp starts at measured protected bottom, no fixed clearance');
assert.equal(output(3),90/80);assert.equal(output(4),200/80);
rows.value=rows.value.map((row,i)=>({...row,y:row.y+(i>1?70:0),height:row.height+(i===1?70:0)}));
reaction();assert.equal(context.protection.value.bottom,384,'Translation/extra wrapping moves actual boundary by measured 70 points');
context.anchor.advance(0.5);assert.equal(context.anchor.value,349);assert.equal(output(1),0);
assert.equal(output(3),(474-349)/80,'Effective Gaussian output reads interpolated anchor');
const retained=context.anchor.animation;rows.value=rows.value.map(row=>({...row}));reaction();assert.equal(context.anchor.animation,retained,'Identical geometry never restarts motion');
// Multiple active rows: protect after last, never after first.
window.value={focusLineIndex:0,visualActiveLineStartIndex:0,visualActiveLineEndIndex:2};reaction();
assert.equal(context.protection.value.index,3);assert.equal(context.protection.value.bottom,584);assert.equal(output(3),0);
context.anchor.advance(0.5);assert.equal(context.anchor.value,466.5);
assert.equal(output(4),0,'Ramp remains below whole current protected row during interpolation');
assert.equal(output(5),(684-466.5)/80);
// Reverse cue retargets the current anchor, and the effective radius follows it.
const overlappingWindow=window.value;
window.value={...window.value,visualActiveLineEndIndex:0};reaction();
assert.equal(context.anchor.value,466.5,'Reverse retarget preserves current animated position');
assert.equal(output(3),(474-466.5)/80);
context.anchor.advance(0.5);assert.equal(context.anchor.value,425.25);
assert.equal(output(3),(474-425.25)/80,'Reverse midpoint changes effective Gaussian radius');
window.value=overlappingWindow;reaction();

seek.value++;reaction();assert.equal(context.anchor.value,584,'Explicit seek resets to measured edge');
assert.equal(output(4),0);
// Intro dots belong to upcoming row 0, even when visual active is empty.
rows.value=rows.value.map((row,i)=>({...row,interlude:i===0?{start:0,end:1000}:undefined}));
window.value={focusLineIndex:0,visualActiveLineStartIndex:-1,visualActiveLineEndIndex:-1};position.value=500;seek.value++;reaction();
assert.equal(context.protection.value.index,0);assert.equal(context.anchor.value,84);assert.equal(output(0),0);
// Actual overlapping voice beyond the visual range extends protection to latest.
position.value=4500;reaction();assert.equal(context.protection.value.index,4);
// Unknown protected geometry never invents an edge or inherits the old song's.
rows.value=rows.value.map((row,i)=>({...row,height:i===4?0:row.height}));reaction();
assert.equal(context.protection.value.bottom,Infinity);assert.equal(output(5),0);
rows.value=rows.value.map((row,i)=>({...row,height:i===4?100:row.height}));reaction();assert.equal(context.anchor.value,684,'Recovery initializes safely');
// Actual voice intervals, rather than the enclosing lead/background envelope.
const isolated=rows.value.map((row,i)=>({...row,voices:i===4?[{start:0,end:100},{start:9000,end:10000}]:[{start:row.start,end:row.end}]}));
assert.equal(api.measuredProtection(isolated,window.value,4500).index,4,'Inactive gap in later row does not extend protection');
rows.value=[];reaction();assert.equal(output(5),0,'Track/layout invalidation protects all unknown rows');

// Original OFF baseline remains byte-for-byte equivalent in executed closure outputs.
for(const revision of ['7729a20','3791c00']){
 const original=execFileSync('git',['show',`${revision}:ExpoLyrics/${rowPath}`],{cwd:root,encoding:'utf8'});
 const oldFactory=radiusFactory(original);
 for(let index=0;index<10;index++){
  const args=[{index},window,{value:false},false,true,null,api.measuredBlurRadius,x=>x,{bezier(){}}];
  assert.equal(rowFactory(...args),oldFactory(...args));
 }
}
const host=read('components/lyrics/native/native-lyrics-view.tsx');
assert.match(host,/const sharedBlurEnabled = false;/);
assert.match(host,/geometry.isHeightMeasured/,'Estimated FlashList heights cannot become measured protection');
assert.match(host,/NativeProgressiveBlurContext.Provider value=\{progressiveBlur\}/);
console.log('Measured Spicy blur PASS: multiwrap+translation edge, dots, last overlapping/actual active voice, unknown geometry, seek/recovery, effective animated Gaussian output, original OFF differential. Source/hook execution; no device proof.');
