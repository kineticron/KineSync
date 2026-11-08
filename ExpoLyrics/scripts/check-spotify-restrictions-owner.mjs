import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
// Exercise the selected player/owner identity with timing diagnostics on and off.
// No protocol substitutions, syntax workarounds, production edits or flag mocks.
const compiled=await build({stdin:{contents:`
 export {sampleFrom,sampleWithContext} from './lib/spotify-detector/protocol';
 export {startTimingCapture,clearTimingCapture,timingCaptureActive} from './lib/spotify-detector/timing-diagnostics';
 export {developmentTimingActive} from './lib/spotify-detector/development-timing-log';
`,resolveDir:fileURLToPath(new URL('..', import.meta.url))},bundle:true,platform:'node',format:'esm',write:false});
const api=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const originalDev=Object.getOwnPropertyDescriptor(globalThis,'__DEV__');
const uri='spotify:track:4uLU6hMCjMI75M1A2tKUQC';
const leaf=()=>({track:{uri},position_as_of_timestamp:1000,is_playing:true,timestamp:1900000000000});
const malformed=()=>({position_as_of_timestamp:1000,is_playing:true,restrictions:{disallow_pausing_reasons:['rejected']}});
let passed=0,failed=0;
function check(name,fn){try{fn();passed++;console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+e.message);}}
function selected(value,player,owner,device,mode){
 const result=api.sampleWithContext(value);
 assert.ok(result);
 assert.equal(result.playerState,player,'selected player identity');
 assert.equal(result.cluster,owner,'selected owner identity');
 assert.equal(result.sample.activeDeviceId,device,'owner device override');
 assert.equal(!!result.sample.timingProvenance,mode.capture,'capture branch was exercised');
 assert.equal(!!result.sample.developmentTiming,mode.dev,'development branch was exercised');
 const ordinary=api.sampleFrom(value);
 assert.equal(ordinary.uri,result.sample.uri);
 assert.equal(ordinary.activeDeviceId,result.sample.activeDeviceId);
}
try{
 for(const mode of [{name:'off',capture:false,dev:false},{name:'capture',capture:true,dev:false},{name:'development',capture:false,dev:true},{name:'both',capture:true,dev:true}]){
  api.clearTimingCapture();
  Object.defineProperty(globalThis,'__DEV__',{value:mode.dev,writable:true,configurable:true});
  if(mode.capture)api.startTimingCapture();
  try{
   assert.equal(api.timingCaptureActive(),mode.capture);
   assert.equal(api.developmentTimingActive(),mode.dev);
   check(mode.name+' malformed explicit child then recognizable owner leaf has no successful owner',()=>{
    const root={...leaf(),active_device_id:'rejected-owner',player_state:malformed()};
    selected(root,root,undefined,undefined,mode);
   });
   check(mode.name+' malformed explicit child then generic fallback leaf cannot inherit failed owner',()=>{
    const player=leaf(),root={active_device_id:'rejected-owner',player_state:malformed(),data:player};
    selected(root,player,undefined,undefined,mode);
   });
   check(mode.name+' malformed first sibling then valid explicit sibling owns selected state',()=>{
    const player=leaf(),owner={active_device_id:'selected-phone',player_state:player,devices:{'selected-phone':{is_restricted:false}}};
    const root={payloads:[{active_device_id:'rejected-owner',player_state:malformed()},owner]};
    selected(root,player,owner,'selected-phone',mode);
   });
   check(mode.name+' nested explicit wrappers outer device override also overrides restriction owner',()=>{
    const player=leaf(),inner={active_device_id:'inner',player_state:player,devices:{inner:{is_restricted:true}}};
    const outer={active_device_id:'outer',player_state:inner,devices:{outer:{is_restricted:false}}};
    selected(outer,player,outer,'outer',mode);
   });
  }finally{api.clearTimingCapture();}
 }
}finally{
 api.clearTimingCapture();
 if(originalDev)Object.defineProperty(globalThis,'__DEV__',originalDev);else delete globalThis.__DEV__;
}
console.log('selected-owner trace: '+passed+' passed, '+failed+' failed');
process.exitCode=failed?1:0;
