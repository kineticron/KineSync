// Local browser harness for the exact HTML and bundle embedded in the WebView.
// Run from ExpoLyrics: node scripts/preview-lyrics-renderers.cjs
/* global __dirname */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
// Optional ignored, locally fetched provider payload for reproducing real songs.
const fixture = process.argv[2] ? JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8')) : null;
const source = fs.readFileSync(path.join(root, 'components/lyrics/web-lyrics-view.tsx'), 'utf8');
const bundle = fs.readFileSync(path.join(root, 'components/lyrics/spicy-webview-bundle.ts'), 'utf8');
const globals = {};
for (const name of ['SPICY_WEBVIEW_JS', 'SPICY_WEBVIEW_CSS']) {
  globals[name] = JSON.parse(bundle.match(new RegExp('export const ' + name + ' = (.+);'))[1]);
}
// Only these two pure helpers are needed; avoid importing react-native-webview in Node.
const ast = ts.createSourceFile('host.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const helpers = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && ['escapeScript', 'createWebLyricsHtml'].includes(node.name?.text)).map((node) => node.getText(ast)).join('\n');
vm.runInNewContext(ts.transpileModule(helpers + '\nglobalThis.result = createWebLyricsHtml();', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, globals);
// Instrument only the fixture, never the app bundle, to catch idle RAF polling.
const renderer = globals.result.replace('<script>', `<script>
window.lyricsTestFrames = 0;
window.lyricsFrameSamples = [];
const nativeRaf = window.requestAnimationFrame.bind(window);
window.requestAnimationFrame = callback => nativeRaf(time => {
  window.lyricsTestFrames++;
  const start = performance.now(); callback(time);
  if (window.lyricsFrameSamples.length < 7200) window.lyricsFrameSamples.push({time, work: performance.now()-start});
});
</script><script>`);
const harness = `<!doctype html><meta charset="utf-8"><title>Lyrics renderer checks</title>
<style>body{background:#161c28;color:white;font:15px system-ui;margin:20px}button{font:inherit;padding:8px;margin:4px}iframe{display:block;border:1px solid #566073;background:linear-gradient(#283650,#171c2a);width:390px;height:600px}pre{white-space:pre-wrap} .controls{max-width:1000px;margin-bottom:12px}</style>
<div class="controls"><button id="portrait">Portrait</button><button id="landscape">Landscape</button><button id="play">Play</button><button id="pause">Pause</button><button id="seek">Seek to duet</button><button id="static">Static lyrics</button><button id="checks">Run browser checks</button><button id="fixture">Load local fixture</button><button id="profile">Profile 10 seconds</button></div>
<iframe id="renderer" src="/renderer"></iframe><pre id="results">Loading renderer…</pre>
<script>
const frame=document.getElementById('renderer');
const results=document.getElementById('results');
const sentences=['A quiet light across the sky','We hold a note together','An answering voice','A line with enough words to wrap naturally across several rows','光の中で歌う','The rhythm carries on','A final shining word'];
const lines=Array.from({length:70},(_,i)=>{const start=1000+i*4000;const words=sentences[i%sentences.length].split(' ');return {lineStartTime:start,lineEndTime:start+3500,syllables:words.map((text,j)=>({text:text+(j===words.length-1?'':' '),startTime:start+j*3500/words.length,endTime:start+(j+1)*3500/words.length})),...(i===1?{backgroundSyllables:[{text:'echo',startTime:start+1000,endTime:start+4700}],translatedText:'A translated line',backgroundTranslatedText:'Echo translation'}:{}),...(i===2?{oppositeAligned:true}:{})}});
let position=5500,playing=false,landscape=false,scale=1;
const send=m=>frame.contentWindow.KineSyncLyrics.receive(m);
const options=()=>send({type:'options',fontScale:scale,landscapeMode:landscape,showTranslatedText:true,tapToSeekEnabled:true,autoFollowEnabled:true});
const sync=(force=true)=>send({type:'sync',positionMs:position,isPlaying:playing,durationMs:300000,force});
const load=()=>{options();send({type:'setLyrics',lines,timingMode:'karaoke',lastLyricEndTime:lines.at(-1).lineEndTime,songwriters:['Sample writer']});sync()};
frame.onload=()=>{load();results.textContent='Ready: actual bundled WebView renderer, 70 fixture lines.'};
document.getElementById('portrait').onclick=()=>{landscape=false;frame.style.width='390px';frame.style.height='600px';options();sync()};
document.getElementById('landscape').onclick=()=>{landscape=true;frame.style.width='620px';frame.style.height='350px';options();sync()};
document.getElementById('play').onclick=()=>{playing=true;sync()};
document.getElementById('pause').onclick=()=>{playing=false;sync()};
document.getElementById('seek').onclick=()=>{position=10500;sync()};
document.getElementById('static').onclick=()=>{send({type:'setLyrics',lines:lines.slice(0,7),timingMode:'static'});sync()};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const waitFor=async(predicate,timeoutMs=1600)=>{const deadline=performance.now()+timeoutMs;while(performance.now()<deadline){if(predicate())return true;await wait(40)}return predicate()};
document.getElementById('fixture').onclick=async()=>{
  const payload=await fetch('/fixture').then(response=>response.json());
  if(!payload?.lyrics?.length){results.textContent='Start the harness with a local provider JSON path to load a real song.';return}
  options();send({type:'setLyrics',lines:payload.lyrics,timingMode:'karaoke'});
  position=payload.lyrics[0].lineStartTime;playing=false;sync();
  results.textContent='Loaded '+payload.source+': '+payload.lyrics.length+' lines from the local fixture.';
};
document.getElementById('profile').onclick=async()=>{
  playing=true;sync();await wait(500);
  const w=frame.contentWindow;w.lyricsFrameSamples=[];await wait(10000);
  const samples=w.lyricsFrameSamples.slice();playing=false;sync(false);
  const intervals=samples.slice(1).map((sample,i)=>sample.time-samples[i].time);
  const percentile=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.floor((values.length-1)*p)].toFixed(2):'n/a';
  results.textContent=JSON.stringify({frames:samples.length,callbackWorkP95Ms:percentile(samples.map(s=>s.work),.95),
    frameIntervalMedianMs:percentile(intervals,.5),frameIntervalP95Ms:percentile(intervals,.95),
    intervalsOver120HzBudget:intervals.filter(ms=>ms>12.5).length,
    note:'Browser RAF/callback timings only; verify native presented frames on a physical 120Hz device.'},null,2);
};
document.getElementById('checks').onclick=async()=>{
  const messages=[]; const check=(condition,label)=>{if(!condition)throw new Error(label);messages.push('PASS '+label);results.textContent=messages.join('\\n')};
  try {
    landscape=false;scale=1;position=5500;playing=false;frame.style.width='390px';frame.style.height='600px';load();await wait(800);
    const d=frame.contentDocument;const w=frame.contentWindow;const scroll=d.querySelector('.LyricsContent');
    const row=()=>d.querySelectorAll('.ks-lyric-row')[1];const lead=()=>row().querySelector('.line');
    check(d.querySelectorAll('.ks-lyric-row').length===70,'all source rows rendered');
    check(Math.abs(parseFloat(w.getComputedStyle(lead()).fontSize)-33.6)<.1,'native portrait font size');
    check(Math.abs(lead().getBoundingClientRect().left-28)<1,'native portrait text inset');
    check(Math.abs(row().getBoundingClientRect().top)<2,'active row uses native top anchor');
    check(row().querySelector('.bg-line')!==null,'background belongs to the lead row');
    const originalHeight=row().offsetHeight;position=10000;sync();await wait(650);
    check(row().offsetHeight===originalHeight,'background completion does not change row height');
    check(scroll.scrollWidth===scroll.clientWidth,'wrapped text does not overflow horizontally');
    position=lines.at(-1).lineStartTime+1000;sync();
    check(await waitFor(()=>Math.abs(d.querySelector('.ks-lyric-row:last-child').getBoundingClientRect().top)<2),'last row reaches the top anchor');
    position=1500;sync();
    check(await waitFor(()=>Math.abs(d.querySelector('.ks-lyric-row').getBoundingClientRect().top)<2),'backward seek restores first row (top '+d.querySelector('.ks-lyric-row').getBoundingClientRect().top+')');
    landscape=true;scale=.9;frame.style.width='620px';frame.style.height='350px';position=5500;options();sync();await wait(800);
    check(Math.abs(parseFloat(w.getComputedStyle(lead()).fontSize)-30.24)<.1,'landscape font follows only the supplied scale');
    check(row().classList.contains('ks-align-right'),'landscape lead aligns right');
    check(!d.querySelectorAll('.ks-lyric-row')[2].classList.contains('ks-align-right'),'landscape duet reverses alignment');
    check(Math.abs(row().getBoundingClientRect().top-32)<2,'landscape uses the native 32px anchor');
    options();send({type:'setLyrics',lines:lines.slice(0,7),timingMode:'static'});await wait(150);
    check(!d.getElementById('staticLyricsRoot').hidden && d.getElementById('SpicyLyricsPage').hidden,'static host switches cleanly');
    check(Math.abs(parseFloat(w.getComputedStyle(d.querySelector('.static-lyrics-line')).fontSize)-23.4)<.1,'static font stays at 26 times scale');
    check(d.querySelector('.static-lyrics-translation')!==null,'static translation preserved');
    landscape=false;scale=1;frame.style.width='390px';frame.style.height='600px';load();await wait(700);
    send({type:'options',fontScale:1,landscapeMode:false,showTranslatedText:true,tapToSeekEnabled:true,autoFollowEnabled:false});scroll.scrollTop=1000;position=10500;sync(false);await wait(650);
    check(Math.abs(scroll.scrollTop-1000)<2,'disabled auto-follow preserves manual position');
    send({type:'options',fontScale:1,landscapeMode:false,showTranslatedText:true,tapToSeekEnabled:true,autoFollowEnabled:true,resumeAutoFollowSignal:1});await wait(650);
    check(Math.abs(d.querySelectorAll('.ks-lyric-row')[2].getBoundingClientRect().top)<2,'resume returns to active row');
    check(d.querySelectorAll('.ks-lyric-row:not(.ks-offscreen)').length<20,'only nearby rows paint on a 70-line song');
    const gapLines=[{lineStartTime:1000,lineEndTime:2000,syllables:[{text:'First line',startTime:1000,endTime:2000}]},{lineStartTime:4000,lineEndTime:5000,syllables:[{text:'Ready next',startTime:4000,endTime:5000}]},{lineStartTime:10000,lineEndTime:11000,syllables:[{text:'After the pause',startTime:10000,endTime:11000}]}];
    send({type:'setLyrics',lines:gapLines,timingMode:'karaoke'});position=3000;playing=false;sync();await wait(650);
    const gapRow=d.querySelectorAll('.ks-lyric-row')[1];
    check(gapRow.classList.contains('ks-preactive'),'short gap preactivates the upcoming scroll target');
    check(Math.abs(gapRow.getBoundingClientRect().top)<2,'preactivation matches the scrolled row');
    check(w.getComputedStyle(gapRow.querySelector('.line')).opacity==='1','upcoming line has active brightness');
    const upcomingRevealToken=gapRow.querySelector('.line:not(.musical-line)')?.querySelector('.word, .letter');
    check(upcomingRevealToken && w.getComputedStyle(upcomingRevealToken).getPropertyValue('--gradient-position').trim()==='-20%','advance highlight does not start the word reveal');
    const idleFrames=w.lyricsTestFrames;await wait(450);
    check(w.lyricsTestFrames===idleFrames,'paused settled renderer schedules zero animation frames');
    position=4500;sync();await wait(650);
    check(!gapRow.classList.contains('ks-preactive') && gapRow.querySelector('.line').classList.contains('Active'),'real start hands over to normal reveal');
    position=7000;sync();await wait(650);
    check(!d.querySelector('.ks-preactive') && d.querySelector('.ks-pause-dots:not([hidden])'),'long gaps retain the interlude');
    position=9600;sync();await wait(650);
    check(d.querySelectorAll('.ks-lyric-row')[2].classList.contains('ks-preactive'),'interlude exit preactivates 500ms before the next line');
    position=1500;playing=true;sync();await wait(100);
    send({type:'visibility',active:false});const hiddenFrames=w.lyricsTestFrames;await wait(250);
    check(w.lyricsTestFrames===hiddenFrames,'inactive WebView stops immediately during playback');
    send({type:'visibility',active:true});await wait(100);
    check(w.lyricsTestFrames>hiddenFrames,'foreground WebView wakes and resumes playback');
    playing=false;sync();await wait(4500);const finalFrames=w.lyricsTestFrames;await wait(300);
    check(w.lyricsTestFrames===finalFrames,'pause allows springs to settle then returns to zero RAF work');
    const spacingLine={lineStartTime:1000,lineEndTime:6000,syllables:[{text:'한',startTime:1000,endTime:1500},{text:'글 ',startTime:1500,endTime:2000},{text:'테',startTime:2000,endTime:2500},{text:'스',startTime:2500,endTime:3000},{text:'트',startTime:3000,endTime:3500}]};
    send({type:'setLyrics',lines:[spacingLine],timingMode:'karaoke'});position=4000;sync();await wait(650);
    const koreanLine=d.querySelector('.line:not(.musical-line)');
    check(koreanLine.textContent==='한글 테스트','KRC literal text and word spaces survive rendering');
    check(koreanLine.querySelectorAll('.word-group').length===2,'KRC syllables group by actual word boundaries');
    const koreanWords=[...koreanLine.querySelectorAll('.word')];
    check(koreanWords.every(word=>w.getComputedStyle(word,'::after').content==='none'),'no synthetic gaps are added between KRC syllables');
    check(w.getComputedStyle(koreanWords[1]).whiteSpace==='pre-wrap','KRC trailing spaces occupy their original width');
    results.textContent=messages.join('\\n')+'\\nAll browser checks passed.';
  } catch(error){results.textContent=messages.join('\\n')+'\\nFAIL '+error.message}
};
</script>`;
http.createServer((request, response) => {
  if (request.url === '/fixture') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(fixture));return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(request.url === '/renderer' ? renderer : harness);
}).listen(8766, '127.0.0.1', () => console.log('Lyrics preview: http://127.0.0.1:8766'));
