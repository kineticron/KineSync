import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
const bundle = await build({ stdin: { contents: `export * from './lib/spotify-detector/client'; export {bootstrap} from './lib/spotify-detector/bootstrap'; export * from './lib/spotify-detector/health';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { SpotifyDetector, bootstrap, spotifyHealthMessage } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const flush = async () => { for (let n = 0; n < 60; n++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
const uri = 'spotify:track:4uLU6hMCjMI75M1A2tKUQC';
const state = (device = 'phone', track = uri, timestamp = 1900000000000) => ({ active_device_id: device, player_state: { timestamp, position_as_of_timestamp: 1000, duration: 100000, is_playing: true, track: { uri: track } } });
class Clock {
  mono = 0; wall = 1900000000000; next = 0; timers = new Map();
  set = (fn, ms, interval = false) => { const id = ++this.next; this.timers.set(id, { fn, at: this.mono + ms, interval: interval ? ms : 0 }); return id; };
  clear = id => this.timers.delete(id);
  async advance(ms) {
    const end = this.mono + ms;
    for (;;) {
      const entry = [...this.timers].filter(([,t]) => t.at <= end).sort((a,b) => a[1].at-b[1].at || a[0]-b[0])[0];
      if (!entry) break;
      const [id,t] = entry; const elapsed=t.at-this.mono; this.mono=t.at; this.wall+=elapsed;
      if (t.interval) t.at+=t.interval; else this.timers.delete(id);
      t.fn(); await flush();
    }
    this.wall+=end-this.mono; this.mono=end; await flush();
  }
}
function setup() {
  const clock=new Clock(), sockets=[], requests=[], health=[], samples=[];
  let needed=0, response = { status: 200, body: state() };
  class Socket {
    readyState=0; sent=[];
    constructor(url){this.url=url;sockets.push(this);}
    send(value){this.sent.push(value);}
    close(){this.readyState=3;} // intentionally never emits native close
    open(){this.readyState=1;this.onopen?.();}
    event(value){this.onmessage?.({data:JSON.stringify(value)});}
  }
  const runtime={wall:()=>clock.wall,mono:()=>clock.mono,random:()=>0.5,
    socket:url=>new Socket(url), setTimeout:(fn,ms)=>clock.set(fn,ms),clearTimeout:clock.clear,
    setInterval:(fn,ms)=>clock.set(fn,ms,true),clearInterval:clock.clear,
    fetch:async (url,options)=>{
      requests.push({url,...options});
      const r=typeof response==='function'?await response(url,options):response;
      return { status:r.status, ok:r.status>=200&&r.status<300, headers:new Headers(r.headers),
        arrayBuffer:async()=> r.bodyPromise ? await r.bodyPromise : new TextEncoder().encode(JSON.stringify(r.body??{})).buffer };
    }};
  const d=new SpotifyDetector({sample:s=>samples.push(s),status(){},sessionNeeded:()=>needed++,authenticated(){},ready(){},health:h=>health.push(h)},runtime);
  const capture=e=>d.capture(JSON.stringify(e),'https://open.spotify.com/');
  const credentials=(token='valid')=>capture({type:'credentials',authenticated:true,token,expiresAt:clock.wall+3600000});
  const start=()=>{d.setEnabled(true);capture({type:'observerEndpoint',url:'https://spclient.spotify.com/connect-state/v1/devices/observer'});capture({type:'socket',url:'wss://dealer.spotify.com/'});credentials();};
  const identify=async(id=`id-${sockets.length}`)=>{const ws=sockets.at(-1);ws.open();ws.event({headers:{'Spotify-Connection-Id':id}});await flush();return ws;};
  const posts=()=>requests.filter(r=>r.method==='POST');
  return {d,clock,sockets,requests,health,samples,capture,credentials,start,identify,posts,set response(r){response=r;},get needed(){return needed;}};
}
let cases=0;
async function check(name,fn){await fn();cases++;console.log(`PASS ${name}`);}
async function allDisabled(h){const n=h.posts().length;for(const type of ['toggle','next','previous','seek'])await assert.rejects(h.d.control({type,positionMs:20}));assert.equal(h.posts().length,n);}
await check('background detaches silent socket; old callbacks and cached replay cannot enable controls',async()=>{
 const h=setup();h.start();const ws=await h.identify();const late=ws.onmessage;assert(h.d.health.controlsEnabled);
 h.d.setEnabled(false);assert.equal(h.clock.timers.size,0);h.d.setEnabled(true);assert.equal(h.sockets.length,2);await allDisabled(h);
 late({data:JSON.stringify({payloads:[state()]})});assert.equal(h.d.health.observerConfirmed,false);await h.identify();assert(h.d.health.controlsEnabled);h.d.clear();
});
await check('expiry across suspended timers renews once; repeated fresh-token 401 stops at sign-in',async()=>{
 const h=setup();h.start();await h.identify();h.d.setEnabled(false);h.clock.wall+=4000000;h.clock.mono+=4000000;h.d.setEnabled(true);
 assert.equal(h.d.health.phase,'renewingSession');const needed=h.needed;h.d.setEnabled(true);assert.equal(h.needed,needed);await allDisabled(h);
 h.credentials('fresh');h.response={status:401};await h.identify();assert.equal(h.d.health.phase,'renewingSession');
 h.credentials('fresh2');await h.identify();assert.equal(h.d.health.phase,'signInRequired');await h.clock.advance(120000);assert.equal(h.d.health.phase,'signInRequired');h.d.clear();
});
await check('renewal episode has hard deadline and backoff for network stalls; explicit anonymous needs sign-in',async()=>{
 const h=setup();h.d.setEnabled(true);await h.clock.advance(45000);assert.equal(h.d.health.phase,'retryWait');await h.clock.advance(2000+45000);assert.equal(h.d.health.phase,'retryWait');assert.equal(h.d.health.attempt,2);h.d.clear();
 const a=setup();a.d.setEnabled(true);a.capture({type:'session',state:'anonymous'});assert.equal(a.d.health.phase,'signInRequired');assert.equal(a.clock.timers.size,0);a.d.clear();
});
await check('403 denied has no automatic loop across lifecycle/renderer/credentials; explicit retry is debounced',async()=>{
 const h=setup();h.response={status:403,bodyPromise:new Promise(()=>{})};h.start();await h.identify();assert.equal(h.d.health.phase,'denied');
 h.d.setEnabled(false);h.d.setEnabled(true);h.d.refresh();h.credentials('different');await h.clock.advance(120000);assert.equal(h.sockets.length,1);
 h.response={status:200,body:state()};h.d.refresh(true);h.d.refresh(true);assert.equal(h.sockets.length,2);await h.identify();assert(h.d.health.controlsEnabled);h.d.clear();
});
for(const [label,value,duration] of [['seconds','9',9000],['date',new Date(1900000012000).toUTCString(),12000],['invalid','nope',33000],['missing',undefined,33000],['large','900',900000]]){
 await check(`429 ${label}: exact shared not-before, monotonic clock jump guard, one retry`,async()=>{
  const h=setup();h.response={status:429,headers:value?{'retry-after':value}:undefined};h.start();await h.identify();assert.equal(h.d.health.phase,'rateLimited');
  assert.equal(h.d.health.retryNotBeforeWall,1900000000000+duration);
  h.d.setEnabled(false);h.d.setEnabled(true);h.d.refresh(true);h.credentials('replacement');h.d.refresh();
  h.d.setReachability('offline');h.d.setReachability('online');await h.clock.advance(500);assert.equal(h.sockets.length,1);
  h.clock.wall+=1000000;await h.clock.advance(duration-501);assert.equal(h.sockets.length,1);
  await h.clock.advance(1);assert.equal(h.sockets.length,2);h.response={status:200,body:state()};await h.identify();assert(h.d.health.controlsEnabled);h.d.clear();
 });
}
for(const method of ['POST','GET'])await check(`429 ${method} cancels concurrent work; cooldown survives all recovery intents`,async()=>{
 const h=setup();h.start();await h.identify();h.response={status:429,headers:{'retry-after':'2'}};
 if(method==='POST')await assert.rejects(h.d.control({type:'next'}));else await assert.rejects(h.d.metadata(uri));
 assert.equal(h.d.health.phase,'rateLimited');h.d.refresh(true);h.d.refresh();await allDisabled(h);await h.clock.advance(1999);assert.equal(h.sockets.length,1);await h.clock.advance(1);assert.equal(h.sockets.length,2);assert.equal(h.posts().length,method==='POST'?1:0);h.d.clear();
});
await check('fallback cooldown doubles to capped five minutes, never caps server value',async()=>{
 const h=setup();h.start();h.response={status:429};
 for(const duration of [33000,66000,132000,264000,300000,300000]){await h.identify();assert.equal(h.d.health.retryNotBeforeWall-h.clock.wall,duration);await h.clock.advance(duration);}
 h.d.clear();
});
await check('5xx/reset errors use seeded 2/4/8/16/30 then 60-second cycles; no parallel sockets',async()=>{
 const h=setup();h.start();h.response={status:503};
 for(const delay of [2000,4000,8000,16000,30000,60000,60000]){await h.identify();assert.equal(h.d.health.nextRetryAtWall-h.clock.wall,delay);const n=h.sockets.length;h.d.refresh();await h.clock.advance(delay-1);assert.equal(h.sockets.length,n);await h.clock.advance(1);assert.equal(h.sockets.length,n+1);}
 h.d.clear();assert.equal(h.clock.timers.size,0);
});
for(const phase of ['open','id','register','body','state'])await check(`bounded ${phase} phase; progress independent of close and fetch abort`,async()=>{
 const h=setup();if(phase==='register')h.response=()=>new Promise(()=>{});if(phase==='body')h.response={status:200,bodyPromise:new Promise(()=>{})};if(phase==='state')h.response={status:200,body:{}};
 h.start();const ws=h.sockets[0];if(phase!=='open')ws.open();if(!['open','id'].includes(phase))ws.event({headers:{'spotify-connection-id':'id'}});await flush();
 if(phase==='id')for(let i=0;i<3;i++){await h.clock.advance(3000);ws.event({type:'pong'});}
 await h.clock.advance(phase==='id'?1000:10000);assert.equal(h.d.health.phase,'retryWait');assert.equal(h.d.socket,null);await h.clock.advance(2000);assert.equal(h.sockets.length,2);h.d.clear();
});
await check('valid idle/empty state confirms observer with absent target; cached active device never reused',async()=>{
 const h=setup();h.start();await h.identify();h.response={status:200,body:{player_state:{is_paused:true}}};h.d.refresh();await h.identify();assert.equal(h.d.health.phase,'ready');assert.equal(h.d.health.target,'absent');await allDisabled(h);h.d.clear();
});
await check('new ID revokes readiness; stale registration headers/body cannot mutate replacement',async()=>{
 const h=setup();h.start();const ws=await h.identify();const late=deferred();h.response={status:200,bodyPromise:late.promise};ws.event({headers:{'spotify-connection-id':'old'}});await flush();await allDisabled(h);
 h.response={status:200,body:state('new-phone')};ws.event({headers:{'spotify-connection-id':'new'}});await flush();assert(h.d.health.controlsEnabled);late.resolve(new TextEncoder().encode(JSON.stringify(state('old-phone'))).buffer);await flush();assert.equal(h.d.currentTarget,'new-phone');h.d.clear();
});
await check('stale-target 404 invalidates target, one observation recovery, zero playback replay',async()=>{
 const h=setup();h.start();await h.identify();h.response={status:404};await assert.rejects(h.d.control({type:'next'}));await allDisabled(h);await h.clock.advance(2000);h.response={status:200,body:state('new')};await h.identify();assert.equal(h.posts().length,1);assert.equal(h.d.currentTarget,'new');h.d.clear();
});
for(const type of ['toggle','next','previous','seek'])await check(`${type} response loss/ignored abort settles once with unknown outcome and exact one POST`,async()=>{
 const h=setup();h.start();await h.identify();h.response=()=>new Promise(()=>{});const result=h.d.control({type,positionMs:100});const rejected=assert.rejects(result,/unknown/);await allDisabled(h);await h.clock.advance(10000);await rejected;assert.equal(h.d.health.command,'outcomeUnknown');assert.equal(h.d.commandPending,null);await h.clock.advance(2000);h.response={status:200,body:state()};await h.identify();assert.equal(h.posts().length,1);h.d.clear();
});
await check('accepted command awaits authoritative state, five-second reconciliation never replays',async()=>{
 const h=setup();h.start();await h.identify();await h.d.control({type:'toggle'});assert.equal(h.d.health.command,'awaitingConfirmation');await allDisabled(h);await h.clock.advance(4999);assert.equal(h.sockets.length,1);await h.clock.advance(1);assert.equal(h.d.health.phase,'retryWait');await h.clock.advance(2000);await h.identify();assert.equal(h.posts().length,1);assert.equal(h.d.health.command,'idle');h.d.clear();
});
await check('track/target change invalidates seek confirmation; current observation wins without seek replay',async()=>{
 const h=setup();h.start();const ws=await h.identify();await h.d.control({type:'seek',positionMs:500});ws.event({payloads:[state('other','spotify:track:0000000000000000000001',1900000001000)]});await flush();assert.equal(h.d.health.command,'idle');await h.clock.advance(5000);assert.equal(h.sockets.length,1);assert.equal(h.posts().length,1);h.d.clear();
});
await check('late old command finally cannot clear or recover newer command gate',async()=>{
 const h=setup();h.start();await h.identify();const old=deferred();h.response=()=>old.promise;const first=h.d.control({type:'next'});const rejected=assert.rejects(first);h.d.setEnabled(false);h.d.setEnabled(true);h.response={status:200,body:state()};await h.identify();const newer=deferred();h.response=()=>newer.promise;const second=h.d.control({type:'previous'});const id=h.d.commandPending;old.resolve({status:200,body:{}});await rejected;assert.equal(h.d.commandPending,id);newer.resolve({status:200,body:{}});await second;assert.equal(h.posts().length,2);h.d.clear();
});
await check('offline suppresses periodic work; unknown attempts; online/active/renderer/manual events coalesce',async()=>{
 const h=setup();h.d.setReachability('offline');h.start();await h.clock.advance(120000);assert.equal(h.sockets.length,0);h.d.setReachability('online');h.d.setEnabled(true);h.d.refresh();h.d.refresh(true);await h.clock.advance(500);assert.equal(h.sockets.length,1);await h.identify();h.d.setActivity('inactive');await allDisabled(h);h.d.setActivity('active');assert(h.d.health.controlsEnabled);h.d.clear();
 const u=setup();u.start();assert.equal(u.sockets.length,1);u.d.clear();
});
await check('online hint never certifies Spotify; malformed frames cannot renew liveness; onerror recovers locally',async()=>{
 const h=setup();h.start();const ws=await h.identify();for(let i=0;i<3;i++){await h.clock.advance(14000);ws.event({unrecognized:true});}await h.clock.advance(3000);assert.equal(h.d.health.phase,'retryWait');await h.clock.advance(2000);const next=await h.identify();next.onerror();assert.equal(h.d.health.phase,'retryWait');h.d.clear();
});
for(const phase of ['connecting','registering','body','command','renewal'])await check(`logout/unmount/source-switch cancellation during ${phase}: settle and release all owned work`,async()=>{
 const h=setup();h.start();if(phase==='registering')h.response=()=>new Promise(()=>{});if(phase==='body')h.response={status:200,bodyPromise:new Promise(()=>{})};if(['registering','body','command'].includes(phase))await h.identify();let rejected;
 if(phase==='command'){h.response=()=>new Promise(()=>{});rejected=assert.rejects(h.d.control({type:'next'}));}
 if(phase==='renewal'){h.d.needSession('renew');}h.d.clear();await flush();if(rejected)await rejected;assert.equal(h.clock.timers.size,0);assert.equal(h.d.socket,null);assert.equal(h.d.health.phase,'idle');assert.equal(h.capture({type:'credentials',authenticated:true,token:'late'}),false);await h.clock.advance(120000);assert.equal(h.d.health.phase,'idle');
});
await check('only sixty seconds of uninterrupted healthy contact resets transient budget',async()=>{
 const h=setup();h.start();h.sockets[0].onerror();await h.clock.advance(2000);let ws=await h.identify();assert.equal(h.d.health.attempt,1);await h.clock.advance(14000);ws.event({type:'pong'});ws.onerror();await h.clock.advance(4000);ws=await h.identify();assert.equal(h.d.health.attempt,2);for(let i=0;i<4;i++){await h.clock.advance(15000);ws.event({type:'pong'});}assert.equal(h.d.health.attempt,0);h.d.clear();
});
await check('HTTP body hanging after command acceptance and late body settlement never replays or overwrites current generation',async()=>{
 const h=setup();h.start();await h.identify();const body=deferred();h.response={status:204,bodyPromise:body.promise};const command=h.d.control({type:'seek',positionMs:800});const rejected=assert.rejects(command,/unknown/);await flush();await h.clock.advance(10000);await rejected;await h.clock.advance(2000);h.response={status:200,body:state('replacement')};await h.identify();body.resolve(new ArrayBuffer(0));await flush();assert.equal(h.d.currentTarget,'replacement');assert.equal(h.d.health.command,'idle');assert.equal(h.posts().length,1);h.d.clear();
});
await check('abort-respecting fetch and rejected DNS/TLS both settle commands as unknown without replay',async()=>{
 for(const mode of ['abort','network']) {
  const h=setup();h.start();await h.identify();h.response=(_url,options)=>mode==='network'?Promise.reject(Error('DNS/TLS')):new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(Error('AbortError'))));
  const pending=h.d.control({type:'toggle'});const rejected=assert.rejects(pending,/unknown/);await flush();if(mode==='abort')await h.clock.advance(10000);await rejected;assert.equal(h.d.health.phase,'retryWait');assert.equal(h.posts().length,1);h.d.clear();
 }
});
await check('metadata 404 is nonblocking; control 403 exposes restricted capability; a fresh state clears restriction',async()=>{
 const h=setup();h.start();const ws=await h.identify();h.response={status:404};await assert.rejects(h.d.metadata(uri));assert(h.d.health.controlsEnabled);assert.equal(h.sockets.length,1);
 h.response={status:403};await assert.rejects(h.d.control({type:'next'}));assert.equal(h.d.health.target,'restricted');await allDisabled(h);ws.event({payloads:[state()]});assert(h.d.health.controlsEnabled);
 ws.event({payloads:[{...state(),player_state:{...state().player_state,restrictions:{disallow_seeking_reasons:['restricted']}}}]});assert.equal(h.d.health.target,'restricted');await allDisabled(h);h.d.clear();
});
await check('registration 410 and socket constructor failure recover through observation only',async()=>{
 const h=setup();h.response={status:410};h.start();await h.identify();assert.equal(h.d.health.phase,'retryWait');await h.clock.advance(2000);h.response={status:200,body:state()};await h.identify();assert.equal(h.posts().length,0);h.d.clear();
 const e=setup();e.d.runtime.socket=()=>{throw Error('TLS');};e.start();assert.equal(e.d.health.phase,'retryWait');assert.equal(e.posts().length,0);e.d.clear();
});
await check('ID rotation cancels an old command immediately and old completion cannot affect current observation',async()=>{
 const h=setup();h.start();const ws=await h.identify();const late=deferred();h.response=()=>late.promise;const pending=h.d.control({type:'previous'});const rejected=assert.rejects(pending,/unknown/);await flush();
 h.response={status:200,body:state('new')};ws.event({headers:{'spotify-connection-id':'rotated'}});await rejected;await flush();assert(h.d.health.controlsEnabled);late.resolve({status:429,headers:{'retry-after':'900'}});await flush();assert.equal(h.d.health.phase,'ready');assert.equal(h.posts().length,1);h.d.clear();
});
await check('expired captured credentials cannot create rapid auth loops; retry budget is retained',async()=>{
 const h=setup();h.start();const n=h.sockets.length;h.capture({type:'credentials',authenticated:true,token:'expired',expiresAt:h.clock.wall-1});assert.equal(h.d.health.phase,'retryWait');assert.equal(h.sockets.length,n);h.d.refresh();assert.equal(h.sockets.length,n);await h.clock.advance(2000);assert.equal(h.d.health.phase,'renewingSession');h.d.clear();
});
await check('backward wall jump conservatively extends cooldown; offline flaps never multiply retry timers',async()=>{
 const h=setup();h.start();h.response={status:429,headers:{'retry-after':'10'}};await h.identify();h.clock.wall-=20000;
 for(let i=0;i<4;i++){h.d.setReachability('offline');h.d.setReachability('online');await h.clock.advance(100);}assert.equal(h.sockets.length,1);
 await h.clock.advance(29599);assert.equal(h.sockets.length,1);await h.clock.advance(1);assert.equal(h.sockets.length,2);h.d.clear();
});
// Execute the actual injected browser script with independently controlled fetch/body and lifecycle.
function browser(response) {
 const clock=new Clock(), events={}, messages=[], requests=[];
 class Xhr {open(){}setRequestHeader(){}send(){}}
 const window={fetch:(...args)=>{requests.push(args);return response(...args);},WebSocket:class{},ReactNativeWebView:{postMessage:raw=>messages.push(JSON.parse(raw))},addEventListener:(name,fn)=>{(events[name]??=[]).push(fn);}};
 const context={window,XMLHttpRequest:Xhr,URL,Headers,AbortController,location:{origin:'https://open.spotify.com',href:'https://open.spotify.com/'},setTimeout:(fn,ms)=>clock.set(fn,ms),clearTimeout:clock.clear};
 const install=()=>runInNewContext(bootstrap,context);install();return {clock,events,messages,requests,install};
}
await check('bootstrap failure then success; at most one in-flight probe; bounded two attempts',async()=>{
 let count=0;const b=browser(async()=>{if(++count===1)throw Error('network');return {status:200,json:async()=>({accessToken:'fresh',isAnonymous:false})};});await flush();await b.clock.advance(1999);assert.equal(count,1);await b.clock.advance(1);assert.equal(count,2);assert(b.messages.some(m=>m.type==='credentials'));await b.clock.advance(60000);assert.equal(count,2);assert.equal(b.clock.timers.size,0);
});
for(const mode of ['fetch','body'])await check(`bootstrap hanging ${mode}: 15s independent deadlines, no overlap, finite episode`,async()=>{
 const b=browser(()=>mode==='fetch'?new Promise(()=>{}):Promise.resolve({status:200,json:()=>new Promise(()=>{})}));await flush();await b.clock.advance(14999);assert.equal(b.requests.length,1);await b.clock.advance(1+2000);assert.equal(b.requests.length,2);await b.clock.advance(15000);assert(b.messages.some(m=>m.type==='session'&&m.state==='unavailable'));await b.clock.advance(45000);assert.equal(b.requests.length,2);b.events.pagehide.forEach(fn=>fn());assert.equal(b.clock.timers.size,0);
});
await check('bootstrap pagehide/pageshow/reinjection restarts once; obsolete body credentials ignored',async()=>{
 const late=deferred();let count=0;const b=browser(async()=>({status:200,json:()=>++count===1?late.promise:Promise.resolve({accessToken:'new',isAnonymous:false})}));await flush();b.events.pagehide.forEach(fn=>fn());b.install();b.events.pageshow.forEach(fn=>fn());b.events.pageshow.forEach(fn=>fn());await flush();assert.equal(b.requests.length,2);late.resolve({accessToken:'obsolete',isAnonymous:false});await flush();assert.deepEqual(b.messages.filter(m=>m.type==='credentials').map(m=>m.token),['new']);assert.equal(b.clock.timers.size,0);
});
await check('health presentation distinguishes no device, offline, denial and sign-in without routing mutation',async()=>{
 const h=setup();h.start();h.response={status:200,body:{player_state:{is_paused:true}}};await h.identify();assert.match(spotifyHealthMessage(h.d.health),/no active/);h.d.setReachability('offline');assert.match(spotifyHealthMessage(h.d.health),/Offline/);assert.equal(h.d.health.source,'nativeSpotify');h.d.clear();
 const source=readFileSync('components/lyrics/spotify-connection-strip.tsx','utf8');assert(source.includes("s.playbackMode === 'mobile' && s.connectionStatus !== 'connected'"));assert(!source.includes('setState'));
 const screen=readFileSync('app/(tabs)/index.tsx','utf8');for(const handler of ['handleLyricLinePress','handleSeek','handlePlaybackPrevious','sendSeekToPlaybackSource','handlePlaybackPlayPause','handlePlaybackNext','handleScrubPreview']){const start=screen.indexOf(`const ${handler} =`);assert(start>=0);assert(screen.slice(start,start+180).includes('nativePlaybackUnavailable()'),handler);}
 const controls=readFileSync('components/lyrics/playback-controls.tsx','utf8');assert(controls.includes('.enabled(!controlsDisabled)'));assert(controls.includes('accessibilityState={{ disabled }}'));assert(controls.includes('if (controlsDisabled) { setIsScrubbing(false)'));assert.equal((controls.match(/disabled=\{controlsDisabled\}/g)??[]).length,3);
});
console.log(`Spotify recovery matrix passed: ${cases} deterministic cases; actual detector/bootstrap, injected clocks/fetch/socket/body/callbacks, no external playback.`);
