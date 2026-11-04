/* global __dirname */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module'),{execFileSync}=require('node:child_process');
const repo=path.resolve(__dirname,'../..'),src=path.join(repo,'DesktopBridge/src'),part='DesktopBridge/src/lyrics/parts/07b-service-orchestration.js';
const baseline=execFileSync('git',['show',`b8342083c617a56cebe18822ce589ce12a34d515:${part}`],{cwd:repo,encoding:'utf8'});
const plain=x=>JSON.parse(JSON.stringify(x));
const track={trackId:'fixture',title:'Example',artist:'Artist',durationMs:9000};
function load(old){
 let saved;const copies={stringify:0,parse:0};const countedJSON=Object.create(JSON);for(const name of Object.keys(copies))countedJSON[name]=(...args)=>{copies[name]++;return JSON[name](...args);};const nativeRequire=createRequire(path.join(src,'lyricsService.js'));
 const vault={getLyricsVaultStore:()=>({save(input){saved=input;return {metadata:{},ok:true};}}),resolveVaultSourceLabel:()=> 'lrc-red-karaoke'};
 const context=vm.createContext({JSON:countedJSON,AbortController,Buffer,TextDecoder,URL,URLSearchParams,Date:class extends Date{static now(){return 1800000000000;}},setTimeout,clearTimeout,setInterval,clearInterval,global:{},process:{env:{}},console:{log(){},warn(){},debug(){},error(){}},module:{exports:{}},require:name=>name==='./lyricsVault'?vault:nativeRequire(name),fetch(){throw Error('unexpected network');}});
 const expose=text=>text.replace('  return {\n    setActiveTrack,','  return {\n    __copy: cloneSourceCachePacket, __remember: rememberSourceLyrics, __base: getSourceBase,\n    setActiveTrack,');
 const index=fs.readFileSync(path.join(src,'lyrics/index.js'),'utf8');for(const match of index.match(/const partFiles = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)){const text=match[1]==='07b-service-orchestration.js'&&old?baseline:fs.readFileSync(path.join(src,'lyrics/parts',match[1]),'utf8');vm.runInContext(expose(text),context);}
 vm.runInContext('buildLyricsMatchTrack = async track => track',context);
 const service=vm.runInContext('createLyricsService()',context);return {service,context,copies,get saved(){return saved;}};
}
function fixture(){const lyrics=[{lineStartTime:1000,lineEndTime:9000,ttmlKey:'a',syllables:[{text:'क्‍ष',startTime:1000,endTime:4000,graphemes:['क्‍ष']}],backgroundSyllables:[{text:'bg',startTime:2000,endTime:5000}],spicyBackgrounds:[{lineStartTime:2000,lineEndTime:8000,syllables:[{text:'duet',startTime:2000,endTime:8000}]}]}];lyrics.translationMeta={provider:'source',targetLanguage:'English'};return {source:'lrc-red-karaoke',statusMessage:'fixture',lyrics,metadata:{matchedTrack:{title:'Example',isrc:'fixture'},vault:{vaultId:'fixture'},spicyVariantTitles:['Example','Alternate'],credits:{songwriters:['Writer']},spicyApi:{fetchedAt:1,expiresAt:1800000100000},attribution:{provider:'lrc.red',maker:{username:'maker'}},translation:{provider:'source'},ttml:{content:'<tt/>',translationTracks:[{language:'en',type:'subtitle',lines:[{key:'a',text:'English text'}]},{language:'es',type:'subtitle',lines:[{key:'a',text:'Texto español'}]}]}}};}
async function scenario(old){
 const h=load(old),s=h.service,input=fixture(),original=plain(input);s.setActiveTrack(track.trackId);s.__remember(track.trackId,'lrc-red',input);
 const base=s.__base(track.trackId,'lrc-red');assert.deepEqual(plain(base),original);
 assert.equal(h.copies.stringify,old?3:0,'cache copy executes zero serialization');assert.equal(h.copies.parse,old?3:0);
 input.lyrics[0].syllables[0].text='changed';input.lyrics[0].spicyBackgrounds[0].syllables[0].text='changed';input.lyrics[0].syllables[0].graphemes.push('changed');input.metadata.ttml.translationTracks[0].lines[0].text='changed';input.metadata.credits.songwriters.push('changed');input.metadata.spicyVariantTitles.push('changed');input.metadata.matchedTrack.title='changed';input.metadata.vault.vaultId='changed';input.metadata.attribution.maker.username='changed';input.lyrics.translationMeta.provider='changed';
 assert.deepEqual(plain(base),original,'cache owns nested timing and supported metadata');
 const english=s.getCachedSourceLyricsPacket(track.trackId,'lrc-red','English'),spanish=s.getCachedSourceLyricsPacket(track.trackId,'lrc-red','Spanish');
 assert.equal(english.lyrics[0].translatedText,'English text');assert.equal(spanish.lyrics[0].translatedText,'Texto español');assert.equal(base.lyrics[0].translatedText,undefined);
 const output=[plain(english),plain(spanish)];
 await s.saveCurrentLyricsToVault(track,base.lyrics,{includeTranslations:true,source:base.source,metadata:base.metadata});
 assert.equal(base.lyrics.translationMeta.provider,'source','save enrichment must not change cached array metadata');
 assert.equal(base.lyrics[0].translatedText,undefined);assert.equal(h.saved.lyrics.translationMeta.provider,'Gemini');
 output.push(plain(h.saved));
 await s.saveCurrentLyricsToVault(track,base.lyrics,{includeTranslations:false,source:base.source,metadata:base.metadata});assert.equal(h.saved.lyrics.translationMeta.provider,'source');output.push(plain(h.saved));
 if(!old){const copy=s.__copy(base);assert.equal(copy.lyrics[0].syllables,base.lyrics[0].syllables,'owned immutable timing is reused');assert.notEqual(copy.lyrics[0],base.lyrics[0]);assert.notEqual(copy.metadata.translation,base.metadata.translation);assert.ok(Object.isFrozen(copy.lyrics[0].spicyBackgrounds[0].syllables));
 english.lyrics[0].translatedText='consumer choice';english.metadata.ttml.translationTracks[0].lines[0].text='consumer edit';assert.equal(s.getCachedSourceLyricsPacket(track.trackId,'lrc-red','English').lyrics[0].translatedText,'English text');
 }
 s.clearCache();return output;
}
(async()=>{assert.deepEqual(await scenario(false),await scenario(true),'actual service packet/language/save outputs equal JSON-clone baseline');
 // Execute generated mobile service too; shared sections must regenerate exactly.
 const {generate}=require('./sync-lyrics-picker.cjs'),mobile=fs.readFileSync(path.join(repo,'ExpoLyrics/lib/mobile-lyrics-service.js'),'utf8');assert.equal(generate(mobile),mobile);
 const context=vm.createContext({AbortController,Buffer,TextDecoder,URL,URLSearchParams,setTimeout,clearTimeout,setInterval,clearInterval,global:{},require:createRequire(path.join(repo,'ExpoLyrics/lib/mobile-lyrics-service.js')),console:{log(){},warn(){},debug(){},error(){}}});
 const text=mobile.replace(/^import .*;\r?\n/gm,'');vm.runInContext(text.slice(0,text.indexOf('export {')).replace('  return {\n    setActiveTrack,','  return {\n    __remember: rememberSourceLyrics,\n    setActiveTrack,'),context);const service=vm.runInContext('createLyricsService()',context);service.setActiveTrack('mobile');service.__remember('mobile','lrc-red',fixture());assert.equal(service.getCachedSourceLyricsPacket('mobile','lrc-red','Spanish').lyrics[0].translatedText,'Texto español');service.clearCache();
 console.log('Service ownership PASS: actual canonical baseline/candidate differential packet/language/save execution; input/cache isolation for lead/background/graphemes/TTML/credits/profiles; owned timing reused and frozen; cached response COW isolation; generated mobile execution and regeneration parity. No recursive clone or serialization on copy path.');
})().catch(error=>{console.error(error);process.exitCode=1;});
