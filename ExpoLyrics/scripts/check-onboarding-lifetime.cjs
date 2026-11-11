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
    const context = vm.createContext({useCallback:fn=>fn, playbackMode:'phone', setupGeneration:{current:0}, setupSaving:{current:false}, pendingQrSave:{current:null}, closeScanner(){},
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
  for (const order of ['qr-first','finish-first','qr-first-dispose']) {
    const saves=[], activated=[], setupGeneration={current:0}, pendingQrSave={current:null};let dismissed=0, scanning=true;
    const scannerSession={current:()=>scanning?1:null,isCurrent:run=>scanning&&run===1,cancel(){},schedule(){},close(){scanning=false;}};
    const context=vm.createContext({useCallback:fn=>fn,playbackMode:'desktop',setupGeneration,setupSaving:{current:false},pendingQrSave,
      scannerSession,scanHandled:{current:false},setScanError(){},setScanCompleted(){},setScannerOpen(){},
      closeScanner:()=>scannerSession.close(),parseBridgeWebSocketUrl:x=>x,isValidBridgeKey:()=>true,
      saveBridgeSettings:settings=>new Promise((resolve,reject)=>saves.push({settings,resolve,reject})),
      onDismiss:()=>dismissed++,Alert:{alert(){}},setPlaybackModeStore(){},setServerUrlStore:url=>activated.push(url),setHandshakeKeyStore(){},
      bridgeClient:{disconnect(){},reconnectNow(){}},usePlaybackStore:{getState:()=>({serverUrl:'ws://old-default:3001'})},inferDefaultBridgeUrl:()=>'',
    });
    for(const name of ['handleBarcodeScanned','persistBridgeSettings','handleSkip'])vm.runInContext(ts.transpile(`const ${name}=${callbacks.get(name)};`,{target:ts.ScriptTarget.ES2022}),context);
    const scan=()=>vm.runInContext(`handleBarcodeScanned({data:JSON.stringify({u:'ws://scanned:3001',k:'scanned-key'})})`,context);
    if(order==='finish-first'){vm.runInContext('handleSkip()',context);scan();}
    else {scan();vm.runInContext('handleSkip()',context);}
    await flush();assert.equal(saves.length,1,'QR and Finish cannot queue competing saves');
    if(order==='qr-first-dispose') {setupGeneration.current++;scannerSession.close();}
    saves[0].resolve({...saves[0].settings});await flush();
    if(saves[1]) {assert.equal(saves[1].settings.serverUrl,'ws://scanned:3001','completion preserves scanned settings');saves[1].resolve({...saves[1].settings});await flush();}
    assert.equal(dismissed,order==='qr-first-dispose'?0:1);
    if(order==='qr-first-dispose')assert.equal(activated.length,0);
    if(order==='qr-first')assert.equal(activated.at(-1),'ws://scanned:3001');
  }
  for (const action of ['handleNext','handleSkip']) for (const finishBeforeFailure of [false,true]) {
    const saves=[], activated=[], errors=[], pendingQrSave={current:null};let dismissed=0, scanning=true;
    const scannerSession={current:()=>scanning?1:null,isCurrent:run=>scanning&&run===1,cancel(){},schedule(){},close(){scanning=false;}};
    const context=vm.createContext({useCallback:fn=>fn,playbackMode:'desktop',setupGeneration:{current:0},setupSaving:{current:false},pendingQrSave,
      scannerSession,scanHandled:{current:false},setScanError:message=>errors.push(message),setScanCompleted(){},setScannerOpen(){},
      closeScanner:()=>scannerSession.close(),parseBridgeWebSocketUrl:x=>x,isValidBridgeKey:()=>true,
      saveBridgeSettings:settings=>new Promise((resolve,reject)=>saves.push({settings,resolve,reject})),
      onDismiss:()=>dismissed++,Alert:{alert(){}},setPlaybackModeStore(){},setServerUrlStore:url=>activated.push(url),setHandshakeKeyStore(){},
      bridgeClient:{disconnect(){},reconnectNow(){}},usePlaybackStore:{getState:()=>({serverUrl:'ws://retry:3001'})},inferDefaultBridgeUrl:()=>'',
      isLastStep:true,itemWidth:360,reduceMotion:false,step:3,
    });
    for(const name of ['handleBarcodeScanned','persistBridgeSettings','handleNext','handleSkip'])vm.runInContext(ts.transpile(`const ${name}=${callbacks.get(name)};`,{target:ts.ScriptTarget.ES2022}),context);
    vm.runInContext(`handleBarcodeScanned({data:JSON.stringify({u:'ws://scanned:3001',k:'scanned-key'})})`,context);
    if(finishBeforeFailure) vm.runInContext(`${action}()`,context);
    saves[0].reject(Error('QR storage unavailable'));await flush();
    assert.equal(dismissed,0);assert.equal(activated.length,0,'failed QR cannot activate playback');
    vm.runInContext(`${action}()`,context);await flush();
    assert.equal(saves.length,2,'completion retries persistence after QR failure instead of awaiting its old rejection');
    assert.equal(saves[1].settings.serverUrl,'ws://retry:3001');
    saves[1].resolve({...saves[1].settings});await flush();
    assert.equal(dismissed,1,'successful completion retry dismisses setup');
    assert.equal(activated.at(-1),'ws://retry:3001');
  }
  {
    const saves=[], pendingQrSave={current:null}, scanHandled={current:false};let scanRun=1;
    const scannerSession={current:()=>scanRun,isCurrent:run=>run===scanRun,cancel(){},schedule(){}};
    const context=vm.createContext({useCallback:fn=>fn,setupGeneration:{current:0},setupSaving:{current:false},pendingQrSave,
      scannerSession,scanHandled,setScanError(){},setScanCompleted(){},closeScanner(){},
      parseBridgeWebSocketUrl:x=>x,isValidBridgeKey:()=>true,
      saveBridgeSettings:settings=>new Promise((resolve,reject)=>saves.push({settings,resolve,reject})),
      setPlaybackModeStore(){},setServerUrlStore(){},setHandshakeKeyStore(){},bridgeClient:{reconnectNow(){}},
    });
    vm.runInContext(ts.transpile(`const handleBarcodeScanned=${callbacks.get('handleBarcodeScanned')};`,{target:ts.ScriptTarget.ES2022}),context);
    const scan=()=>vm.runInContext(`handleBarcodeScanned({data:JSON.stringify({u:'ws://scanned:3001',k:'scanned-key'})})`,context);
    scan();scanRun++;scanHandled.current=false;scan();
    const replacement=pendingQrSave.current;
    saves[0].reject(Error('old QR write failed'));await flush();
    assert.equal(pendingQrSave.current,replacement,'old rejection cannot clear the newer QR owner');
    saves[1].resolve({...saves[1].settings});await flush();
  }
  // Execute the real serialized storage queue: superseded queued setup must
  // never overwrite the latest mode or mark onboarding complete.
  {
    let release;const gate=new Promise(done=>{release=done;});let writes=0,current=true;
    const module={exports:{}};
    const storage={getItem:async()=>null,setItem:async()=>{if(++writes===1)await gate;}};
    const imports={'@react-native-async-storage/async-storage':storage,'expo-secure-store':{},
      'react-native':{Platform:{OS:'web'}},'@/lib/network':{parseBridgeWebSocketUrl:x=>x,isValidBridgeKey:()=>true}};
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname,'../lib/bridge-settings.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,
      {module,exports:module.exports,require:name=>imports[name]});
    const save=module.exports.saveBridgeSettings;
    const first=save({serverUrl:'ws://first:3001'});await flush();
    const stale=save({serverUrl:'ws://stale:3001',onboardingCompleted:true},{isCurrent:()=>current});
    const rejected=assert.rejects(stale,/superseded/);current=false;
    const latest=save({serverUrl:'',handshakeKey:'',playbackMode:'mobile',onboardingCompleted:true});
    release();await first;await rejected;
    assert.equal((await latest).playbackMode,'mobile');assert.equal(writes,2,'stale queued save never writes storage');
  }
  console.log('Onboarding lifetime PASS: durable handoff, QR failure retries, replacement ownership, failure acknowledgement, supersession.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
