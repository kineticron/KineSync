/* global __dirname */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {execFileSync}=require('node:child_process');
const {buildSync}=require('esbuild');
const filename=path.join(__dirname,'../components/lyrics/native/native-lyrics-model.ts');
const original=execFileSync('git',['show','0b3c5ce31492146095d6537ed40b6894f0f5f45a:ExpoLyrics/components/lyrics/native/native-lyrics-model.ts'],{encoding:'utf8'});
function run(source){
 let calls=0;
 const code=buildSync({stdin:{contents:source,resolveDir:path.dirname(filename),loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false,external:['../../../lib/graphemes']}).outputFiles[0].text;
 const split=require('unicode-segmenter/grapheme').splitGraphemes;
 const m={exports:{}};vm.runInNewContext(code,{module:m,exports:m.exports,require:()=>({getGraphemes(text){calls++;return Array.from(split(text));}})});
 const outputs=[];
 for(const style of ['amll','spicy']) for(const id of ['US5TA1500050','ZZA0P2622376','KRMIM2652961','USUM72601821','GBUM71805979']){
  const {lyrics}=require('../lib/lyrics-ttml-import').parseTtmlToLyrics(fs.readFileSync(path.join(__dirname,'../../DesktopBridge/test/fixtures/lrc-red',id+'.ttml'),'utf8'));
  outputs.push(JSON.parse(JSON.stringify(m.exports.buildNativeRows(lyrics,style))));
 }
 return {calls,outputs};
}
const before=run(original),after=run(fs.readFileSync(filename,'utf8'));
assert.deepEqual(after.outputs,before.outputs,'all completed model fields preserve five TTML corpora in both styles');
assert.ok(after.calls<before.calls,'discarded preliminary model grapheme work removed');
console.log(JSON.stringify({baselineGetGraphemesCalls:before.calls,candidateGetGraphemesCalls:after.calls,scope:'actual models; isolated uncached grapheme boundary counts, not production segmenter misses or latency'}));
