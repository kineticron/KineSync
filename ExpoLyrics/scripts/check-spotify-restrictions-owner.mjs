import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
async function loadProtocol(dev) {
 const compiled=await build({
  stdin:{contents:`
   export {sampleFrom,sampleWithContext} from './lib/spotify-detector/protocol';
   ${dev ? `
    export {startTimingCapture,clearTimingCapture,timingCaptureActive} from './lib/spotify-detector/timing-diagnostics';
    export {developmentTimingActive} from './lib/spotify-detector/development-timing-log';
   ` : ''}
  `,resolveDir:fileURLToPath(new URL('..', import.meta.url))},
  bundle:true,platform:'node',format:'esm',write:false,minifySyntax:true,define:{__DEV__:String(dev)},
 });
 const source=compiled.outputFiles[0].text;
 if(!dev)assert.doesNotMatch(source,/timing-diagnostics|development-timing-log|timingProvenance|startTimingCapture/);
 return import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
}
const release=await loadProtocol(false);
const development=await loadProtocol(true);
assert.equal('startTimingCapture' in release,false);
const uri='spotify:track:4uLU6hMCjMI75M1A2tKUQC';
const leaf=()=>({track:{uri},position_as_of_timestamp:1000,is_playing:true,timestamp:1900000000000});
const malformed=()=>({position_as_of_timestamp:1000,is_playing:true,restrictions:{disallow_pausing_reasons:['rejected']}});
let passed=0,failed=0;
function check(name,fn){try{fn();passed++;console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+e.message);}}
function selected(api,value,player,owner,device,mode){
 const result=api.sampleWithContext(value);
 assert.ok(result);
 assert.equal(result.playerState,player,'selected player identity');
 assert.equal(result.cluster,owner,'selected owner identity');
 assert.equal(result.sample.activeDeviceId,device,'owner device override');
 assert.equal(Object.hasOwn(result.sample,'timingProvenance'),mode.capture,'capture branch was exercised');
 assert.equal(Object.hasOwn(result.sample,'developmentTiming'),mode.dev,'development branch was exercised');
 const ordinary=api.sampleFrom(value);
 assert.equal(ordinary.uri,result.sample.uri);
 assert.equal(ordinary.activeDeviceId,result.sample.activeDeviceId);
}
for(const mode of [{name:'release',capture:false,dev:false},{name:'development',capture:false,dev:true},{name:'development with capture',capture:true,dev:true}]){
  const api=mode.dev?development:release;
  if(mode.capture)api.startTimingCapture();
  try{
   assert.equal(api.timingCaptureActive?.()??false,mode.capture);
   assert.equal(api.developmentTimingActive?.()??false,mode.dev);
   check(mode.name+' malformed explicit child then recognizable owner leaf has no successful owner',()=>{
    const root={...leaf(),active_device_id:'rejected-owner',player_state:malformed()};
    selected(api,root,root,undefined,undefined,mode);
   });
   check(mode.name+' malformed explicit child then generic fallback leaf cannot inherit failed owner',()=>{
    const player=leaf(),root={active_device_id:'rejected-owner',player_state:malformed(),data:player};
    selected(api,root,player,undefined,undefined,mode);
   });
   check(mode.name+' malformed first sibling then valid explicit sibling owns selected state',()=>{
    const player=leaf(),owner={active_device_id:'selected-phone',player_state:player,devices:{'selected-phone':{is_restricted:false}}};
    const root={payloads:[{active_device_id:'rejected-owner',player_state:malformed()},owner]};
    selected(api,root,player,owner,'selected-phone',mode);
   });
   check(mode.name+' nested explicit wrappers outer device override also overrides restriction owner',()=>{
    const player=leaf(),inner={active_device_id:'inner',player_state:player,devices:{inner:{is_restricted:true}}};
    const outer={active_device_id:'outer',player_state:inner,devices:{outer:{is_restricted:false}}};
    selected(api,outer,player,outer,'outer',mode);
   });
  }finally{api.clearTimingCapture?.();}
}
console.log('selected-owner trace: '+passed+' passed, '+failed+' failed');
process.exitCode=failed?1:0;
