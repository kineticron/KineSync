/* global __dirname */
'use strict';
// Audited: actual generated service and transpiled client/sync. Explicit native
// storage/vault/store/bridge mocks; no renderer, conversion wrapper or network.
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), vm=require('node:vm');
const ts=require('typescript'), {createRequire}=require('node:module');
const {Buffer}=require('node:buffer');
const lib=path.resolve(__dirname,'../lib'), quiet={log(){},debug(){},warn(){},error(){}};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const flush=async()=>{for(let n=0;n<40;n++)await Promise.resolve();};
const core=vm.createContext({AbortController,Buffer,TextDecoder,URL,URLSearchParams,console:quiet,
 setTimeout,clearTimeout,setInterval,clearInterval,global:{},require:createRequire(path.join(lib,'mobile-lyrics-service.js')),
 CryptoJS:require('crypto-js'),pako:require('pako'),fetch(){throw Error('Unexpected network');}});
const source=fs.readFileSync(path.join(lib,'mobile-lyrics-service.js'),'utf8').replace(/^import .*;\r?\n/gm,'');
vm.runInContext(source.slice(0,source.indexOf('export {')),core);
const api=vm.runInContext('({createLyricsService,fetchFromSpicyLyrics,isLikelySameTrack})',core);
const fetchers=vm.runInContext('SOURCE_FETCHERS',core);
for(const key of Object.keys(fetchers))fetchers[key]=async()=>null;
function load(file,mocks){
 const module={exports:{}};
 const code=ts.transpileModule(fs.readFileSync(path.join(lib,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},fileName:file}).outputText;
 vm.runInNewContext(code,{module,exports:module.exports,console:quiet,process:{env:{}},setTimeout,clearTimeout,require:name=>{
  assert(Object.hasOwn(mocks,name),`Unexpected dependency ${name}`);return mocks[name];
 }},{filename:file});return module.exports;
}
const a={id:'a',title:'Example A',artist:'Artist',album:'Album',durationMs:10000,spotifyTrackId:'0000000000000000000001'};
const b={...a,id:'b',title:'Example B',spotifyTrackId:'0000000000000000000002'};
let bridgeCalls=0,clearCalls=0;
const state={currentTrack:a,connectionStatus:'disconnected',translationLanguage:'English',lyrics:[],lyricsSource:'',
 setLyrics(lyrics,source){state.lyrics=lyrics;state.lyricsSource=source;},setLyricsMetadata(){},setLyricsStatusMessage(){},clearLyrics(){state.lyrics=[];}};
const settings={spicyLyricsPublishableKey:'sl_pk_fixture'};
const client=load('mobile-lyrics-client.ts',{
 '@/lib/mobile-lyrics-service':{...api,createLyricsService(options){
  const service=api.createLyricsService(options),clear=service.clearCache;service.clearCache=()=>{clearCalls++;clear();};return service;
 }},
 '@/lib/mobile-lyrics-vault':{lookupMobileVaultLyrics:async()=>null,startMobileVaultRefresh(){},refreshMobileVault:async()=>{}},
 'react-native':{AppState:{addEventListener(){return {remove(){}};}}},
 '@/lib/mobile-lyrics-settings':{getCachedMobileLyricsSettings:()=>settings,getMobileLyricsSettings:async()=>settings},
 '@/store/playback-store':{usePlaybackStore:{getState:()=>state}},
 '../../DesktopBridge/src/spicyLyricsConfig.json':{publishableKey:''},
 '@/lib/mobile-musixmatch-token':{refreshMobileMusixmatchToken:async()=>'',resolveMobileMusixmatchToken:async()=>''},
});
const sync=load('lyrics-sync.ts',{
 '@/lib/mobile-lyrics-client':client,'@/lib/mobile-lyrics-vault':{saveMobileVaultLyrics:async()=>({})},
 '@/lib/bridge-client':{bridgeClient:new Proxy({}, {get:()=>()=>{bridgeCalls++;}})},
 '@/store/playback-store':{usePlaybackStore:{getState:()=>state}},
});
const packet=source=>({source,metadata:{attribution:{source:'spicy_lyrics'}},lyrics:[{
 lineStartTime:1000,lineEndTime:9000,syllables:[{text:'Fixture',startTime:1000,endTime:9000}],
}]});
(async()=>{
 const late=deferred(),calls=new Map();let spicyCalls=0;
 fetchers['lrc-red']=async track=>{calls.set(track.title,(calls.get(track.title)||0)+1);return packet('lrc-red-line');};
 fetchers['spicy-lyrics']=track=>{spicyCalls++;return track.title===a.title?late.promise:Promise.resolve(null);};
 await sync.refreshLyricsForCurrentTrack();await sync.refreshLyricsForCurrentTrack();
 assert.equal(calls.get(a.title),1);assert.equal(spicyCalls,1,'real mobile caller shares a pending flight');
 state.currentTrack=b;await sync.refreshLyricsForCurrentTrack();
 assert.equal(clearCalls,0,'track changes retain bounded identity-specific caches');
 late.resolve(packet('spicy-lyrics-syllable'));await flush();
 assert.equal(state.lyricsSource,'lrc-red-line|mobile','old-track progress cannot overwrite current track');
 state.currentTrack=a;await sync.refreshLyricsForCurrentTrack();
 assert.equal(calls.get(a.title),1,'A -> B -> A reuses final A selection through real client and sync');
 assert.equal(state.lyricsSource,'spicy-lyrics-syllable|mobile');
 await sync.refreshLyricsForCurrentTrack('auto',{force:true});
 assert.equal(calls.get(a.title),2,'explicit user refresh retains force bypass');
 state.currentTrack={...a,durationMs:11000};await sync.refreshLyricsForCurrentTrack();
 assert.equal(calls.get(a.title),3,'changed recording metadata cannot reuse old cache');
 assert.equal(bridgeCalls,0,'mobile cache operations never send playback/bridge commands');
 client.clearMobileLyricsCache();
 console.log('Mobile picker production callers PASS: pending dedup, A/B/A cache, stale progress, force, metadata identity. Mocked native boundaries; no device/network claim.');
})().catch(error=>{client.clearMobileLyricsCache();console.error(error);process.exitCode=1;});
