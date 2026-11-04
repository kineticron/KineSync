/* global __dirname */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {buildSync}=require('esbuild');
const file=path.join(__dirname,'../components/lyrics/native/native-lyrics-fonts.ts');
const code=buildSync({stdin:{contents:fs.readFileSync(file,'utf8'),resolveDir:path.dirname(file),loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false,external:['*']}).outputFiles[0].text;
let current=null;const mod={exports:{}};
vm.runInNewContext(code,{module:mod,exports:mod.exports,require:name=>name==='react'?{createContext:value=>({value}),useEffect:fn=>fn(),useSyncExternalStore:(_subscribe,snapshot)=>snapshot()}:name==='expo-font'?{useFonts(){}}:name==='@shopify/react-native-skia'?{useFonts:()=>current}:name});
assert.equal(mod.exports.useNativeLyricsFonts(),null);
const first={id:1};current=first;assert.equal(mod.exports.useNativeLyricsFonts(),first);
current=null;assert.equal(mod.exports.useNativeLyricsFonts(),first,'new renderer retains exact loaded provider while its local hook loads');
current={id:2};assert.equal(mod.exports.useNativeLyricsFonts(),first,'same fixed asset set reuses its owned immutable provider');
console.log('Fixed bundled font provider remains owned across concurrent renderer and track/rotation mounts.');
