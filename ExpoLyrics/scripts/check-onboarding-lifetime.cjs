/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(path.resolve(__dirname, '../components/onboarding/onboarding-screen.tsx'), 'utf8');
const ast = ts.createSourceFile('onboarding.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.initializer) callbacks.set(node.name.getText(ast), node.initializer.getText(ast));
  ts.forEachChild(node, visit);
}
visit(ast);
const flush = async () => { for (let i=0;i<30;i++) await Promise.resolve(); };
async function main() {
  for (const outcome of ['success','failure','superseded']) {
    let resolve, reject, dismissed=0;
    const saved = new Promise((yes,no) => { resolve=yes; reject=no; });
    const calls=[], errors=[];
    const context = vm.createContext({useCallback:fn=>fn, playbackMode:'phone', setupGeneration:{current:0}, setupSaving:{current:false},
      saveBridgeSettings:()=>saved, onDismiss:()=>dismissed++, Alert:{alert:(_,message)=>errors.push(message)},
      setPlaybackModeStore:mode=>calls.push(mode), setServerUrlStore:()=>{},setHandshakeKeyStore:()=>{},
      bridgeClient:{disconnect:()=>calls.push('disconnect'),reconnectNow:()=>calls.push('connect')},
      usePlaybackStore:{getState:()=>({serverUrl:'ws://localhost:3001'})},inferDefaultBridgeUrl:()=>'', console,
    });
    for (const name of ['persistBridgeSettings','handleSkip']) {
      const js=ts.transpile(`const ${name} = ${callbacks.get(name)};`, {target:ts.ScriptTarget.ES2022});
      vm.runInContext(js,context);
    }
    vm.runInContext('handleSkip()',context); await flush();
    assert.equal(dismissed,0,'onboarding cannot dismiss before durable save');
    assert.equal(calls.length,0,'activation waits for durable save');
    if(outcome==='superseded') context.setupGeneration.current++;
    if(outcome==='failure') reject(Error('storage unavailable')); else resolve({serverUrl:'',handshakeKey:'',playbackMode:'mobile'});
    await flush();
    assert.equal(dismissed,outcome==='success'?1:0);
    assert.equal(errors.length,outcome==='failure'?1:0,'save errors are acknowledged without dismissing setup');
    if(outcome==='superseded') assert.equal(calls.length,0,'superseded setup cannot activate');
  }
  console.log('Onboarding lifetime PASS: durable handoff, failure acknowledgement, supersession.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
