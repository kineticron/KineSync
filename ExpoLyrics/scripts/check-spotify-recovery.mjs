import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const baseline = process.env.SPOTIFY_RECOVERY_BASELINE;
const plugins = baseline ? [{ name: 'review-baseline', setup(b) { b.onLoad({ filter: /spotify-detector\/client\.ts$/ }, args => ({ contents: execFileSync('git', ['show', `${baseline}:ExpoLyrics/lib/spotify-detector/client.ts`], { encoding: 'utf8' }), loader: 'ts', resolveDir: args.path.slice(0, args.path.lastIndexOf('/')) })); } }] : [];
const bundle = await build({ stdin: { contents: `export * from './lib/spotify-detector/client'; export {bootstrap} from './lib/spotify-detector/bootstrap'; export * from './lib/spotify-detector/health';`, resolveDir: process.cwd() }, plugins, bundle: true, platform: 'node', format: 'esm', write: false });
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
function seeded(seed) { let value = seed >>> 0; return () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 2 ** 32; }; }
function setup(random = () => 0.5) {
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
  const runtime={wall:()=>clock.wall,mono:()=>clock.mono,random,
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
let cases=0, baselineFailures=0;
async function check(name,fn){
 if(baseline && !name.startsWith('review:')) return;
 try { await fn();cases++;console.log(`PASS ${name}`); }
 catch(error) { if(!baseline)throw error;baselineFailures++;console.log(`FAIL ${name}: ${error.message}`); }
}
async function allDisabled(h){const n=h.posts().length;for(const type of ['toggle','next','previous','seek'])await assert.rejects(h.d.control({type,positionMs:20}));assert.equal(h.posts().length,n);}
for (const boundary of ['retryWait', 'renewingSession', 'sessionNeeded']) await check(`lifetime: ${boundary} callback can dispose without leaving timers`, async () => {
 const h = setup();
 try {
  if (boundary === 'sessionNeeded') h.d.callbacks.sessionNeeded = () => h.d.clear();
  else { let disposed = false; h.d.callbacks.health = health => { if (health.phase === boundary && !disposed) { disposed = true; h.d.clear(); } }; }
  if (boundary === 'retryWait') { h.start(); h.sockets[0].onerror(); }
  else h.d.setEnabled(true);
  await flush();
  assert.equal(h.d.health.phase, 'idle');
  assert.equal(h.clock.timers.size, 0, 'disposed connection owns no retry/renewal timers');
  await h.clock.advance(120000);
  assert.equal(h.d.health.phase, 'idle');
 } finally { h.d.clear(); }
});
for (const stage of ['sending', 'awaitingConfirmation']) await check(`lifetime: auth replacement during ${stage} never replays a command`, async () => {
 const h = setup();
 try {
  h.start(); await h.identify(); const pending = deferred();
  if (stage === 'sending') h.response = () => pending.promise;
  const command = h.d.control({type:'next'});
  const settled = stage === 'sending' ? assert.rejects(command, /unknown/) : command;
  await flush();
  if (stage === 'awaitingConfirmation') await command;
  h.credentials('replacement');
  pending.resolve({status:204}); await settled;
  h.response = {status:200,body:state('replacement-phone')}; await h.identify();
  await h.clock.advance(5001);
  assert.equal(h.posts().length, 1); assert(h.d.health.controlsEnabled);
  assert.equal(h.d.currentTarget, 'replacement-phone');
 } finally { h.d.clear(); }
});
for(const type of ['next','previous','toggle','seek'])for(const advance of ['result','supersession'])await check(`review: ${type} Dealer ${advance} before HTTP response preserves healthy authority`,async()=>{
 const h=setup();try {
 h.start();const ws=await h.identify();const pending=deferred();h.response=()=>pending.promise;
 const command=h.d.control({type,positionMs:9000});const settled=assert.doesNotReject(command);await flush();assert.equal(h.posts().length,1);
 const observed=state('phone',advance==='supersession'||['next','previous'].includes(type)?'spotify:track:0000000000000000000001':uri,1900000001000);
 if(advance==='supersession') observed.player_state.session_id='new-session';
 if(type==='toggle') observed.player_state.is_paused=true;
 if(type==='seek') observed.player_state.position_as_of_timestamp=9000;
 ws.event({payloads:[observed]});await flush();assert.equal(h.d.health.command,'sending');await allDisabled(h);
 pending.resolve({status:204});await settled;assert.equal(h.d.health.command,'idle');assert(h.d.health.controlsEnabled);
 await h.clock.advance(5001);assert.equal(h.d.socket,ws);assert.equal(h.sockets.length,1);assert.equal(h.posts().length,1);assert.equal(h.requests.filter(r=>r.method==='PUT').length,1);assert.equal(h.d.health.attempt,0);
 } finally {h.d.clear();}
});
for(const type of ['next','seek'])await check(`review: ${type} observation during HTTP response body is retained without reconnect`,async()=>{
 const h=setup();try {h.start();const ws=await h.identify();const body=deferred();h.response={status:204,bodyPromise:body.promise};const pending=h.d.control({type,positionMs:9000});await flush();const observed=state('phone',type==='next'?'spotify:track:0000000000000000000001':uri,1900000001000);observed.player_state.position_as_of_timestamp=9000;ws.event({payloads:[observed]});body.resolve(new ArrayBuffer(0));await pending;await h.clock.advance(5001);assert.equal(h.d.health.command,'idle');assert.equal(h.d.socket,ws);assert.equal(h.sockets.length,1);assert.equal(h.posts().length,1);assert.equal(h.requests.filter(r=>r.method==='PUT').length,1);}finally{h.d.clear();}
});
await check('review: synchronous observation from awaiting-confirmation health cancels its already-owned deadline',async()=>{
 const h=setup();try{h.start();const ws=await h.identify();let entered=false;h.d.callbacks.health=health=>{if(health.command==='awaitingConfirmation'&&!entered){entered=true;const observed=state('phone',uri,1900000001000);observed.player_state.is_paused=true;ws.event({payloads:[observed]});}};await h.d.control({type:'toggle'});assert(entered);assert.equal(h.d.health.command,'idle');await h.clock.advance(5001);assert.equal(h.d.socket,ws);assert.equal(h.sockets.length,1);assert.equal(h.requests.filter(r=>r.method==='PUT').length,1);assert.equal(h.posts().length,1);}finally{h.d.clear();}
});
await check('review: fresh observation supersedes ambiguous POST outcome without reconnect or replay',async()=>{
 const h=setup();try {h.start();const ws=await h.identify();h.response=()=>new Promise(()=>{});const pending=h.d.control({type:'next'});const rejected=assert.rejects(pending,/unknown/);await flush();ws.event({payloads:[state('phone','spotify:track:0000000000000000000001',1900000001000)]});await h.clock.advance(10000);await rejected;assert.equal(h.d.health.command,'idle');assert.equal(h.d.socket,ws);assert.equal(h.sockets.length,1);assert.equal(h.posts().length,1);assert.equal(h.requests.filter(r=>r.method==='PUT').length,1);assert.equal(h.d.health.attempt,0);}finally{h.d.clear();}
});
await check('review: unrelated unchanged state is not positive toggle confirmation, but no-op reconciliation preserves transport',async()=>{
 const h=setup();try {h.start();const ws=await h.identify();const pending=deferred();h.response=()=>pending.promise;const command=h.d.control({type:'toggle'});await flush();ws.event({payloads:[state()]});pending.resolve({status:204});await command;assert.equal(h.d.health.command,'awaitingConfirmation');ws.event({payloads:[state()]});assert.equal(h.d.health.command,'awaitingConfirmation');h.response={status:200,body:state()};await h.clock.advance(5000);assert.equal(h.d.health.command,'idle');assert.equal(h.d.socket,ws);assert.equal(h.sockets.length,1);assert.equal(h.requests.filter(r=>r.method==='PUT').length,2);assert.equal(h.posts().length,1);assert.equal(h.d.health.attempt,0);}finally{h.d.clear();}
});
await check('review: stale observation cannot positively settle a pending command',async()=>{
 const h=setup();try {h.start();const ws=await h.identify();const pending=deferred();h.response=()=>pending.promise;const command=h.d.control({type:'toggle'});await flush();ws.event({payloads:[state('phone',uri,1899999999000)]});pending.resolve({status:204});await command;assert.equal(h.d.health.command,'awaitingConfirmation');h.response={status:200,body:state('phone',uri,1899999999000)};await h.clock.advance(5000);assert.equal(h.d.health.command,'idle');assert.equal(h.sockets.length,1);assert.equal(h.d.socket,ws);assert.equal(h.posts().length,1);assert.equal(h.requests.filter(r=>r.method==='PUT').length,2);assert.equal(h.d.health.attempt,0);}finally{h.d.clear();}
});
await check('review: no-op confirmation timeout reconciles observation once without transport penalty',async()=>{
 const h=setup();try {h.start();const ws=await h.identify();const attempt=h.d.health.attempt;await h.d.control({type:'next'});await h.clock.advance(4999);assert.equal(h.requests.filter(r=>r.method==='PUT').length,1);await h.clock.advance(1);assert.equal(h.d.health.command,'idle');assert.equal(h.d.socket,ws);assert.equal(h.sockets.length,1);assert.equal(h.posts().length,1);assert.equal(h.requests.filter(r=>r.method==='PUT').length,2);assert.equal(h.d.health.attempt,attempt);assert.equal(h.d.health.lastError,undefined);await h.clock.advance(5001);assert.equal(h.requests.filter(r=>r.method==='PUT').length,2);}finally{h.d.clear();}
});
await check('review: only failed reconciliation spends transport retry budget',async()=>{
 const h=setup();try{h.start();await h.identify();await h.d.control({type:'previous'});h.response={status:503};await h.clock.advance(5000);assert.equal(h.d.health.phase,'retryWait');assert.equal(h.d.health.attempt,1);assert.equal(h.sockets.length,1);assert.equal(h.requests.filter(r=>r.method==='PUT').length,2);assert.equal(h.posts().length,1);await h.clock.advance(2000);assert.equal(h.sockets.length,2);assert.equal(h.posts().length,1);}finally{h.d.clear();}
});
for(const cancel of [false,true])await check(`review: synchronous connecting health reentry ${cancel?'cancels':'coalesces'} the whole owned attempt`,async()=>{
 const h=setup();let entered=false;try {
 h.capture({type:'observerEndpoint',url:'https://spclient.spotify.com/connect-state/v1/devices/observer'});h.capture({type:'socket',url:'wss://dealer.spotify.com/'});h.credentials();
 h.d.callbacks.health=health=>{h.health.push(health);if(health.phase==='connecting'&&!entered){entered=true;if(cancel)h.d.clear();else {h.d.setEnabled(true);h.d.refresh(true);}}};
 h.d.setEnabled(true);await flush();assert(entered);assert.equal(h.sockets.length,1);if(cancel){assert.equal(h.d.socket,null);assert.equal(h.clock.timers.size,0);assert.equal(h.sockets[0].readyState,3);}else {assert.equal(h.d.socket,h.sockets[0]);await h.identify();assert(h.d.health.controlsEnabled);}
 }finally{h.d.clear();}assert(h.sockets.every(ws=>ws.readyState===3),'no orphan socket survives teardown');
});
await check('review: socket factory reentry cannot create an orphan attempt',async()=>{
 const h=setup();try{const factory=h.d.runtime.socket;let entered=false;h.d.runtime.socket=url=>{if(!entered){entered=true;h.d.setEnabled(true);}return factory(url);};h.start();await h.identify();assert.equal(h.sockets.length,1);assert.equal(h.d.socket,h.sockets[0]);}finally{h.d.clear();}
});
await check('review: Dealer access_token-only rotations do not change observer authority',async()=>{
 const h=setup();try{h.start();const ws=await h.identify();const generation=h.d.health.generation;const scope=h.d.lastSample.sourceClockScope;
 for(const token of ['browser-a','browser-b'])h.capture({type:'socket',url:`wss://dealer.spotify.com/?access_token=${token}#ignored`});
 assert.equal(h.d.socket,ws);assert.equal(h.sockets.length,1);assert.equal(h.d.health.generation,generation);assert.equal(h.d.lastSample.sourceClockScope,scope);assert(h.d.health.controlsEnabled);assert.equal(h.requests.filter(r=>r.method==='PUT').length,1);assert.equal(h.posts().length,0);assert.equal(new URL(ws.url).searchParams.get('access_token'),'valid');
 h.credentials('actually-new-verified-token');assert.equal(h.sockets.length,2);assert.equal(h.d.health.observerConfirmed,false);
 }finally{h.d.clear();}
});
for(const body of [{},[],{player_state:{}},{player_state:[]},{player_state:{is_playing:true}},{player_state:{is_paused:true,track:{uri:'malformed'}}},{arbitrary:{player_state:{is_paused:true}}}])await check(`review: malformed/unproven registration body never establishes readiness ${JSON.stringify(body)}`,async()=>{
 const h=setup();try{h.response={status:200,body};h.start();await h.identify();assert.equal(h.d.health.observerConfirmed,false);await allDisabled(h);await h.clock.advance(10000);assert.equal(h.d.health.phase,'retryWait');assert.equal(h.posts().length,0);}finally{h.d.clear();}
});
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
 h.d.setEnabled(false);h.d.setEnabled(true);h.d.refresh();h.credentials('different');await h.clock.advance(120000);assert.equal(h.sockets.length,1);assert.equal(h.d.health.phase,'denied');
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
 const h=setup();h.start();await h.identify();await h.d.control({type:'toggle'});assert.equal(h.d.health.command,'awaitingConfirmation');await allDisabled(h);await h.clock.advance(4999);assert.equal(h.sockets.length,1);await h.clock.advance(1);assert.equal(h.d.health.phase,'ready');assert.equal(h.sockets.length,1);assert.equal(h.d.health.attempt,0);assert.equal(h.requests.filter(r=>r.method==='PUT').length,2);assert.equal(h.posts().length,1);assert.equal(h.d.health.command,'idle');h.d.clear();
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
await check('metadata 404 stays nonblocking; POST 403 scopes next until fresh accepted state',async()=>{
 const h=setup();
 try {
  h.start();const ws=await h.identify();
  h.response={status:404};
  await assert.rejects(h.d.metadata(uri),/metadata HTTP 404/);
  assert(h.d.health.controlsEnabled);
  assert.equal(h.sockets.length,1);
  const puts=h.requests.filter(r=>r.method==='PUT').length;
  h.response={status:403};
  await assert.rejects(h.d.control({type:'next'}),/control HTTP 403/);
  assert.equal(h.posts().length,1);
  assert.equal(h.d.health.phase,'ready');
  assert.equal(h.d.health.target,'available');
  assert.equal(h.d.health.command,'idle');
  assert(h.d.health.controlsEnabled);
  assert.equal(h.d.health.allowed.next,false);
  for(const key of ['resume','pause','previous','seek']) assert.equal(h.d.health.allowed[key],true,key);
  await assert.rejects(h.d.control({type:'next'}),/restricted/);
  assert.equal(h.posts().length,1,'blocked next is not dispatched or replayed');
  ws.event({payloads:[state()]});
  assert.equal(h.d.health.allowed.next,false,'exact replay must not clear denied operation');
  ws.event({payloads:[state('phone',uri,1899999999000)]});
  assert.equal(h.d.health.allowed.next,false,'older state cannot clear denied operation');
  ws.event({payloads:[state('phone',uri,1900000001000)]});
  assert.equal(h.d.health.allowed.next,true,'fresh accepted state clears operation denial');
  assert.equal(h.d.health.target,'available');
  assert(h.d.health.controlsEnabled);
  assert.equal(h.posts().length,1,'state recovery cannot replay playback');
  assert.equal(h.sockets.length,1);
  assert.equal(h.requests.filter(r=>r.method==='PUT').length,puts);
 } finally {h.d.clear();}
});

await check('seek-only restriction preserves other operations and blocks seek before POST',async()=>{
 const h=setup();
 try {
  h.start();const ws=await h.identify();
  const fresh=state('phone',uri,1900000001000);
  fresh.player_state.restrictions={disallow_seeking_reasons:['restricted']};
  ws.event({payloads:[fresh]});
  assert.equal(h.d.health.target,'available');
  assert(h.d.health.controlsEnabled);
  assert.equal(h.d.health.allowed.seek,false);
  for(const key of ['resume','pause','next','previous']) assert.equal(h.d.health.allowed[key],true,key);
  await assert.rejects(h.d.control({type:'seek',positionMs:9000}),/restricted/);
  assert.equal(h.posts().length,0);
  h.response={status:204};
  await h.d.control({type:'toggle'});
  assert.equal(h.posts().length,1);
  assert.equal(h.d.health.command,'awaitingConfirmation','204 is not device confirmation');
  await allDisabled(h);
  assert.equal(h.posts().length,1);
  const paused=state('phone',uri,1900000002000);
  paused.player_state.is_paused=true;
  paused.player_state.restrictions={disallow_seeking_reasons:['restricted']};
  ws.event({payloads:[paused]});
  assert.equal(h.d.health.command,'idle');
  assert.equal(h.d.health.allowed.seek,false);
  assert.equal(h.d.health.allowed.resume,true);
  assert.equal(h.sockets.length,1);
 } finally {h.d.clear();}
});


// POST denial is scoped to the authority at dispatch, not transient idle visibility.
for(const [event,settleAtIdle,expectDenied] of [
 ['exact',false,true],['older',false,true],['newer',false,false],
 ['permission',false,false],['handoff',false,false],
 ['idle-replay',false,true],['idle-replay',true,true],
 ['idle-newer',false,false],
])await check('review: scoped POST403 '+event+' settleAtIdle='+settleAtIdle,async()=>{
 const h=setup();try{
  h.start();const ws=await h.identify();const gate=deferred();
  h.response=()=>gate.promise;
  const rejected=assert.rejects(h.d.control({type:'next'}),error=>error?.httpStatus===403 && /control HTTP 403/.test(error.message));
  await flush();assert.equal(h.posts().length,1);
  const puts=h.requests.filter(r=>r.method==='PUT').length;
  const send=o=>ws.event({payloads:[o]});
  const idle=()=>send({active_device_id:'',player_state:{timestamp:1900000000100,is_playing:false}});
  if(event.startsWith('idle-')){
   idle();await allDisabled(h);assert.equal(h.posts().length,1);
   if(settleAtIdle){gate.resolve({status:403});await rejected;await allDisabled(h);}
   send(state('phone',uri,event==='idle-newer'?1900000000200:1900000000000));
  }else{
   const value=state(event==='handoff'?'speaker':'phone',uri,event==='older'?1899999999000:event==='newer'?1900000000100:1900000000000);
   if(event==='permission')value.player_state.restrictions={disallow_seeking_reasons:['new-authority']};
   send(value);
  }
  if(!settleAtIdle){gate.resolve({status:403});await rejected;}
  await flush();
  assert.equal(h.d.health.allowed.next,!expectDenied);
  assert.equal(h.d.health.allowed.pause,true);
  assert.equal(h.d.health.allowed.seek,event!=='permission');
  assert.equal(h.d.health.command,'idle');assert.equal(h.d.health.phase,'ready');
  assert.equal(h.d.health.target,'available');
  if(expectDenied)await assert.rejects(h.d.control({type:'next'}),/restricted/);
  assert.equal(h.posts().length,1,'no replay or extra POST');
  assert.equal(h.sockets.length,1);assert.equal(h.requests.filter(r=>r.method==='PUT').length,puts);
 }finally{h.d.clear();}
});
await check('review: existing POST403 survives idle and exact replay',async()=>{
 const h=setup();try{
  h.start();const ws=await h.identify();h.response={status:403};
  await assert.rejects(h.d.control({type:'next'}),e=>e?.httpStatus===403);
  ws.event({payloads:[{active_device_id:'',player_state:{is_playing:false}}]});
  await allDisabled(h);
  ws.event({payloads:[state()]});
  assert.equal(h.d.health.allowed.next,false);assert.equal(h.d.health.allowed.pause,true);
  await assert.rejects(h.d.control({type:'next'}),/restricted/);
  assert.equal(h.posts().length,1);assert.equal(h.sockets.length,1);
 }finally{h.d.clear();}
});

// Independent same-socket rotation regression coverage

const rotationTS=1900000000000;
async function rotationFresh(){const h=setup();h.start();const ws=await h.identify();return {h,ws};}
async function rotationDenied(h,type='next'){h.response={status:403};await assert.rejects(h.d.control({type}),e=>e?.httpStatus===403);await flush();}
async function rotationCan(h,type){h.response={status:204};const n=h.posts().length;try{await h.d.control({type,positionMs:50});}catch{}await flush();return h.posts().length>n;}
function rotationS({ts=rotationTS,position=1000}={}){const v=state('phone',uri,ts);v.player_state.position_as_of_timestamp=position;return {payloads:[v]};}
async function rotateWithSnapshot(h,ws,snapshot){
 h.response={status:200,body:snapshot};
 ws.event({headers:{'spotify-connection-id':'rotated-race-connection'}});
 await flush();
}
await check('same-socket connection rotation invalidates prior403 even with older same-device registration',async()=>{
 const {h,ws}=await rotationFresh();try{
 await rotationDenied(h,'next');
 await rotateWithSnapshot(h,ws,state('phone',uri,rotationTS-100));
 assert.equal(h.sockets.length,1);
 assert.equal(h.d.health.allowed.next,true,'new connection cannot inherit prior connection HTTP denial');
 assert.equal(await rotationCan(h,'next'),true);
 assert.equal(h.posts().length,2);
 }finally{h.d.clear();}
});
await check('same-socket late old403 cannot deny rotated connection after stale same-device registration',async()=>{
 const {h,ws}=await rotationFresh();try{
 const gate=deferred();h.response=()=>gate.promise;
 const pending=h.d.control({type:'next'}).catch(e=>e);await flush();
 await rotateWithSnapshot(h,ws,state('phone',uri,rotationTS-100));
 gate.resolve({status:403});await pending;await flush();
 assert.equal(h.sockets.length,1);
 assert.equal(h.d.health.allowed.next,true);
 assert.equal(await rotationCan(h,'next'),true);
 assert.equal(h.posts().length,2);
 }finally{h.d.clear();}
});
for(const identity of ['omitted','empty'])await check('rotated registration '+identity+' identity cannot restore retained target',async()=>{
 const {h,ws}=await rotationFresh();try{
 const snapshot=state('phone',uri,rotationTS-100);
 if(identity==='omitted')delete snapshot.active_device_id;else snapshot.active_device_id='';
 await rotateWithSnapshot(h,ws,snapshot);
 assert.equal(h.d.health.target,'absent');
 assert.equal(await rotationCan(h,'next'),false);assert.equal(h.posts().length,0);
 }finally{h.d.clear();}
});
await check('pending Dealer idle before rotated stale registration prevents target resurrection',async()=>{
 const {h,ws}=await rotationFresh();try{
 const registration=deferred();h.response=()=>registration.promise;
 ws.event({headers:{'spotify-connection-id':'rotated-idle-connection'}});
 await flush();
 ws.event({payloads:[{active_device_id:'',player_state:{is_playing:false}}]});
 registration.resolve({status:200,body:state('phone',uri,rotationTS-100)});await flush();
 assert.equal(h.d.health.target,'absent');
 assert.equal(await rotationCan(h,'next'),false);assert.equal(h.posts().length,0);
 assert.equal(h.sockets.length,1);
 }finally{h.d.clear();}
});
await check('rotated stale registration restores known target without replacing playback or accepted watermark',async()=>{
 const {h,ws}=await rotationFresh();try{
 ws.event(rotationS({ts:rotationTS+100,position:8000}));await flush();
 const accepted=h.samples.at(-1),count=h.samples.length;
 await rotateWithSnapshot(h,ws,state('phone',uri,rotationTS-100));
 assert.equal(h.d.health.target,'available');
 assert.equal(h.samples.length,count);assert.equal(h.samples.at(-1),accepted);
 ws.event(rotationS({ts:rotationTS,position:2000}));await flush();
 assert.equal(h.samples.length,count,'restoration must not regress accepted watermark');
 assert.equal(await rotationCan(h,'next'),true);assert.equal(decodeURIComponent(new URL(h.posts().at(-1).url).pathname.split('/').at(-1)),'phone');
 }finally{h.d.clear();}
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
await check('explicit account review starts one auth epoch without forbidden observer loop; cooldown cannot be bypassed by sign-in',async()=>{
 const h=setup();h.start();h.response={status:403};await h.identify();h.d.beginSignIn();assert.equal(h.d.health.phase,'renewingSession');assert.equal(h.sockets.length,1);h.response={status:200,body:state()};h.credentials('new-account');await h.identify();assert(h.d.health.controlsEnabled);h.d.clear();
 const r=setup();r.start();r.response={status:429,headers:{'retry-after':'10'}};await r.identify();const needs=r.needed;r.d.beginSignIn();assert.equal(r.needed,needs);assert.equal(r.d.health.phase,'rateLimited');r.d.clear();
});
await check('inactive-to-active revalidates expiry without waiting for suspended JS expiry timer',async()=>{
 const h=setup();h.start();await h.identify();h.d.setActivity('inactive');h.clock.wall+=4000000;h.clock.mono+=4000000;await allDisabled(h);h.d.setActivity('active');assert.equal(h.d.health.phase,'renewingSession');assert.equal(h.d.socket,null);h.d.clear();
});
await check('Retry-After HTTP-date uses server Date when local wall clock is skewed',async()=>{
 const h=setup();h.start();h.response={status:429,headers:{date:new Date(h.clock.wall-60000).toUTCString(),'retry-after':new Date(h.clock.wall-45000).toUTCString()}};await h.identify();assert.equal(h.d.health.retryNotBeforeWall-h.clock.wall,15000);await h.clock.advance(14999);assert.equal(h.sockets.length,1);await h.clock.advance(1);assert.equal(h.sockets.length,2);h.d.clear();
});
await check('sign-in requirement survives background, renderer, reachability and late auth until explicit user sign-in',async()=>{
 const h=setup();h.start();h.response={status:401};await h.identify();h.credentials('fresh');await h.identify();assert.equal(h.d.health.phase,'signInRequired');const n=h.sockets.length, needs=h.needed;
 h.d.setEnabled(false);h.d.setEnabled(true);h.d.refresh();h.credentials('late');h.d.setReachability('offline');h.d.setReachability('online');await h.clock.advance(120000);assert.equal(h.d.health.phase,'signInRequired');assert.equal(h.sockets.length,n);assert.equal(h.needed,needs);h.d.beginSignIn();assert.equal(h.d.health.phase,'renewingSession');h.d.clear();
});
await check('active rechecks silent liveness and establishment deadlines when native timers were suspended',async()=>{
 for(const phase of ['ready','connecting']) {
  const h=setup();h.start();if(phase==='ready')await h.identify();h.d.setActivity('inactive');h.clock.wall+=50000;h.clock.mono+=50000;h.d.setActivity('active');assert.equal(h.d.health.phase,'retryWait');await allDisabled(h);assert.equal(h.d.socket,null);h.d.clear();
 }
});
await check('native send throwing without an error/close event still detaches and retries locally',async()=>{
 const h=setup();h.start();const ws=await h.identify();ws.send=()=>{throw Error('native transport disconnected');};await h.clock.advance(15000);assert.equal(h.d.health.phase,'retryWait');assert.equal(h.d.socket,null);await h.clock.advance(2000);assert.equal(h.sockets.length,2);assert.equal(h.posts().length,0);h.d.clear();
});
await check('seeded jitter has exact deterministic backoff and positive-only rate-limit fallback',async()=>{
 const expected=seeded(123);for(let i=0;i<40;i++)expected();const h=setup(seeded(123));h.start();h.response={status:503};await h.identify();assert.equal(h.d.health.nextRetryAtWall,h.clock.wall+2000*(0.8+expected()*0.4));h.d.clear();
 const rateExpected=seeded(456);for(let i=0;i<40;i++)rateExpected();const r=setup(seeded(456));r.start();r.response={status:429};await r.identify();const wait=30000*(1+rateExpected()*0.2);assert.equal(r.d.health.retryNotBeforeWall,r.clock.wall+wait);assert(wait>=30000);r.d.clear();
});
for(const method of ['POST','GET'])await check(`${method} 401 renews once and fresh-token rejection stops even after successful observer registration`,async()=>{
 const h=setup();h.start();await h.identify();h.response={status:401};
 const send=()=>method==='POST'?h.d.control({type:'next'}):h.d.metadata(uri);
 await assert.rejects(send(),/HTTP 401/);assert.equal(h.d.health.phase,'renewingSession');
 h.credentials('fresh');h.response={status:200,body:state()};await h.identify();assert(h.d.health.controlsEnabled);h.response={status:401};await assert.rejects(send(),/HTTP 401/);assert.equal(h.d.health.phase,'signInRequired');assert.equal(h.posts().length,method==='POST'?2:0);await h.clock.advance(120000);assert.equal(h.d.health.phase,'signInRequired');h.d.clear();
});
// Execute the actual injected browser script with independently controlled fetch/body and lifecycle.
function browser(response) {
 const clock=new Clock(), events={}, messages=[], requests=[];
 class Xhr {open(){}setRequestHeader(){}send(){}}
 const window={fetch:(...args)=>{requests.push(args);return response(...args);},WebSocket:class{},ReactNativeWebView:{postMessage:raw=>messages.push(JSON.parse(raw))},addEventListener:(name,fn)=>{(events[name]??=[]).push(fn);}};
 const context={window,XMLHttpRequest:Xhr,URL,Headers,AbortController,location:{origin:'https://open.spotify.com',href:'https://open.spotify.com/'},setTimeout:(fn,ms)=>clock.set(fn,ms),clearTimeout:clock.clear};
 const install=()=>runInNewContext(bootstrap,context);install();return {clock,events,messages,requests,install,window};
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
await check('late verified observer body from obsolete same-document epoch cannot restore credentials',async()=>{
 const text=deferred();const b=browser(async input=>String(input).startsWith('/api/token')?{status:200,json:()=>new Promise(()=>{})}:{status:200,headers:new Headers(),clone:()=>({text:()=>text.promise})});
 await b.window.fetch('https://spclient.spotify.com/connect-state/v1/devices/observer',{method:'PUT',headers:{authorization:'Bearer obsolete'}});await flush();b.events.pagehide.forEach(fn=>fn());text.resolve(JSON.stringify({player_state:{is_paused:true}}));await flush();assert.equal(b.messages.filter(m=>m.type==='credentials'&&m.authenticated===true).length,0);assert.equal(b.clock.timers.size,0);
});
await check('review: successful bootstrap does not restart probes through reinjection or __probeToken; a new host document does',async()=>{
 let count=0;const response=async()=>{count++;return {status:200,json:async()=>({accessToken:'token-'+count,isAnonymous:false})};};
 const b=browser(response);await flush();b.window.__probeToken();b.install();b.events.pageshow.forEach(fn=>fn());await b.clock.advance(60000);assert.equal(count,1);assert.equal(b.clock.timers.size,0);
 const next=browser(response);await flush();assert.equal(count,2);assert(next.messages.some(m=>m.type==='credentials'&&m.token==='token-2'));assert.equal(next.clock.timers.size,0);
});
await check('review: exhausted probe retains passive verified capture but cannot start an unbounded new probe',async()=>{
 const b=browser(async input=>String(input).startsWith('/api/token')?Promise.reject(Error('offline')):{status:200,headers:new Headers(),clone:()=>({text:async()=>JSON.stringify({player_state:{is_paused:true}})})});await flush();await b.clock.advance(32000);const count=b.requests.length;assert.equal(count,2);b.window.__probeToken();b.install();await flush();assert.equal(b.requests.length,count);
 await b.window.fetch('https://spclient.spotify.com/connect-state/v1/devices/observer',{method:'PUT',headers:{authorization:'Bearer passive-verified'}});await flush();assert(b.messages.some(m=>m.type==='credentials'&&m.authenticated===true&&m.token==='passive-verified'));assert.equal(b.clock.timers.size,0);
});
await check('review: whole-episode deadline parks passive capture until intended pageshow or host remount',async()=>{
 let available=false;const response=async input=>String(input).startsWith('/api/token')?(available?{status:200,json:async()=>({accessToken:'new-episode',isAnonymous:false})}:new Promise(()=>{})):{status:200,headers:new Headers(),clone:()=>({text:async()=>JSON.stringify({player_state:{is_paused:true}})})};
 const b=browser(response);await flush();const [id,deadline]=[...b.clock.timers].find(([,t])=>t.at===45000);b.clock.timers.delete(id);b.clock.mono=45000;b.clock.wall+=45000;deadline.fn();await flush();assert(b.messages.some(m=>m.type==='session'&&m.state==='unavailable'));
 const count=b.requests.length;b.window.__probeToken();b.install();await flush();assert.equal(b.requests.length,count);await b.window.fetch('https://spclient.spotify.com/connect-state/v1/devices/observer',{method:'PUT',headers:{authorization:'Bearer obsolete'}});await flush();assert(!b.messages.some(m=>m.type==='credentials'&&m.authenticated===true));assert.equal(b.clock.timers.size,0);
 available=true;b.events.pageshow.forEach(fn=>fn());await flush();assert(b.messages.some(m=>m.type==='credentials'&&m.token==='new-episode'));assert.equal(b.clock.timers.size,0);
 const remounted=browser(response);await flush();assert(remounted.messages.some(m=>m.type==='credentials'&&m.token==='new-episode'));assert.equal(remounted.clock.timers.size,0);
});
await check('health presentation distinguishes no device, offline, denial and sign-in without routing mutation',async()=>{
 const h=setup();h.start();h.response={status:200,body:{player_state:{is_paused:true}}};await h.identify();assert.match(spotifyHealthMessage(h.d.health),/no active/);h.d.setReachability('offline');assert.match(spotifyHealthMessage(h.d.health),/Offline/);assert.equal(h.d.health.source,'nativeSpotify');h.d.clear();
 const source=readFileSync('components/lyrics/spotify-connection-strip.tsx','utf8');assert(source.includes("s.playbackMode === 'mobile' && s.connectionStatus !== 'connected'"));assert(!source.includes('setState'));
 const screen=readFileSync('app/(tabs)/index.tsx','utf8');
 for(const [handler,guard] of Object.entries({handleLyricLinePress:"nativePlaybackUnavailable('seek')",handleSeek:"nativePlaybackUnavailable('seek')",handlePlaybackPrevious:"nativePlaybackUnavailable(pos > 3000 ? 'seek' : 'previous')",sendSeekToPlaybackSource:"nativePlaybackUnavailable('seek')",handlePlaybackPlayPause:"nativePlaybackUnavailable(usePlaybackStore.getState().isPlaying ? 'pause' : 'resume')",handlePlaybackNext:"nativePlaybackUnavailable('next')",handleScrubPreview:"nativePlaybackUnavailable('seek')"})){
  const start=screen.indexOf(`const ${handler} =`);assert(start>=0,handler);
  assert(screen.slice(start,start+500).includes(guard),handler+' must gate the actual operation');
 }
 const controls=readFileSync('components/lyrics/playback-controls.tsx','utf8');assert(controls.includes('.enabled(!controlsDisabled)'));assert(controls.includes('accessibilityState={{ disabled }}'));assert(controls.includes('if (controlsDisabled) { setIsScrubbing(false)'));for(const operation of ['previousDisabled','nextDisabled','playPauseDisabled'])assert(controls.includes('disabled={controlsDisabled || '+operation+'}'));assert(controls.includes('controlsDisabled={controlsDisabled || seekDisabled}'));
});
if(!baseline)console.log(`Spotify recovery matrix passed: ${cases} deterministic cases; actual detector/bootstrap, injected clocks/fetch/socket/body/callbacks, no external playback.`);

if(baseline){console.log(`Review baseline ${baseline}: ${baselineFailures} failures, ${cases} passes`);process.exitCode=baselineFailures?1:0;}
