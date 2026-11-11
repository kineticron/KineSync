/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,'../lib/bridge-client.ts'),'utf8'), {
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText;
function harness() {
  let now=0, next=0, ingested=0;
  const timers=new Map(), sockets=[];
  const state={serverUrl:'ws://localhost:3001',handshakeKey:'fixture',simulatedLatencyMs:0,packetDropRate:0,
    setConnectionStatus(){},setErrorMessage(){},ingestPacket(){ingested++;return {trackChanged:false};}};
  class Socket {
    static OPEN=1; readyState=1; sent=[];
    constructor(){sockets.push(this);}
    send(data){this.sent.push(JSON.parse(data));}
    close(){this.readyState=3;this.onclose?.();}
    event(data){this.onmessage?.({data:JSON.stringify(data)});}
  }
  const module={exports:{}};
  vm.runInNewContext(code,{module,exports:module.exports,WebSocket:Socket,Math,Date,
    setTimeout:(fn,ms)=>{timers.set(++next,{fn,at:now+ms});return next;},clearTimeout:id=>timers.delete(id),
    require:name=>({
      '@/store/playback-store':{usePlaybackStore:{getState:()=>state},startPlaybackClock(){},stopPlaybackClock(){}},
      '@/lib/network':{isValidBridgeKey:()=>true,parseBridgeWebSocketUrl:x=>x},
      '@/lib/bridge-validation':{validateInboundBridgePacket:raw=>JSON.parse(raw)},
    })[name],
  });
  const client=module.exports.bridgeClient;
  const authenticate=()=>{const ws=sockets.at(-1);ws.onopen();ws.event({type:'hello:ack',ok:true});return ws;};
  return {client,state,sockets,timers,authenticate,get ingested(){return ingested;},
    advance(ms){const end=now+ms;for(;;){const e=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!e)break;timers.delete(e[0]);now=e[1].at;e[1].fn();}now=end;},
  };
}
async function main(){
  const h=harness();
  h.client.connect();h.authenticate().onclose();
  assert.equal(h.timers.size,1);
  h.client.connect();const replacement=h.authenticate();
  h.advance(5000);
  assert.equal(h.sockets.length,2,'direct connect consumes scheduled reconnect');
  assert.equal(replacement.readyState,1);
  h.client.disconnect();assert.equal(h.timers.size,0);
  for (const terminal of ['disconnect','replacement','close','error']) {
    const delayed=harness(); delayed.state.simulatedLatencyMs=100;
    delayed.client.connect(); const ws=delayed.authenticate();
    const lateMessage=ws.onmessage;
    ws.event({type:'playback',trackId:'old'});
    if(terminal==='disconnect') delayed.client.disconnect();
    if(terminal==='replacement') { delayed.client.connect(); delayed.authenticate(); }
    if(terminal==='close') ws.onclose();
    if(terminal==='error') ws.onerror();
    delayed.advance(101);
    assert.equal(delayed.ingested,0, `${terminal} retires simulated delivery`);
    lateMessage({data:JSON.stringify({type:'playback',trackId:'old-callback'})}); delayed.advance(101);
    assert.equal(delayed.ingested,0, `${terminal} rejects queued old socket callbacks`);
    delayed.client.disconnect(); assert.equal(delayed.timers.size,0);
  }
  console.log('Bridge lifetime PASS: direct connect consumes retry.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
