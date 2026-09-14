// Local browser harness for the exact HTML and bundle embedded in the WebView.
// Run from ExpoLyrics: node scripts/preview-lyrics-renderers.cjs
/* global __dirname */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
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
const renderer = globals.result;
const harness = `<!doctype html><meta charset="utf-8"><title>Lyrics renderer checks</title>
<style>body{background:#161c28;color:white;font:15px system-ui;margin:20px}button{font:inherit;padding:8px;margin:4px}iframe{display:block;border:1px solid #566073;background:linear-gradient(#283650,#171c2a);width:390px;height:600px}pre{white-space:pre-wrap} .controls{max-width:1000px;margin-bottom:12px}</style>
<div class="controls"><button id="portrait">Portrait</button><button id="landscape">Landscape</button><button id="play">Play</button><button id="pause">Pause</button><button id="seek">Seek to duet</button><button id="static">Static lyrics</button><button id="checks">Run browser checks</button></div>
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
    position=lines.at(-1).lineStartTime+1000;sync();await wait(650);
    check(Math.abs(d.querySelector('.ks-lyric-row:last-child').getBoundingClientRect().top)<2,'last row reaches the top anchor');
    position=1500;sync();await wait(650);
    check(Math.abs(d.querySelector('.ks-lyric-row').getBoundingClientRect().top)<2,'backward seek restores first row');
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
    results.textContent=messages.join('\\n')+'\\nAll browser checks passed.';
  } catch(error){results.textContent=messages.join('\\n')+'\\nFAIL '+error.message}
};
</script>`;
http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(request.url === '/renderer' ? renderer : harness);
}).listen(8766, '127.0.0.1', () => console.log('Lyrics preview: http://127.0.0.1:8766'));
