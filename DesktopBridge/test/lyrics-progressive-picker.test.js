'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const picker = require('../src/lyricsAutoPicker');
const rewindFixture = require('./fixtures/lrc-red-auto.json').cases.find(item => item.name === 'Rewind');
const clone = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function clock() {
  let now = 0, id = 0;
  const tasks = new Map();
  return {
    Date: class extends Date { static now() { return 1_800_000_000_000 + now; } },
    setTimeout(fn, delay) { tasks.set(++id, { at: now + delay, fn }); return id; },
    clearTimeout(key) { tasks.delete(key); },
    async advance(ms) {
      const target = now + ms;
      while (true) {
        const entry = [...tasks].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        now = entry[1].at; tasks.delete(entry[0]); entry[1].fn(); await flush();
      }
      now = target; await flush();
    },
  };
}
const baseTrack = { trackId: 'one', spotifyTrackId: '0000000000000000000001', title: 'Example', artist: 'Artist', durationMs: 10000 };
const packet = (source, text = 'Example lyric', attribution = {}) => ({ source, metadata: { attribution }, lyrics: [
  { text, lineStartTime: 1000, lineEndTime: 9000, syllables: [{ text, startTime: 1000, endTime: 9000 }] },
] });
function load(mobile) {
  const time = clock();
  const src = path.resolve(__dirname, '../src');
  const context = vm.createContext({ AbortController, Buffer, TextDecoder, URL, URLSearchParams,
    Date: time.Date, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout, setInterval, clearInterval,
    console: { log() {}, debug() {}, warn() {}, error() {} }, fetch() { throw Error('Unexpected network'); },
    global: {}, process: { env: {} }, module: { exports: {} }, require: createRequire(path.join(src, 'lyricsService.js')) });
  if (mobile) {
    const text = fs.readFileSync(path.resolve(src, '../../ExpoLyrics/lib/mobile-lyrics-service.js'), 'utf8').replace(/^import .*;\r?\n/gm, '');
    vm.runInContext(text.slice(0, text.indexOf('export {')), context);
  } else {
    const text = fs.readFileSync(path.join(src, 'lyrics/index.js'), 'utf8');
    for (const match of text.match(/const partFiles = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)) vm.runInContext(fs.readFileSync(path.join(src, 'lyrics/parts', match[1]), 'utf8'), context);
  }
  const fetchers = vm.runInContext('SOURCE_FETCHERS', context);
  for (const name of Object.keys(fetchers)) fetchers[name] = async () => null;
  return { context, time, fetchers, run(options = {}, track = baseTrack) {
    context.track = track; context.options = { spicyLyricsPublishableKey: 'sl_pk_test', autoSourceTimeoutMs: 30, ...options };
    return vm.runInContext('fetchBestSyncedLyrics(track, options)', context);
  }, service() { return vm.runInContext('createLyricsService({getSpicyLyricsPublishableKey: () => "sl_pk_test"})', context); } };
}

for (const mobile of [false, true]) {
  const label = mobile ? 'mobile' : 'desktop';
  test(`${label}: exact buckets and original line/vault exceptions are preserved in both directions`, () => {
    const { context } = load(mobile);
    const buckets = { 'local-vault-karaoke':720, 'lrc-red-karaoke':700, 'spicy-lyrics-syllable':680, 'kugou-krc':620,
      'qq-musicu-qrc':600, 'netease-yrc':560, 'musixmatch-richsync':520, 'local-vault-line':380, 'lrc-red-line':370,
      'spicy-lyrics-line':360, lrclib:320, 'netease-lrc':300, 'musixmatch-line':280, 'qq-other':240, other:200, 'spicy-lyrics-static':180 };
    for (const [source, expected] of Object.entries(buckets)) {
      context.source = source;
      assert.equal(vm.runInContext('getSourcePriorityBucket(source)', context), expected);
      assert.equal(picker.sourcePriority(source), expected);
    }
    const wins = (winner, loser) => {
      assert.equal(picker.shouldPreferAutoCandidate(baseTrack, loser, winner), true);
      assert.equal(picker.shouldPreferAutoCandidate(baseTrack, winner, loser), false);
    };
    const line = packet('spicy-lyrics-line', 'line', { source:'spicy_lyrics', community:true });
    wins(packet('lrc-red-line'), line);
    wins(line, packet('lrclib'));
    wins(line, packet('other'));
    for (const source of ['lrc-red-karaoke','kugou-krc','qq-musicu-qrc','netease-yrc','musixmatch-richsync']) wins(packet(source), line);
    const community = packet('spicy-lyrics-syllable', 'community', {source:'spicy_lyrics'});
    wins(packet('local-vault-karaoke'), community);
    for (const source of ['lrc-red-karaoke','kugou-krc']) wins(packet(source), packet('local-vault-line'));
    assert.equal(picker.autoCandidateCouldOutrank(baseTrack, community, 'local-vault'), true);
    assert.equal(picker.autoCandidateCouldOutrank(baseTrack, packet('lrc-red-karaoke'), 'spicy-lyrics'), true);
  });

  for (const kind of ['community','apple-equivalent','apple-different','other-provider']) for (const first of ['lrc','spicy']) {
    test(`${label}: ${kind} final precedence survives ${first}-first arrival with immediate publication`, async () => {
      const { fetchers, run } = load(mobile), lrc = deferred(), spicy = deferred();
      const lrcPacket = packet('lrc-red-karaoke');
      const spicyPacket = packet('spicy-lyrics-syllable', kind === 'apple-different' ? 'Different lead' : 'Example lyric',
        { source: kind === 'community' ? 'spicy_lyrics' : kind.startsWith('apple') ? 'apple_music' : 'spotify' });
      fetchers['lrc-red'] = () => lrc.promise; fetchers['spicy-lyrics'] = () => spicy.promise;
      const cache = new Map(), changes = [];
      const initial = run({sourceCache:cache,onProgress:p=>changes.push(p.source)}); await flush();
      const chosenFirst = first === 'lrc' ? lrcPacket : spicyPacket;
      (first === 'lrc' ? lrc : spicy).resolve(clone(chosenFirst));
      assert.equal((await initial).source, chosenFirst.source);
      if (kind === 'community' && first === 'spicy') {
        assert.equal(cache.get('auto').source, spicyPacket.source, 'community syllable is already final after the vault miss');
      } else {
        assert.equal(cache.has('auto'), false, 'potential superior sibling remains pending');
      }
      (first === 'lrc' ? spicy : lrc).resolve(clone(first === 'lrc' ? spicyPacket : lrcPacket)); await flush();
      const expected = kind === 'community' || kind === 'apple-different' ? spicyPacket.source : lrcPacket.source;
      assert.equal(cache.get('auto').source, expected);
      assert.equal(changes.at(-1), expected);
      assert(changes.length <= 2, 'one initial publication plus at most one upgrade');
    });
  }

  for (const delay of [2862,3788]) test(`${label}: Rewind line appears before ${delay}ms KRC then upgrades once`, async () => {
    const { fetchers, run, time } = load(mobile); const starts = [];
    const rewindTrack = {...baseTrack, trackId:'rewind', title:'Rewind', artist:'Wonder Girls',
      spotifyTrackId:'2YZa0dsV3xXGZ61XFYiRt8', isrc:'US5TA1500050', durationMs:213000};
    // Reuse two representative lines from the existing captured fixture; no
    // complete song or new copyrighted lyric payload is added to this checker.
    const sample = source => ({source, lyrics:rewindFixture.lrc.lines.slice(0,2).map(([start,end,text]) => ({
      lineStartTime:start, lineEndTime:end, syllables:[{text,startTime:start,endTime:end}],
    }))});
    for (const name of Object.keys(fetchers)) if (name !== 'local-vault') fetchers[name] = async () => { starts.push(name); return null; };
    fetchers['lrc-red'] = async () => { starts.push('lrc-red'); return sample('lrc-red-line'); };
    fetchers.kugou = () => { starts.push('kugou'); return new Promise(resolve => time.setTimeout(()=>resolve(sample('kugou-krc')),delay)); };
    const cache = new Map(), progress = [];
    const first = await run({sourceCache:cache,musixmatchUserToken:'fixture-token',onProgress:p=>progress.push(p.source)},rewindTrack);
    assert.equal(first.source,'lrc-red-line');
    assert.equal(new Set(starts).size,7,'all eligible online providers start before first delivery');
    assert.equal(cache.has('auto'),false);
    await time.advance(delay-1); assert.deepEqual(progress,['lrc-red-line']);
    await time.advance(1); assert.deepEqual(progress,['lrc-red-line','kugou-krc']);
    assert.equal(cache.get('auto').source,'kugou-krc');
  });

  test(`${label}: final top candidate does not wait for hanging lower sources; no coverage ranking`, async () => {
    const h=load(mobile);h.fetchers['lrc-red']=async()=>packet('lrc-red-karaoke');h.fetchers.kugou=()=>new Promise(()=>{});
    assert.equal((await h.run({waitForAutoCompletion:true})).source,'lrc-red-karaoke');
    h.fetchers['lrc-red']=async()=>packet('lrc-red-line');h.fetchers.kugou=async()=>packet('kugou-krc');
    const short=packet('kugou-krc');short.lyrics[0].lineEndTime=2000;short.lyrics[0].syllables[0].endTime=2000;
    h.fetchers.kugou=async()=>clone(short);
    assert.equal((await h.run({waitForAutoCompletion:true},{...baseTrack,durationMs:200000})).source,'kugou-krc','a long instrumental outro is not a cross-provider coverage penalty');
  });

  test(`${label}: timeout completion permits a late superior upgrade and never caches the provisional choice`, async () => {
    const {fetchers,run,time}=load(mobile),late=deferred();let complete=0;const progress=[],cache=new Map();
    fetchers['lrc-red']=async()=>packet('lrc-red-karaoke');fetchers['spicy-lyrics']=()=>late.promise;
    assert.equal((await run({sourceCache:cache,onProgress:p=>progress.push(p.source),onAutoComplete:()=>complete++})).source,'lrc-red-karaoke');
    await time.advance(30);assert.equal(complete,1);assert.equal(cache.has('auto'),false);
    late.resolve(packet('spicy-lyrics-syllable','community',{source:'spicy_lyrics'}));await flush();
    assert.deepEqual(progress,['lrc-red-karaoke','spicy-lyrics-syllable']);assert.equal(cache.get('auto').source,'spicy-lyrics-syllable');
  });

  test(`${label}: transient superior failure is retried, malformed timing is rejected and instrumental survives`, async()=>{
    const h=load(mobile);let calls=0;const cache=new Map();
    h.fetchers['lrc-red']=async()=>{if(++calls===1)throw Error('HTTP 503');return packet('lrc-red-karaoke');};h.fetchers.kugou=async()=>packet('kugou-krc');
    assert.equal((await h.run({waitForAutoCompletion:true,sourceCache:cache})).source,'kugou-krc');assert.equal(cache.has('auto'),false);
    assert.equal((await h.run({waitForAutoCompletion:true,sourceCache:cache})).source,'lrc-red-karaoke');assert.equal(calls,2);
    h.fetchers['lrc-red']=async()=>{const p=packet('lrc-red-karaoke');p.lyrics[0].lineStartTime=NaN;return p;};h.fetchers.kugou=async()=>null;
    h.fetchers.lrclib=async()=>({lyrics:[],source:'lrclib',metadata:{instrumental:true}});
    assert.equal((await h.run({waitForAutoCompletion:true})).metadata.instrumental,true);
  });

  test(`${label}: service deduplicates in-flight auto, isolates stale track/manual/force callbacks and reuses per-track final cache`,async()=>{
    const h=load(mobile), service=h.service(), late=deferred();let lrcCalls=0,kugouCalls=0;
    h.fetchers['lrc-red']=async()=>{lrcCalls++;return packet('lrc-red-line');};h.fetchers.kugou=()=>{kugouCalls++;return late.promise;};
    const a=[],b=[];
    await Promise.all([service.fetchSyncedLyrics(baseTrack,{onSyncedLyrics:p=>a.push(p.source)}),service.fetchSyncedLyrics(baseTrack,{onSyncedLyrics:p=>b.push(p.source)})]);
    assert.equal(lrcCalls,1);assert.equal(kugouCalls,1);
    h.fetchers.lrclib=async()=>packet('lrclib');
    await service.fetchSyncedLyrics(baseTrack,{preferredSource:'lrclib',onSyncedLyrics:p=>a.push(p.source)});
    const count=a.length;late.resolve(packet('kugou-krc'));await flush();assert.equal(a.length,count,'late auto cannot overwrite manual');
    assert.equal(service.getCachedSourceLyricsPacket(baseTrack.trackId,'auto').source,'kugou-krc|'+(mobile?'mobile':'desktop'));
    const old=deferred();h.fetchers.kugou=()=>old.promise;
    await service.fetchSyncedLyrics({...baseTrack,trackId:'old'},{onSyncedLyrics:p=>a.push(p.source)});
    await service.fetchSyncedLyrics({...baseTrack,trackId:'new'},{preferredSource:'lrclib',onSyncedLyrics:p=>b.push(p.source)});
    const bCount=b.length;old.resolve(packet('kugou-krc'));await flush();assert.equal(b.length,bCount);assert.equal(service.getMusixmatchRuntimeStatus().activeTrackSourceCacheTrackId,'new');
    await service.fetchSyncedLyrics(baseTrack);assert.equal(lrcCalls,2,'returning to the first track uses its final auto choice; only old-track request added an LRC call');
    const beforeForce=lrcCalls;h.fetchers.kugou=async()=>packet('kugou-krc');
    await service.fetchSyncedLyrics(baseTrack,{force:true});assert.equal(lrcCalls,beforeForce+1,'force bypasses every source and final cache');
    await service.fetchSyncedLyrics({...baseTrack,durationMs:11000});assert.equal(lrcCalls,beforeForce+2,'recording duration change invalidates the old recording cache');
    await h.time.advance(30*60_000+1);await service.fetchSyncedLyrics({...baseTrack,durationMs:11000});assert.equal(lrcCalls,beforeForce+3,'successful source caches have bounded TTL');
    service.clearCache();
  });

  test(`${label}: service late winner remains active after timeout, but an old forced run cannot poison new cache`,async()=>{
    const h=load(mobile),service=h.service(),late=deferred();const delivered=[];let spicyCalls=0;
    h.fetchers['lrc-red']=async()=>packet('lrc-red-line');h.fetchers['spicy-lyrics']=()=>{spicyCalls++;return late.promise;};
    await service.fetchSyncedLyrics(baseTrack,{onSyncedLyrics:p=>delivered.push(p.source)});
    await h.time.advance(3000);
    await service.fetchSyncedLyrics(baseTrack);
    assert.equal(spicyCalls,1,'a bounded completion deadline does not duplicate a still-pending provider');
    late.resolve(packet('spicy-lyrics-syllable','community',{source:'spicy_lyrics'}));await flush();
    assert.equal(delivered.at(-1),'spicy-lyrics-syllable|'+(mobile?'mobile':'desktop'));
    const stale=deferred();h.fetchers['spicy-lyrics']=()=>stale.promise;
    await service.fetchSyncedLyrics(baseTrack,{force:true,onSyncedLyrics:p=>delivered.push(p.source)});
    h.fetchers['spicy-lyrics']=async()=>null;h.fetchers['lrc-red']=async()=>packet('lrc-red-karaoke');
    await service.fetchSyncedLyrics(baseTrack,{force:true,onSyncedLyrics:p=>delivered.push(p.source)});await flush();
    const count=delivered.length;stale.resolve(packet('spicy-lyrics-syllable','stale',{source:'spicy_lyrics'}));await flush();
    assert.equal(delivered.length,count);assert.equal(service.getCachedSourceLyricsPacket(baseTrack.trackId,'auto').source,'lrc-red-karaoke|'+(mobile?'mobile':'desktop'));
    service.clearCache();
  });
}
