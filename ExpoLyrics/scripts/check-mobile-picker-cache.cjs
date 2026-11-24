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
 setLyrics(lyrics,source,packet){state.lyrics=lyrics;state.lyricsSource=source;state.packetEnvelope=packet;},setLyricsMetadata(){},setLyricsStatusMessage(){},clearLyrics(){state.lyrics=[];}};
const settings={spicyLyricsPublishableKey:'sl_pk_fixture'};
const client=load('mobile-lyrics-client.ts',{
 '@/lib/mobile-lyrics-service':{...api,createLyricsService(options){
  const service=api.createLyricsService(options),clear=service.clearCache;service.clearCache=()=>{clearCalls++;clear();};return service;
 }},
 '@/lib/mobile-lyrics-vault':{lookupMobileVaultLyrics:async()=>null,startMobileVaultRefresh(){},refreshMobileVault:async()=>{}},
 'react-native':{AppState:{addEventListener(){return {remove(){}};}}},
 '@/lib/mobile-lyrics-settings':{getCachedMobileLyricsSettings:()=>settings,getMobileLyricsSettings:async()=>settings},
 '@/lib/spotify-player-actions':{resolveSpotifyTrackMetadata:async()=>undefined},
 '@/store/playback-store':{usePlaybackStore:{getState:()=>state}},
 '../../DesktopBridge/src/spicyLyricsConfig.json':{publishableKey:''},
 '@/lib/mobile-musixmatch-token':{refreshMobileMusixmatchToken:async()=>'fixture-token',invalidateMobileMusixmatchToken:async()=>{},resolveMobileMusixmatchToken:async()=>'fixture-token'},
});
const sync=load('lyrics-sync.ts',{
 '@/lib/mobile-lyrics-client':client,'@/lib/mobile-lyrics-vault':{saveMobileVaultLyrics:async()=>({})},
 '@/lib/bridge-client':{bridgeClient:new Proxy({}, {get:()=>()=>{bridgeCalls++;}})},
 '@/store/playback-store':{usePlaybackStore:{getState:()=>state}},
});
const packet=(source,text='Fixture')=>({source,metadata:{attribution:{source:'spicy_lyrics'}},lyrics:[{
 lineStartTime:1000,lineEndTime:9000,syllables:[{text,startTime:1000,endTime:9000}],
}]});
(async()=>{
 const late=deferred(),calls=new Map();let spicyCalls=0;
 fetchers['lrc-red']=async track=>{calls.set(track.title,(calls.get(track.title)||0)+1);return packet('lrc-red-line');};
 fetchers['spicy-lyrics']=track=>{spicyCalls++;return track.title===a.title?late.promise:Promise.resolve(null);};
 await sync.refreshLyricsForCurrentTrack();await sync.refreshLyricsForCurrentTrack();
 assert.equal(state.packetEnvelope.metadata.attribution.source,'spicy_lyrics','actual sync caller supplies atomic packet metadata');
 assert.equal(typeof state.packetEnvelope.statusMessage,'string');
 assert.ok(state.packetEnvelope.statusMessage.length>0);
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

 const metadataTrack={...a,id:'metadata',title:'Metadata enrichment',album:'',durationMs:0,spotifyTrackId:'0000000000000000000003'};
 const lower=deferred(),upgrade=deferred(),lrc=deferred();
 for(const key of Object.keys(fetchers))fetchers[key]=async()=>null;
 fetchers['lrc-red']=()=>lrc.promise;
 fetchers.musixmatch=async()=>packet('musixmatch-richsync','First');
 fetchers.lrclib=()=>lower.promise;
 fetchers['spicy-lyrics']=()=>upgrade.promise;
 state.currentTrack=metadataTrack;
 await sync.refreshLyricsForCurrentTrack();
 assert.equal(state.lyricsSource,'musixmatch-richsync|mobile','first valid provider publishes immediately');
 assert.equal(state.lyrics[0].syllables[0].text,'First','first provider payload reaches the store unchanged');
 lrc.resolve(null);lower.resolve(packet('lrclib','Lower'));await flush();
 assert.equal(state.lyricsSource,'musixmatch-richsync|mobile','late lower priority provider cannot downgrade display');
 state.currentTrack={...metadataTrack,album:'Recovered album',durationMs:220000};
 upgrade.resolve(packet('spicy-lyrics-syllable','Upgraded'));await flush();
 assert.equal(state.lyricsSource,'spicy-lyrics-syllable|mobile','same-track metadata enrichment must not orphan superior progressive results');
 assert.equal(state.lyrics[0].syllables[0].text,'Upgraded','superior payload replaces the provisional payload');

 const replacements=[
  {name:'changed Spotify recording',id:'native-spotify',title:'Shared title',artist:'Artist',updatedTitle:'Shared title',updatedArtist:'Artist',oldSpotify:'0000000000000000000004',newSpotify:'0000000000000000000005'},
  {name:'case-only Spotify recording identity',id:'native-spotify-case',title:'Shared title',artist:'Artist',updatedTitle:'Shared title',updatedArtist:'Artist',oldSpotify:'AbCdEfGhIjKlMnOpQrStUv',newSpotify:'abCdEfGhIjKlMnOpQrStUv'},
  {name:'different metadata with identical blank fallback ID',id:'',title:'Old fallback recording',artist:'Old artist',updatedTitle:'New fallback recording',updatedArtist:'New artist',oldSpotify:'',newSpotify:''},
  {name:'native placeholder identity',id:'spotify-connect:',title:'Unknown Track',artist:'',updatedTitle:'Real native recording',updatedArtist:'Real artist',oldSpotify:'',newSpotify:'0000000000000000000006'},
 ];
 for(const item of replacements){
  for(const key of Object.keys(fetchers))fetchers[key]=async()=>null;
  const oldUpgrade=deferred(),newUpgrade=deferred();
  const initial={...a,id:item.id,title:item.title,artist:item.artist,album:'',durationMs:0,spotifyTrackId:item.oldSpotify};
  const updated={...initial,title:item.updatedTitle,artist:item.updatedArtist,album:'Recovered album',durationMs:220000,spotifyTrackId:item.newSpotify};
  const original=track=>track.title===initial.title&&track.artist===initial.artist&&track.spotifyTrackId===initial.spotifyTrackId;
  let firstCalls=0;
  fetchers.musixmatch=async track=>{firstCalls++;return packet('musixmatch-richsync',original(track)?'Old first':'Replacement first');};
  fetchers.kugou=track=>original(track)?oldUpgrade.promise:newUpgrade.promise;
  state.currentTrack=initial;
  await sync.refreshLyricsForCurrentTrack();
  assert.equal(state.lyrics[0].syllables[0].text,'Old first',`${item.name}: initial result`);
  state.currentTrack=updated;
  oldUpgrade.resolve(packet('kugou-krc','Stale upgrade'));await flush();
  assert.equal(state.lyricsSource,'musixmatch-richsync|mobile',`${item.name}: stale upgrade cannot publish`);
  assert.equal(firstCalls,2,`${item.name}: exactly one replacement request`);
  assert.equal(state.lyrics[0].syllables[0].text,'Replacement first',`${item.name}: metadata mismatch starts a newly owned request`);
  newUpgrade.resolve(packet('kugou-krc','Replacement upgrade'));await flush();
  assert.equal(state.lyricsSource,'kugou-krc|mobile',`${item.name}: replacement can upgrade`);
  assert.equal(state.lyrics[0].syllables[0].text,'Replacement upgrade');
 }

 for(const key of Object.keys(fetchers))fetchers[key]=async()=>null;
 const manualUpgrade=deferred();let manualCalls=0;
 const manualTrack={...a,id:'manual',title:'Manual selection'};
 fetchers.musixmatch=async()=>{manualCalls++;return packet('musixmatch-richsync','Manual payload');};
 fetchers['spicy-lyrics']=()=>manualUpgrade.promise;
 state.currentTrack=manualTrack;
 await sync.refreshLyricsForCurrentTrack();
 await sync.refreshLyricsForCurrentTrack('musixmatch',{force:true});
 assert.equal(state.lyricsSource,'musixmatch-richsync|mobile');
 state.currentTrack={...manualTrack,title:'Manual identity changed'};
 const settledManualCalls=manualCalls;
 manualUpgrade.resolve(packet('spicy-lyrics-syllable','Automatic override'));await flush();
 assert.equal(state.lyricsSource,'musixmatch-richsync|mobile','pending automatic work cannot override a manual source');
 assert.equal(manualCalls,settledManualCalls,'stale automatic work cannot schedule another request');

 for(const key of Object.keys(fetchers))fetchers[key]=async()=>null;
 const equalLrc=deferred(),equalSpicy=deferred();
 const equivalentTrack={...a,id:'equivalent',title:'Equivalent recording'};
 fetchers['lrc-red']=()=>equalLrc.promise;
 fetchers['spicy-lyrics']=()=>equalSpicy.promise;
 state.currentTrack=equivalentTrack;
 await sync.refreshLyricsForCurrentTrack();
 equalLrc.resolve(packet('lrc-red-karaoke','Same words'));await flush();
 assert.equal(state.lyricsSource,'lrc-red-karaoke|mobile','lrc.red upgrades the first valid result');
 const apple=packet('spicy-lyrics-syllable','Same words');apple.metadata.attribution={source:'apple_music'};
 equalSpicy.resolve(apple);await flush();
 assert.equal(state.lyricsSource,'lrc-red-karaoke|mobile','equivalent Apple-sourced Spicy syllable cannot displace lrc.red');

 for(const key of Object.keys(fetchers))fetchers[key]=async()=>null;
 const bridgeUpgrade=deferred();let bridgeFirstCalls=0;
 const bridgeTrack={...a,id:'bridge-reconnect',title:'Before reconnect'};
 fetchers.musixmatch=async()=>{bridgeFirstCalls++;return packet('musixmatch-richsync','Mobile first');};
 fetchers['spicy-lyrics']=()=>bridgeUpgrade.promise;
 state.currentTrack=bridgeTrack;state.connectionStatus='disconnected';
 await sync.refreshLyricsForCurrentTrack();
 state.currentTrack={...bridgeTrack,title:'After reconnect'};state.connectionStatus='connected';
 bridgeUpgrade.resolve(packet('spicy-lyrics-syllable','Mobile stale'));await flush();
 assert.equal(state.lyricsSource,'musixmatch-richsync|mobile','bridge ownership rejects stale mobile progress');
 assert.equal(bridgeFirstCalls,1,'bridge reconnect cannot trigger a mobile metadata retry');
 state.connectionStatus='disconnected';
 client.clearMobileLyricsCache();
 console.log('Mobile picker production callers PASS: first/no-downgrade/upgrades, enrichment, strict recording and Spotify identity, blank/native placeholders, manual sticky, lrc.red equivalence, stale and bridge ownership, caches and force. Mocked native boundaries; no device/network claim.');
})().catch(error=>{client.clearMobileLyricsCache();console.error(error);process.exitCode=1;});
