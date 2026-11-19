const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const vm = require('node:vm');
const path = require('node:path');
const code = ts.transpileModule(fs.readFileSync(path.join(__dirname,'../lib/spotify-detector/reachability.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
const flush = async () => { for(let i=0;i<10;i++) await Promise.resolve(); };
async function main() {
  let module = null;
  const exports = {};
  vm.runInNewContext(code,{exports,require:name=>{assert.equal(name,'expo-modules-core');return {requireOptionalNativeModule:name=>{assert.equal(name,'ExpoNetwork');return module;}};}});
  const unknown=[];exports.subscribeSpotifyReachability(h=>unknown.push(h))();assert.deepEqual(unknown,['unknown']);
  assert.equal(exports.networkHint({isConnected:false}),'offline');assert.equal(exports.networkHint({isConnected:true}),'unknown');assert.equal(exports.networkHint({isConnected:true,isInternetReachable:true}),'online');assert.equal(exports.networkHint({isInternetReachable:false}),'offline');
  let resolve, listener, removed=0;
  module={getNetworkStateAsync:()=>new Promise(r=>{resolve=r;}),addListener:(event,fn)=>{assert.equal(event,'onNetworkStateChanged');listener=fn;return {remove:()=>removed++};}};
  const states=[];const stop=exports.subscribeSpotifyReachability(h=>states.push(h));listener({isConnected:false});resolve({isConnected:true,isInternetReachable:true});await flush();assert.deepEqual(states,['unknown','offline'],'late initial query must not overwrite new native hint');stop();listener({isConnected:true,isInternetReachable:true});assert.equal(states.length,2);assert.equal(removed,1);
  module={getNetworkStateAsync:()=>Promise.reject(Error('unsupported')),addListener:()=>{throw Error('missing');}};
  const failed=[];exports.subscribeSpotifyReachability(h=>failed.push(h))();await flush();assert(failed.every(h=>h==='unknown'));
  console.log('Spotify reachability passed: actual adapter, missing module unknown fallback, native hints, stale query ordering and disposal; no new native dependency.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
