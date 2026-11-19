import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { gzipSync, gunzipSync } from 'node:zlib';
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const require = createRequire(root + '/package.json');
const { build } = require('esbuild');
const built = await build({stdin:{contents:`export {SpotifyDetector} from './lib/spotify-detector/client';
export {decodeCluster} from './lib/spotify-detector/binary';
export {decodeDealer,decodeStateBody,sampleFrom} from './lib/spotify-detector/protocol';`,resolveDir:root},bundle:true,platform:'node',format:'esm',write:false});
const {SpotifyDetector,decodeCluster,decodeDealer,decodeStateBody,sampleFrom} = await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
// Verified librespot dev player.proto PlayerState.restrictions=17,
// Restrictions repeated-string fields 1,2,3,6,7,14,22.
// connect.proto Cluster active_device_id=2, player_state=3, server_timestamp_ms=9;
// ClusterUpdate.cluster=1. No production sources are changed.
const varint = n => {const out=[]; do {const b=n%128;n=Math.floor(n/128);out.push(b|(n?128:0));}while(n);return Buffer.from(out);};
const num=(id,n)=>Buffer.concat([varint(id*8),varint(n)]);
const bytes=(id,b)=>{b=typeof b==='string'?Buffer.from(b):b;return Buffer.concat([varint(id*8+2),varint(b.length),b]);};
const epoch=1800000000000, uri='spotify:track:4uLU6hMCjMI75M1A2tKUQC';
const fixture=(reasons=[],paused=false,extraRestrictions=[])=>Buffer.concat([
 bytes(2,'fixture-phone'),bytes(3,Buffer.concat([
 num(1,epoch),bytes(7,bytes(1,uri)),num(10,1000),num(11,200000),
 num(12,1),num(13,paused?1:0),bytes(17,Buffer.concat(reasons.map(([id,reason])=>bytes(id,reason)))),...extraRestrictions.map(group=>bytes(17,Buffer.concat(group.map(([id,reason])=>bytes(id,reason))))),bytes(23,'fixture-session')
 ])),num(9,epoch)]);
const wrapped=raw=>({uri:'hm://connect-state/v1/cluster',headers:{'transfer-encoding':'gzip'},payloads:[gzipSync(bytes(1,raw)).toString('base64')]});
const names={1:'disallow_pausing_reasons',2:'disallow_resuming_reasons',3:'disallow_seeking_reasons',6:'disallow_skipping_prev_reasons',7:'disallow_skipping_next_reasons',14:'disallow_remote_control_reasons',22:'disallow_playing_reasons'};
const scenarios=[
 {name:'normal-playing-not_paused',reasons:[[2,'not_paused']],blocked:['resume']},
 {name:'previous-only',reasons:[[6,'no_prev_track']],blocked:['prev']},
 {name:'remote-control-blanket',reasons:[[14,'remote_control_disallowed']],blocked:['pause','resume','prev','next','seek']},
 {name:'remote-control-blanket-paused',reasons:[[14,'remote_control_disallowed']],paused:true,blocked:['pause','resume','prev','next','seek']},
 {name:'duplicate-field17-remote-then-prev',reasons:[[14,'remote_control_disallowed']],extraRestrictions:[[[6,'no_prev_track']]],blocked:['pause','resume','prev','next','seek']},
 {name:'duplicate-field17-remote-then-prev-paused',reasons:[[14,'remote_control_disallowed']],extraRestrictions:[[[6,'no_prev_track']]],paused:true,blocked:['pause','resume','prev','next','seek']},
 {name:'playing-only-paused',reasons:[[22,'playing_disallowed']],paused:true,blocked:['resume']},
 {name:'playing-only-playing',reasons:[[22,'playing_disallowed']],blocked:['resume']},
 {name:'all-wire-fields',reasons:[[1,'pause'],[2,'resume'],[3,'seek'],[6,'prev'],[7,'next']],blocked:['pause','resume','prev','next','seek']}
];
let pass=0,fail=0;
async function test(name,fn){try{await fn();pass++;console.log('PASS '+name);}catch(e){fail++;console.log('FAIL '+name+' '+e.message);}}
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
async function setup(raw,transport){
 let socket; const posts=[], samples=[];let id=0;const timers=new Map();
 const runtime={wall:()=>epoch+1000,mono:()=>1000,random:()=>0.3,
 setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimeout:i=>timers.delete(i),
 setInterval:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearInterval:i=>timers.delete(i),
 socket:()=>socket={readyState:1,send(){},close(){this.readyState=3;},event(value){this.onmessage?.({data:JSON.stringify(value)});}},
 fetch:async(url,options)=>{
  if(options.method==='POST')posts.push(JSON.parse(gunzipSync(Buffer.from(options.body)).toString()));
  const body=options.method==='PUT'?(transport==='registration'?raw:fixture()):Buffer.alloc(0);
  return {ok:true,status:200,headers:new Headers(),arrayBuffer:async()=>Uint8Array.from(body).buffer};
 }};
 const d=new SpotifyDetector({sample:s=>samples.push(s),status(){},ready(){},authenticated(){},sessionNeeded(){}},runtime);
 const capture=e=>d.capture(JSON.stringify(e),'https://open.spotify.com/');
 d.setEnabled(true);
 capture({type:'observerEndpoint',url:'https://guc3-spclient.spotify.com/connect-state/v1/devices/test-observer'});
 capture({type:'socket',url:'wss://dealer.spotify.com/'});
 capture({type:'credentials',token:'fixture',authenticated:true,expiresAt:epoch+3600000});
 socket.onopen?.();
 socket.event({headers:{'Spotify-Connection-Id':'fixture-connection'}});
 await flush();
 if(transport==='dealer-gzip-base64'){socket.event(wrapped(raw));await flush();}
 assert.equal(d.health.phase,'ready','fixture must establish real ready authority');
 assert.equal(samples.at(-1)?.uri,uri,'sample integration');
 return {d,posts};
}
for(const transport of ['registration','dealer-gzip-base64']){
 for(const s of scenarios){
  const raw=fixture(s.reasons,s.paused,s.extraRestrictions);
  await test(transport+'/'+s.name+'/decode',()=>{
   const decoded=transport==='registration'?decodeStateBody(raw):decodeDealer(wrapped(raw)).payloads[0].cluster;
   assert.equal(sampleFrom(decoded)?.playing,!s.paused);
   assert.equal(decodeCluster(raw).active_device_id,'fixture-phone');
   for(const [field,reason] of [...s.reasons,...(s.extraRestrictions??[]).flat()])assert.deepEqual(decoded.player_state.restrictions?.[names[field]],[reason],names[field]+' must survive wire decoding');
  });
  for(const op of ['pause','resume','prev','next','seek']){
   // toggle selects pause when playing and resume when paused, so cover each with its corresponding state.
   if(op==='pause'&&s.paused || op==='resume'&&!s.paused)continue;
   await test(transport+'/'+s.name+'/'+op,async()=>{
    const {d,posts}=await setup(raw,transport);
    try{
     const expected=!s.blocked.includes(op);
     const healthOp=op==='prev'?'previous':op;
     const actual=d.health.allowed[healthOp];
     const command=op==='pause'||op==='resume'?{type:'toggle'}:op==='prev'?{type:'previous'}:op==='seek'?{type:'seek',positionMs:2000}:{type:'next'};
     let error;try{await d.control(command);}catch(e){error=e;}
     assert.equal(actual,expected,'allowed.'+healthOp);
     assert.equal(posts.length,expected?1:0,'control POST count');
     if(expected){assert.equal(error,undefined);assert.equal(posts[0].command.endpoint,{pause:'pause',resume:'resume',prev:'skip_prev',next:'skip_next',seek:'seek_to'}[op]);}
     else assert.equal(error?.reason,'restricted','blocked control reason');
    }finally{d.clear();}
   });
  }
 }
}
console.log(JSON.stringify({pass,fail,total:pass+fail}));
process.exitCode=fail?1:0;
