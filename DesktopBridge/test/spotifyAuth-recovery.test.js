const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,'../src/spotifyAuth.js'),'utf8');
const flush = async()=>{for(let i=0;i<50;i++)await Promise.resolve();};
function harness(failures=1){
  let windows=0, logins=0, cookie='cookie', next=0;
  const timers=new Map();
  class Window {
    constructor(){const number=++windows;this.webContents={setUserAgent(){},executeJavaScript:async()=>JSON.stringify({accessToken:'a-valid-test-token-over-twenty-characters',accessTokenExpirationTimestampMs:Date.now()+3600000}),debugger:{attach(){if(number<=failures)throw Error('silent failure');},detach(){},on(){},sendCommand:async()=>({})}};}
    loadURL(){}destroy(){}
  }
  const context={module:{exports:{}},URL,Date,Buffer,setTimeout:(fn,ms)=>{const id=++next;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),setInterval(){},clearInterval(){},require:name=>{assert.equal(name,'electron');return {BrowserWindow:Window,session:{defaultSession:{cookies:{get:async()=>[{value:'cookie'}],set:async()=>{},remove:async()=>{}}}}};}};
  vm.runInNewContext(source,context);
  const auth=context.module.exports.createSpotifyAuth({getSpDcCookie:()=>cookie,setSpDcCookie:value=>{cookie=value;}});
  auth.startLogin=async()=>{logins++;return {ok:true};};
  return {auth,timers,get windows(){return windows;},get logins(){return logins;},async extract(){for(const [id,t]of [...timers])if(t.ms===8000){timers.delete(id);t.fn();}await flush();}};
}
test('silent failure then interactive success: concurrent getters settle once without self-dependent refresh',async()=>{
 const h=harness();const first=h.auth.getAccessToken({forceRefresh:true,interactiveOnFailure:true});const second=h.auth.getAccessToken();await flush();assert.equal(h.windows,2);assert.equal(h.logins,1);await h.extract();const tokens=await Promise.all([first,second]);assert.equal(tokens[0],tokens[1]);assert(tokens[0].length>20);assert.equal(h.timers.size,0);assert.equal(await h.auth.getAccessToken(),tokens[0]);assert.equal(h.windows,2);
});
test('interactive failure releases flight and next getter can retry',async()=>{
 const h=harness();h.auth.startLogin=async()=>{throw Error('user canceled');};await assert.rejects(h.auth.getAccessToken({interactiveOnFailure:true}),/user canceled/);const retry=h.auth.getAccessToken();await flush();await h.extract();assert((await retry).length>20);assert.equal(h.timers.size,0);
});
test('failed noninteractive exchanges release flight for a later retry',async()=>{
 const h=harness(2);await assert.rejects(h.auth.getAccessToken(),/CDP attach failed/);await assert.rejects(h.auth.getAccessToken(),/CDP attach failed/);assert.equal(h.windows,2);assert.equal(h.timers.size,0);
});
test('logout during fallback rejects obsolete refresh and prevents cached token restoration',async()=>{
 const h=harness();let login;h.auth.startLogin=()=>new Promise(resolve=>{login=resolve;});const pending=h.auth.getAccessToken({interactiveOnFailure:true});const rejected=assert.rejects(pending,/session changed/);await flush();h.auth.logout();login({ok:true});await rejected;assert.equal(h.windows,1);assert.equal(await h.auth.getAccessToken(),'');assert.equal(h.timers.size,0);
});
test('logout during second hidden exchange fences its late token',async()=>{
 const h=harness();const pending=h.auth.getAccessToken({interactiveOnFailure:true});const rejected=assert.rejects(pending,/session changed/);await flush();assert.equal(h.windows,2);h.auth.logout();await h.extract();await rejected;assert.equal(await h.auth.getAccessToken(),'');assert.equal(h.timers.size,0);
});
