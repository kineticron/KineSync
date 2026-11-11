/* global __dirname */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const timers=new Map();let next=0;
const moduleScope={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname,'../lib/scanner-session.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{
 module:moduleScope,exports:moduleScope.exports,setTimeout:(fn,ms)=>{timers.set(++next,{fn,ms});return next;},clearTimeout:id=>timers.delete(id),
});
const {ScannerSession}=moduleScope.exports;
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
async function main(){
 const session=new ScannerSession();let called=0;
 for(const [key,ms] of [['open',350],['error',3000],['failure',5000]]){
  const run=session.begin();session.schedule(run,key,()=>called++,ms);
  const queued=[...timers.values()][0].fn;
  session.close();session.begin();queued();assert.equal(called,0,'queued old delay cannot enter reopened session');
  assert.equal(timers.size,0);
 }
 const source=fs.readFileSync(path.resolve(__dirname,process.argv.includes('--onboarding') ? '../components/onboarding/onboarding-screen.tsx' : '../components/lyrics/settings-menu.tsx'),'utf8');
 const ast=ts.createSourceFile('settings.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),callbacks=new Map();
 function visit(node){if(ts.isVariableDeclaration(node)&&node.initializer)callbacks.set(node.name.getText(ast),node.initializer.getText(ast));ts.forEachChild(node,visit);}visit(ast);
 let resolveSave,resolvePermission,reconnects=0,opened=0;
 const scope=vm.createContext({useCallback:fn=>fn,scannerSession:session,scanHandled:{current:false},scanFailTimer:{current:null},
  setupSaving:{current:false},pendingQrSave:{current:null},setupGeneration:{current:0},setScanCompleted(){},setServerUrlStore(){},setHandshakeKeyStore(){},setPlaybackModeStore(){},cameraPermission:{granted:false},requestCameraPermission:()=>new Promise(done=>{resolvePermission=done;}),
  closeScanner:()=>session.close(),setScanError(){},setScannerOpen:value=>{if(value)opened++;},onClose(){},
  parseBridgeWebSocketUrl:x=>x,isValidBridgeKey:()=>true,
  saveBridgeSettings:()=>new Promise(done=>{resolveSave=done;}),
  usePlaybackStore:{getState:()=>({setServerUrl(){},setHandshakeKey(){}})},bridgeClient:{reconnectNow:()=>reconnects++},
  setTimeout:(fn,ms)=>{timers.set(++next,{fn,ms});return next;},clearTimeout:id=>timers.delete(id),
 });
 for(const name of ['handleBarcodeScanned','openScanner'])vm.runInContext(ts.transpile(`const ${name}=${callbacks.get(name)};`,{target:ts.ScriptTarget.ES2022}),scope);
 vm.runInContext('openScanner()',scope);session.close();resolvePermission({status:'granted'});await flush();
 for(const task of [...timers.values()])task.fn();assert.equal(opened,0,'old permission result cannot reopen scanner');timers.clear();
 session.begin();scope.scanHandled.current=false;
 vm.runInContext(`handleBarcodeScanned({data:JSON.stringify({u:'ws://localhost:3001',k:'key'})})`,scope);
 session.close();resolveSave({serverUrl:'ws://localhost:3001',handshakeKey:'key'});await flush();
 assert.equal(reconnects,0,'save result from closed scanner cannot reconnect');
 console.log('Scanner sessions PASS: all named delays, close/reopen, queued callbacks, permission/save supersession.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
