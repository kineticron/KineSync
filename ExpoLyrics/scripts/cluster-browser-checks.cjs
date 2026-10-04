const fs = require('node:fs');
const path = require('node:path');
const { splitGraphemes } = require('unicode-segmenter/grapheme');

function clusterCheckHtml(directory) {
  const fixtures = ['thai', 'hindi', 'telugu'].map(language => {
    const payload = JSON.parse(fs.readFileSync(path.join(directory, `${language}.json`), 'utf8'));
    // Keep the exact provider's lead text and timing. Background/translation
    // tests already live in the general preview harness.
    const lines = payload.lyrics.filter(line => line.syllables?.some(part => part.text?.trim()))
      .map(({ lineStartTime, lineEndTime, syllables }) => ({ lineStartTime, lineEndTime, syllables }));
    return { language, track: payload.track, source: payload.source, lines,
      text: lines.map(line => line.syllables.map(part => part.text || '').join('').trim()),
      boundaries: lines.map(line => {
        const text = line.syllables.map(part => part.text || '').join('').replace(/\s/gu, '');
        let offset = 0;
        return [0, ...Array.from(splitGraphemes(text), cluster => (offset += cluster.length))];
      }) };
  });
  const data = JSON.stringify(fixtures).replace(/</g, '\\u003c');
  return `<!doctype html><meta charset="utf-8"><title>Thai, Hindi and Telugu cluster checks</title>
<style>body{background:#171c28;color:white;font:15px system-ui;margin:20px}button{padding:10px;font:inherit}iframe{width:390px;height:600px;border:1px solid #566073}pre{white-space:pre-wrap}.views{display:flex;gap:12px}</style>
<h1>Real API lyrics: character cluster checks</h1><p id="status">3 fetched songs: Thai (Kugou), Hindi and Telugu (LRCLIB).</p><button id="run">Run all cluster checks</button>
<div class="views"><iframe id="spicy"></iframe><iframe id="amll"></iframe></div><pre id="results">Ready: 3 fetched songs, both embedded renderers.</pre>
<script>
const fixtures=${data};
const results=document.getElementById('results');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(condition,message)=>{if(!condition)throw new Error(message)};
const withDynamicSentinel=line=>[line,
  {lineStartTime:line.lineEndTime+10000,lineEndTime:line.lineEndTime+12000,syllables:[
    {text:'Cluster check ',startTime:line.lineEndTime+10000,endTime:line.lineEndTime+11000},
    {text:'sentinel',startTime:line.lineEndTime+11000,endTime:line.lineEndTime+12000}]}];
const splitTokens=lines=>lines.map(line=>({...line,syllables:line.syllables.flatMap(part=>{
  const pieces=Array.from(part.text||'');
  return pieces.map((text,i)=>({...part,text,
    startTime:part.startTime+(part.endTime-part.startTime)*i/pieces.length,
    endTime:part.startTime+(part.endTime-part.startTime)*(i+1)/pieces.length,
    ...(typeof part.isPartOfWord==='boolean'?{isPartOfWord:i<pieces.length-1||part.isPartOfWord}:{})}));
})}));
const open=async(style,noIntl)=>{
  const frame=document.getElementById(style);
  await new Promise(resolve=>{frame.onload=resolve;frame.src='/renderer?style='+style+(noIntl?'&noIntl=1':'')});
  return frame;
};
const inspect=(frame,style,fixture)=>{
  const d=frame.contentDocument,w=frame.contentWindow;
  const rows=[...d.querySelectorAll(style==='spicy'?'.ks-lyric-row .line:not(.bg-line,.musical-line)':'[class*="lyricMainLine"]')]
    .filter(row=>row.textContent.replace(/\\s/gu,'')!=='Clusterchecksentinel');
  check(rows.length===fixture.lines.length,style+' '+fixture.language+': row count '+rows.length);
  let atoms=0,emphasis=0;
  rows.forEach((row,i)=>{
    const text=row.textContent.replace(/\\s/gu,'');
    check(text===fixture.text[i].replace(/\\s/gu,''),style+' '+fixture.language+': text mismatch row '+i);
    const boundaries=new Set(fixture.boundaries[i]);
    let offset=0;
    const walk=node=>{
      if(node.nodeType===3){offset+=node.textContent.replace(/\\s/gu,'').length;return}
      if(node.nodeType!==1)return;
      const atomic=style==='spicy'?node.matches('.letter,.word'):
        (node.tagName==='SPAN'&&node.childNodes.length>0&&[...node.childNodes].every(n=>n.nodeType===3));
      const start=offset;
      for(const child of node.childNodes)walk(child);
      if(atomic&&offset>start){
        atoms++;check(boundaries.has(start)&&boundaries.has(offset),style+' '+fixture.language+': split cluster at '+start+'..'+offset+' row '+i);
      }
    };walk(row);
    emphasis+=row.querySelectorAll(style==='spicy'?'.letter.Emphasis':'[class*="emphasize"] > span:not([class])').length;
  });
  check(atoms>0,style+': no rendered text atoms');
  if(style==='spicy')check([...d.querySelectorAll('.word,.letter')].some(e=>w.getComputedStyle(e).backgroundImage.includes('gradient')),'Spicy gradient missing');
  else check(d.querySelector('[style*="mask-image"]'),'AMLL karaoke mask missing');
  return {rows:rows.length,atoms,emphasis};
};
document.getElementById('run').onclick=async()=>{
  const messages=[];window.clusterCheckReport={status:'running',checks:[]};
  document.getElementById('status').textContent='Checking both renderers, all 150 API lines, forced token splits and missing Intl support…';
  try{
    for(const noIntl of [false,true])for(const style of ['spicy','amll']){
      const frame=await open(style,noIntl),w=frame.contentWindow;
      if(noIntl)check(!w.Intl.Segmenter,'Intl should be unavailable in fallback fixture');
      for(const fixture of fixtures)for(const stress of [false,true]){
        const source=stress?splitTokens(fixture.lines):fixture.lines;
        const detail={rows:0,atoms:0,emphasis:0};
        // AMLL virtualizes distant rows. Render one line at a time so every
        // fetched line is checked, including those never visible at the start.
        // Keep AMLL in the song's dynamic mode when an individual API line
        // has only one token. Otherwise it selects its static text path.
        const batches=style==='amll'?source.map((line,i)=>({lines:withDynamicSentinel(line),
          expected:{...fixture,lines:[fixture.lines[i]],text:[fixture.text[i]],boundaries:[fixture.boundaries[i]]}})):
          [{lines:source,expected:fixture}];
        for(const batch of batches){
          w.KineSyncLyrics.receive({type:'setLyrics',lines:batch.lines,timingMode:'karaoke'});
          w.KineSyncLyrics.receive({type:'sync',positionMs:batch.lines[0].lineStartTime,isPlaying:false,force:true});
          await wait(style==='amll'?100:400);
          const measured=inspect(frame,style,batch.expected);
          for(const key of Object.keys(detail))detail[key]+=measured[key];
        }
        const label=style+' '+fixture.language+' '+(stress?'split-token stress':'original API timing')+' '+(noIntl?'without Intl':'with Intl');
        messages.push('PASS '+label+' '+JSON.stringify(detail));
        window.clusterCheckReport.checks.push({label,...detail});results.textContent=messages.join('\\n');
      }
      // A sustained real word exercises emphasis even for line-timed API data.
      for(const fixture of fixtures){
        const text=fixture.lines.flatMap(line=>line.syllables).map(part=>part.text?.trim())
          .find(text=>text&&text.length>1&&text.length<=7);
        const line={lineStartTime:1000,lineEndTime:5000,syllables:[{text,startTime:1000,endTime:5000}]};
        w.KineSyncLyrics.receive({type:'setLyrics',lines:style==='amll'?withDynamicSentinel(line):[line],timingMode:'karaoke'});
        w.KineSyncLyrics.receive({type:'sync',positionMs:2500,isPlaying:true,force:true});await wait(150);
        const d=frame.contentDocument;
        const row=[...d.querySelectorAll(style==='spicy'?'.line:not(.musical-line,.bg-line)':'[class*="lyricMainLine"]')]
          .find(e=>e.textContent.replace(/\\s/gu,'')===text.replace(/\\s/gu,''));
        check(row,style+' '+fixture.language+': sustained word missing');
        const emphasized=row.querySelectorAll(style==='spicy'?'.letter.Emphasis':'[class*="emphasize"] > span:not([class])');
        check(emphasized.length>0,style+' '+fixture.language+': sustained emphasis missing');
        const animations=style==='amll'?row.getAnimations({subtree:true}).filter(a=>a.id.includes('emphasize-word')).length:0;
        if(style==='amll')check(animations>0,'AMLL emphasis animations missing');
        w.KineSyncLyrics.receive({type:'sync',positionMs:2500,isPlaying:false,force:true});
        const label=style+' '+fixture.language+' sustained real word '+(noIntl?'without Intl':'with Intl');
        messages.push('PASS '+label+' emphasis='+emphasized.length+' animations='+animations);
        window.clusterCheckReport.checks.push({label,emphasis:emphasized.length,animations});results.textContent=messages.join('\\n');
      }
    }
    window.clusterCheckReport.status='passed';results.textContent=messages.join('\\n')+'\\nAll cluster checks passed.';
    document.getElementById('status').textContent='PASS: '+window.clusterCheckReport.checks.length+' checks. All 150 API lines in both renderers; split-token stress, missing Intl, karaoke masks/gradients and sustained emphasis.';
  }catch(error){window.clusterCheckReport.status='failed';window.clusterCheckReport.error=error.message;results.textContent=messages.join('\\n')+'\\nFAIL '+error.message;document.getElementById('status').textContent='FAIL: '+error.message}
};
</script>`;
}

module.exports = { clusterCheckHtml };
