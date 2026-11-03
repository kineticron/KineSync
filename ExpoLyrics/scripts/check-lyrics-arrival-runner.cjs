// Protocol-only subprocess test. Fake adb supplies no hardware or performance measurements.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arrival-runner-test-'));
try {
  const stub = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.ARRIVAL_TEST_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'commands'), JSON.stringify(args) + '\\n');
if (args.includes('logcat')) {
  let last = '';
  setInterval(() => {
    try {
      const raw = fs.readFileSync(path.join(dir, 'launch'), 'utf8');
      if (raw === last) return;
      last = raw;
      const params = new URL(raw.replace(/^'|'$/g, '')).searchParams;
      const trace = {counterSchema:1,saturated:false,dropped:0,records:['fixture-delivered-not-network','model','cues','glyph-shaping'].map(stage=>({stage,packet:1,generation:1,start:0,end:1})),counters:{modelCalls:1,cueBuilds:1,shapingCalls:1,paragraphBuilds:1,voiceRenders:1,firstPicturePublications:1},uiCounts:{complete:true,droppedOwners:0,timeouts:0,totals:{pictureBuilds:1}},unavailable:['actual first presented correct line','actual first presented correct window']};
      const data = { trace,previewPositionMs:params.get('scenario')==='start'?0:90000,playing:false,fixtureRows:100,initializedDelayMs:500,workload:'synthetic-paused-delayed-arrival-initialized-host-v2',run: params.get('run'), style: params.get('style'),
        orientation: params.get('orientation'), scenario: params.get('scenario'), evidence: 'unit-test-stub-no-timing' };
      if(process.env.ARRIVAL_INVALID==='empty')data.trace.records=[];
      if(process.env.ARRIVAL_INVALID==='saturated'){data.trace.saturated=true;data.trace.dropped=1;}
      if(process.env.ARRIVAL_INVALID==='scenario')data.scenario='wrong';
      const payload=JSON.stringify(data);
      const total = Math.ceil(payload.length / 80);
      for (let index = total - 1; index >= 0; index--) console.log('KINESYNC_ARRIVAL_CHUNK ' + JSON.stringify({
        run: params.get('run'), index, total, data: payload.slice(index * 80, (index + 1) * 80),
      }));
    } catch {}
  }, 5);
} else if (args.includes('getprop')) console.log(args.includes('ro.kernel.qemu') ? '0' : 'unit-test-stub');
else if (args.includes('get')) console.log('0');
else if (args.includes('start')) fs.writeFileSync(path.join(dir, 'launch'), args[args.indexOf('-d') + 1]);
`;
  fs.writeFileSync(path.join(dir, 'adb'), stub, { mode: 0o755 });
  const output = path.join(dir, 'result.json');
  execFileSync(process.execPath, [path.join(__dirname, 'profile-lyrics-arrival.cjs'), 'fake-unit-device', output], {
    env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH, ARRIVAL_TEST_DIR: dir }, timeout: 30000,
  });
  const result = JSON.parse(fs.readFileSync(output));
  assert.equal(result.results.length, 12);assert.equal(result.complete,true);
  assert.ok(result.results.every(row => row.evidence === 'unit-test-stub-no-timing'));
  const commands = fs.readFileSync(path.join(dir, 'commands'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(commands.filter(args => args.includes('force-stop')).length, 12);
  assert.ok(commands.at(-1).includes('accelerometer_rotation'));
  for(const invalid of ['empty','saturated','scenario']) {
    assert.throws(()=>execFileSync(process.execPath,[path.join(__dirname,'profile-lyrics-arrival.cjs'),'fake-unit-device',path.join(dir,invalid+'.json')],{
      env:{...process.env,PATH:dir+path.delimiter+process.env.PATH,ARRIVAL_TEST_DIR:dir,ARRIVAL_INVALID:invalid},timeout:10000,stdio:'pipe'
    }),/Command failed/);
    assert.equal(fs.existsSync(path.join(dir,invalid+'.json')),false,'bad evidence cannot become an accepted result');
  }
  console.log('runner evidence and subprocess protocol passed: 12 cold launches, markers, output and rotation restoration; no hardware timing measured');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

const {validateEvidence,WORKLOAD}=require('./lyrics-arrival-evidence.cjs');
const request={run:'test',style:'spicy',orientation:'portrait',scenario:'overlap'};
const valid={...request,previewPositionMs:90000,playing:false,fixtureRows:100,initializedDelayMs:500,workload:WORKLOAD,trace:{counterSchema:1,saturated:false,dropped:0,
  records:['fixture-delivered-not-network','model','cues','glyph-shaping'].map(stage=>({stage,packet:1,generation:1,start:0,end:1})),
  counters:{modelCalls:1,cueBuilds:1,shapingCalls:1,paragraphBuilds:1,voiceRenders:1,firstPicturePublications:1},
  uiCounts:{complete:true,droppedOwners:0,timeouts:0,totals:{pictureBuilds:1}},
  unavailable:['actual first presented correct line','actual first presented correct window']}};
assert.equal(validateEvidence(valid,request),valid);
for(const patch of [{trace:undefined},{trace:{...valid.trace,records:[]}},{trace:{...valid.trace,saturated:true,dropped:1}},
  {previewPositionMs:0},{playing:true},{scenario:'start'},{style:'amll'},{orientation:'landscape'},{workload:'unknown'},
  {trace:{...valid.trace,uiCounts:{complete:false}}},{trace:{...valid.trace,counters:{}}}]) assert.throws(()=>validateEvidence({...valid,...patch},request));
console.log('runner rejects missing/empty/saturated traces, mismatched scenarios and incomplete count samples; fixture data only');

const vm=require('node:vm'),ts=require('typescript');
const fixtureModule={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../lib/fixtures/lyrics-arrival-fixture.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{module:fixtureModule,exports:fixtureModule.exports});
const fixtures=fixtureModule.exports.buildArrivalFixture(true);
assert.equal(fixtureModule.exports.ARRIVAL_LAB_WORKLOAD,WORKLOAD);
assert.equal(fixtures.length,100);assert.ok(fixtures.some(line=>line.syllables.length>10));
assert.ok(fixtures.some(line=>line.spicyBackgrounds?.length===2));assert.ok(fixtures.some(line=>line.translatedText));
assert.ok(fixtures.filter(line=>line.lineStartTime<=90000&&line.lineEndTime>90000).length>3);
console.log('bounded fixture includes varied syllables, wrapping, multilingual text, two backgrounds, translations and >3 timing overlaps; no presentation claim');
