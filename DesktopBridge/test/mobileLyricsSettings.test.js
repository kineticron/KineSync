'use strict';
// Dependency audit: node builtins, TypeScript transpilation, existing crypto-js,
// actual native settings/token/profile modules with explicit storage/RN mocks.
// No renderer, conversion wrapper, network or playback modules are loaded.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ts=require('../../ExpoLyrics/node_modules/typescript'),CryptoJS=require('../../ExpoLyrics/node_modules/crypto-js');
const root=path.resolve(__dirname,'../../ExpoLyrics/lib');
const flush=async()=>{for(let i=0;i<50;i++)await Promise.resolve();};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const oldToken='revoked-native-token-value-12345',stamp=100_000_000;
function load(storage,now=()=>stamp){
 const cache=new Map();
 function evaluate(file){
  if(cache.has(file))return cache.get(file);
  const module={exports:{}};
  const source=ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const mocks={
   '@react-native-async-storage/async-storage':storage.async,'expo-secure-store':storage.secure,'react-native':{Platform:{OS:storage.platform || 'ios'}},
   'crypto-js':CryptoJS,
  };
  vm.runInNewContext(source,{module,exports:module.exports,AbortController,setTimeout,clearTimeout,
   Date:class extends Date{static now(){return now();}},console:{warn(){}},fetch:storage.fetch,
   require:name=>{
    if(name==='@/lib/mobile-lyrics-settings')return evaluate('mobile-lyrics-settings.ts');
    if(name==='./musixmatch-profile')return evaluate('musixmatch-profile.js');
    assert(Object.hasOwn(mocks,name),`Unexpected dependency ${name}`);return mocks[name];
   }},{filename:file});cache.set(file,module.exports);return module.exports;
 }
 return {settings:evaluate('mobile-lyrics-settings.ts'),tokens:()=>evaluate('mobile-musixmatch-token.ts')};
}
function storage(){
 let disk=JSON.stringify({musixmatchAnonymousUserToken:oldToken,musixmatchAnonymousAppId:'mac-ios-v2.0',musixmatchAnonymousProfileId:'mac-ios-v2.0@apic-appmobile',musixmatchAnonymousFetchedAt:stamp-1000});
 const writes=[];let blocked=true,reads=0,plaintextWrites=0,fetches=0;
 return {
  writes,get reads(){return reads;},get disk(){return JSON.parse(disk);},get fetches(){return fetches;},get plaintextWrites(){return plaintextWrites;},
  unblock(){blocked=false;},
  async:{async getItem(){reads++;return null;},async removeItem(){},async setItem(){plaintextWrites++;}},
  secure:{async getItemAsync(){return disk;},setItemAsync(key,value){
   const gate=deferred();writes.push({value:JSON.parse(value),release(){disk=value;gate.resolve();}});
   if(!blocked){disk=value;gate.resolve();}return gate.promise;
  }},
  async fetch(){fetches++;return {ok:true,status:200,json:async()=>({message:{header:{status_code:200},body:{user_token:oldToken}}})};},
 };
}
test('actual native settings serialize rejection with concurrent token/Spotify writes and reject resurrection after restart',async()=>{
 const disk=storage(),app=load(disk);const [initial]=await Promise.all([app.settings.getMobileLyricsSettings(),app.settings.getMobileLyricsSettings()]);
 assert.equal(disk.reads,1,'cold initialization is singleflight');
 const revoked=app.tokens().invalidateMobileMusixmatchToken(oldToken);await flush();
 assert.equal(disk.writes.length,1);assert.equal(disk.writes[0].value.musixmatchAnonymousRejectedTokenHashes.length,1);
 const spotify=app.settings.saveMobileLyricsSettings({spotifyWebToken:'replacement-spotify-token'});
 // A stale full form snapshot must not erase revocation history either.
 const stale=app.settings.saveMobileLyricsSettings({...initial,geminiApiKey:'fixture-key'});
 await flush();assert.equal(disk.writes.length,1,'later writes cannot overtake the blocked secure write');
 disk.writes[0].release();await revoked;await flush();assert.equal(disk.writes.length,2);
 assert.equal(disk.writes[1].value.spotifyWebToken,'replacement-spotify-token');
 assert.equal(disk.writes[1].value.musixmatchAnonymousRejectedTokenHashes.length,1,'partial Spotify save merges with latest revocation state');
 disk.writes[1].release();await spotify;await flush();assert.equal(disk.writes.length,3);
 disk.writes[2].release();await stale;
 assert.equal(disk.disk.musixmatchAnonymousRejectedTokenHashes.length,1);
 assert.match(disk.disk.musixmatchAnonymousRejectedTokenHashes[0],/^[a-f0-9]{64}$/);
 assert.equal(disk.plaintextWrites,0);
 disk.unblock();const restarted=load(disk,()=>stamp+21*60_000);
 assert.equal(await restarted.tokens().resolveMobileMusixmatchToken(),'','revoked A cannot be reissued after restart/cooldown');
 assert.equal(disk.fetches,1);assert.equal(disk.disk.musixmatchAnonymousUserToken,'');
 assert.equal(disk.disk.musixmatchAnonymousRejectedTokenHashes.length,1);
});
test('native settings queue continues after a secure write failure without plaintext fallback or hash loss',async()=>{
 const disk=storage();let fail=true;
 const persist=disk.secure.setItemAsync;
 disk.secure.setItemAsync=(key,value)=>{if(fail){fail=false;return Promise.reject(Error('secure store unavailable'));}return persist(key,value);};
 disk.unblock();const app=load(disk);
 await app.tokens().invalidateMobileMusixmatchToken(oldToken);
 await app.settings.saveMobileLyricsSettings({spotifyWebToken:'replacement'});
 assert.equal(disk.disk.musixmatchAnonymousRejectedTokenHashes.length,1);
 assert.equal(disk.plaintextWrites,0);
});

for (const platform of ['web','ios']) test(`${platform}: failed persistence is acknowledged and next save retries`, async()=>{
 const disk=storage();disk.platform=platform;disk.unblock();
 let fail=true;
 if(platform==='web') disk.async.setItem=async()=>{if(fail)throw Error('disk unavailable');};
 else disk.secure.setItemAsync=async()=>{if(fail)throw Error('secure unavailable');};
 const app=load(disk);
 const first=await app.settings.saveMobileLyricsSettings({geminiApiKey:'memory-key'});
 assert.equal(first.persistence,'memory','volatile settings cannot claim durable success');
 assert.equal(app.settings.getCachedMobileLyricsSettings().geminiApiKey,'memory-key');
 fail=false;
 const second=await app.settings.saveMobileLyricsSettings({spotifyWebToken:'restored'});
 assert.equal(second.persistence,'durable');assert.equal(second.geminiApiKey,'memory-key');
 assert.equal(disk.plaintextWrites,0);
});
test('initial read failure is retried without overwriting unread settings or pending memory edits',async()=>{
 const disk=storage();disk.unblock();let fail=true;
 disk.async.getItem=async()=>{if(fail)throw Error('initial read unavailable');return null;};
 const app=load(disk);
 const first=await app.settings.saveMobileLyricsSettings({geminiApiKey:'pending'});
 assert.equal(first.persistence,'memory');assert.equal(disk.writes.length,0,'do not overwrite unread storage');
 fail=false;
 const second=await app.settings.saveMobileLyricsSettings({spotifyWebToken:'restored'});
 assert.equal(second.persistence,'durable');assert.equal(second.geminiApiKey,'pending');
 assert.equal(second.musixmatchAnonymousUserToken,oldToken,'retry retains fields from restored disk');
});
test('pending rejection hashes remain monotonic across consecutive read failures and recovered load',async()=>{
 const disk=storage();disk.unblock();let fail=true;
 disk.async.getItem=async()=>{if(fail)throw Error('read unavailable');return null;};
 const app=load(disk), a='a'.repeat(64),b='b'.repeat(64);
 await app.settings.saveMobileLyricsSettings({musixmatchAnonymousRejectedTokenHashes:[a]});
 await app.settings.saveMobileLyricsSettings({musixmatchAnonymousRejectedTokenHashes:[b]});
 assert.deepEqual(Array.from(app.settings.getCachedMobileLyricsSettings().musixmatchAnonymousRejectedTokenHashes),[a,b]);
 fail=false;
 const recovered=await app.settings.saveMobileLyricsSettings({spotifyWebToken:'recovered'});
 assert.deepEqual(Array.from(recovered.musixmatchAnonymousRejectedTokenHashes),[a,b],'recovered read cannot drop an earlier pending rejection');
 assert.deepEqual(disk.disk.musixmatchAnonymousRejectedTokenHashes,[a,b]);
});
