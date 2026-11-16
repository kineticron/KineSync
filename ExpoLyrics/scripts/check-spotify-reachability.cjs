const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const vm = require('node:vm');
const path = require('node:path');
const code = ts.transpileModule(fs.readFileSync(path.join(__dirname,'../lib/spotify-detector/reachability.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
const flush = async () => { for(let i=0;i<10;i++) await Promise.resolve(); };
function load(getModule, sandbox = {}) {
  const exports = {};
  vm.runInNewContext(code,{exports,...sandbox,require:name=>{assert.equal(name,'expo-modules-core');return {requireOptionalNativeModule:name=>{assert.equal(name,'ExpoNetwork');return getModule();}};}});
  return exports;
}
async function main() {
  let module = null;
  let exports = load(()=>module);
  const unknown=[];exports.subscribeSpotifyReachability((...a)=>unknown.push(a))();assert.deepEqual(unknown,[['unknown',undefined]]);
  assert.equal(exports.networkHint({isConnected:false}),'offline');assert.equal(exports.networkHint({isConnected:true}),'unknown');assert.equal(exports.networkHint({isConnected:true,isInternetReachable:true}),'online');assert.equal(exports.networkHint({isInternetReachable:false}),'offline');
  assert.equal(exports.networkPath('wifi'),'WIFI');assert.equal(exports.networkPath('CELLULAR'),'CELLULAR');assert.equal(exports.networkPath('NONE'),undefined);assert.equal(exports.networkPath(undefined),undefined);
  // stale initial query must not overwrite a newer event; duplicates suppressed; WIFI->CELLULAR both online; dispose
  let resolve, listener, removed=0;
  module={getNetworkStateAsync:()=>new Promise(r=>{resolve=r;}),addListener:(event,fn)=>{assert.equal(event,'onNetworkStateChanged');listener=fn;return {remove:()=>removed++};}};
  let states=[];let stop=exports.subscribeSpotifyReachability((...a)=>states.push(a));
  listener({type:'WIFI',isConnected:true,isInternetReachable:true});
  resolve({type:'CELLULAR',isConnected:false});await flush();
  assert.deepEqual(states,[['unknown',undefined],['online','WIFI']],'late initial query must not overwrite new native hint');
  listener({type:'WIFI',isConnected:true,isInternetReachable:true});assert.equal(states.length,2,'duplicate suppressed');
  listener({type:'CELLULAR',isConnected:true,isInternetReachable:true});assert.deepEqual(states[2],['online','CELLULAR']);
  stop();listener({type:'WIFI',isConnected:false});assert.equal(states.length,3);assert.equal(removed,1);
  // initial query ordering: query result used when no event arrived
  module={getNetworkStateAsync:()=>Promise.resolve({type:'wifi',isConnected:true,isInternetReachable:true}),addListener:()=>({remove(){}})};
  states=[];exports.subscribeSpotifyReachability((...a)=>states.push(a));await flush();assert.deepEqual(states,[['unknown',undefined],['online','WIFI']]);
  // dispose before query resolves
  let late;module={getNetworkStateAsync:()=>new Promise(r=>{late=r;}),addListener:()=>({remove(){}})};
  states=[];exports.subscribeSpotifyReachability((...a)=>states.push(a))();late({type:'WIFI',isConnected:true,isInternetReachable:true});await flush();assert.equal(states.length,1);
  // failing module
  module={getNetworkStateAsync:()=>Promise.reject(Error('unsupported')),addListener:()=>{throw Error('missing');}};
  const failed=[];exports.subscribeSpotifyReachability((...a)=>failed.push(a))();await flush();assert(failed.every(a=>a[0]==='unknown'&&a[1]===undefined));
  // missing module, no browser globals (React Native stock): unknown only
  module=null;states=[];stop=exports.subscribeSpotifyReachability((...a)=>states.push(a));stop();assert.deepEqual(states,[['unknown',undefined]]);
  // missing module, browser fallback
  const handlers={},connHandlers={};const nav={onLine:true,connection:{type:'wifi',addEventListener:(e,f)=>{connHandlers[e]=f;},removeEventListener:e=>{delete connHandlers[e];}}};
  const sb={navigator:nav,addEventListener:(e,f)=>{handlers[e]=f;},removeEventListener:e=>{delete handlers[e];}};
  exports=load(()=>null,sb);states=[];stop=exports.subscribeSpotifyReachability((...a)=>states.push(a));
  assert.deepEqual(states,[['unknown',undefined],['online','WIFI']]);
  nav.connection.type='cellular';connHandlers.change();assert.deepEqual(states[2],['online','CELLULAR']);
  connHandlers.change();assert.equal(states.length,3,'duplicate');
  nav.onLine=false;handlers.offline();assert.deepEqual(states[3],['offline','CELLULAR']);
  stop();assert.deepEqual(Object.keys(handlers),[]);assert.deepEqual(Object.keys(connHandlers),[]);nav.onLine=true;
  console.log('Spotify reachability passed: ExpoNetwork path hints, WIFI to CELLULAR, duplicate/stale/dispose, missing module fallback; no new native dependency.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
