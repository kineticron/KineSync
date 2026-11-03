// Real provider/parser + Zustand store + transition host. Network/native boundaries are mocks.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {build}=require('esbuild');
const {harness,context,opacity}=require('./check-lyrics-packet-transition.cjs');
const root=path.resolve(__dirname,'..');
(async()=>{
 const bundle=await build({stdin:{resolveDir:root,contents:`
 export { fetchFromLrcRed } from './lib/mobile-lyrics-service';
 export { usePlaybackStore } from './store/playback-store';
 export * from './lib/lyrics-arrival-trace';`},bundle:true,platform:'node',format:'cjs',write:false,define:{__DEV__:'true'},plugins:[{name:'test-boundaries',setup(b){
 b.onLoad({filter:/mobile-lyrics-service\.js$/},args=>({contents:fs.readFileSync(args.path,'utf8')+'\nexport {fetchFromLrcRed};',resolveDir:path.dirname(args.path)}));
 b.onResolve({filter:/^(@react-native-async-storage\/async-storage|expo-secure-store|expo-constants|react-native)$/},args=>({path:args.path,namespace:'native'}));
 b.onLoad({filter:/.*/,namespace:'native'},args=>({contents:args.path==='react-native'?'export const AppState={currentState:"background",addEventListener:()=>({remove(){}})};export const Platform={OS:"web"};':'export default {getItem:async()=>null,setItem:async()=>{}};export const getItemAsync=async()=>null;export const setItemAsync=async()=>{};export const deleteItemAsync=async()=>{};'}));
 }}]});
 const pending=new Map();let mono=0;
 const module={exports:{}};
 vm.runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require,Buffer,TextDecoder,TextEncoder,URL,AbortController,
  performance:{now:()=>++mono},setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},
  console:{log(){},warn(){},debug(){},error(){}},process:{env:{NODE_ENV:'test'}},
  fetch:async url=>({ok:true,status:200,json:async()=>({}),text:()=>new Promise(resolve=>pending.set(String(url),resolve))})});
 const api=module.exports,store=api.usePlaybackStore;
 const track=isrc=>({title:'Arrival fixture',artist:'Fixture',durationMs:10000,isrc});
 const body=word=>`<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="0s" end="2s"><span begin="0s" end="1s">${word}</span><span begin="1s" end="2s"> phrase</span></p></div></body></tt>`;
 const wait=async count=>{for(let i=0;i<100&&pending.size<count;i++)await Promise.resolve();assert.equal(pending.size,count,'provider reached actual asynchronous body continuations');};
 const resolve=(id,text)=>{const key=[...pending.keys()].find(key=>key.includes(id));assert.ok(key);pending.get(key)(body(text));pending.delete(key);};
 api.startArrivalCapture();store.setState({currentTrack:{id:'song'},lyrics:[],lyricsSource:''});
 const transition=harness(false,true,{store,reuseSameSourcePackets:true});transition.render();
 const a=api.fetchFromLrcRed(track('USAAA2000001')),b=api.fetchFromLrcRed(track('USAAA2000002'));await wait(2);
 resolve('USAAA2000002','SECOND_SENTINEL');const rb=await b;
 const parentB=api.arrivalHandle(rb.lyrics);assert.ok(parentB);
 store.getState().setLyrics(rb.lyrics,rb.source);
 const enrichedB=store.getState().lyrics, hb=api.arrivalHandle(enrichedB);
 assert.notEqual(enrichedB,rb.lyrics);assert.equal(hb.parentPacket,parentB.packet);
 let layers=transition.render();context(layers.at(-1)).onReady();transition.render();layers=transition.finish();
 const outgoing=context(layers[0]),staleReady=outgoing.onReady;
 assert.equal(api.arrivalHandle(outgoing.packet.lyrics).packet,hb.packet);
 resolve('USAAA2000001','FIRST_SENTINEL');const ra=await a;const parentA=api.arrivalHandle(ra.lyrics);
 assert.notEqual(parentA.packet,parentB.packet);
 store.getState().setLyrics(ra.lyrics,'alternate-provider');const ha=api.arrivalHandle(store.getState().lyrics);
 assert.equal(ha.parentPacket,parentA.packet);assert.equal(ha.source,'alternate-provider');
 layers=transition.render();assert.equal(layers.length,2);
 assert.equal(api.arrivalHandle(context(layers[0]).packet.lyrics).packet,hb.packet);
 assert.equal(api.arrivalHandle(context(layers[1]).packet.lyrics).packet,ha.packet);
 staleReady();layers=transition.render();assert.equal(opacity(layers[1]),0,'old ready callback cannot reveal new source');
 context(layers[1]).onReady();transition.render();layers=transition.finish();assert.equal(layers.length,1);
 const layerKey=layers[0].key;
 store.getState().setLyrics(rb.lyrics,'alternate-provider');layers=transition.render();
 const revision=api.arrivalHandle(context(layers[0]).packet.lyrics);
 assert.equal(layers[0].key,layerKey,'same-source native updates retain transition layer');
 assert.notEqual(revision.packet,ha.packet);assert.equal(revision.parentPacket,parentB.packet);
 assert.equal(api.arrivalHandle(outgoing.packet.lyrics).packet,hb.packet,'frozen old packet keeps its own owner');
 const trace=api.snapshotArrivalCapture();
 for(const parent of [parentA,parentB])for(const stage of ['response-rn-continuation','body-rn-continuation','parser'])assert.ok(trace.records.some(r=>r.packet===parent.packet&&r.stage===stage));
 for(const handle of [ha,hb,revision])assert.ok(trace.records.some(r=>r.packet===handle.packet&&r.stage==='store-enrichment'));
 assert.ok(!JSON.stringify(trace).includes('SENTINEL'),'trace never contains lyric payload text');
 const c=api.fetchFromLrcRed(track('USAAA2000003'));await wait(1);api.startArrivalCapture();
 resolve('USAAA2000003','STALE_SENTINEL');const rc=await c;
 assert.equal(api.arrivalHandle(rc.lyrics),undefined,'old provider result cannot attach to a new capture');
 assert.equal(api.snapshotArrivalCapture().records.length,0);
 store.getState().setLyrics(rc.lyrics,rc.source);
 assert.equal(api.arrivalHandle(store.getState().lyrics).parentPacket,undefined);
 console.log('actual async provider/parser, store enrichment and transition correlation passed: reordered bodies, parent/publication links, outgoing ownership, stale ready, same-source revisions and capture reset; mocked network/native only');
})().catch(error=>{console.error(error);process.exitCode=1;});
