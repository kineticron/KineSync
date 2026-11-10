/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const { mount } = require('./check-native-glyph-idle.cjs');
const directory = path.join(__dirname, '../components/lyrics/native');
const current = fs.readFileSync(path.join(directory, 'native-glyph-picture.tsx'), 'utf8');
const original = execFileSync('git', ['show', '5e76f08:ExpoLyrics/components/lyrics/native/native-glyph-picture.tsx'], { encoding: 'utf8' });
const bundle = (contents, transform = false) => {
  if (transform) contents = require('@babel/core').transformSync(contents, {
    filename: path.join(directory, 'native-glyph-picture.tsx'), presets: ['babel-preset-expo'],
    configFile: false, babelrc: false, plugins: ['react-native-worklets/plugin'],
  }).code;
  return buildSync({ stdin: { contents, resolveDir: directory, loader: 'tsx' }, bundle: true,
    platform: 'node', format: 'cjs', write: false,
    external: ['react-native', 'react', 'react-native-reanimated', 'react-native-worklets', '@shopify/react-native-skia'],
  }).outputFiles[0].text;
};
// Protect the literal original OFF component implementations.
for (const name of ['NativeGlyphPictureDevelopment', 'NativeGlyphPictureProduction']) {
  const body = source => source.slice(source.indexOf(`const ${name} =`)).split('\n};')[0];
  assert.equal(body(current), body(original), `${name}: exact OFF implementation`);
}
const replay = Array.from({ length: 1400 }, (_, i) => {
  const s = i % 350;
  return { time: s < 160 ? 4800 + s * 1000 / 120 : s < 210 ? 6100 : s < 260 ? 14000 + s * 8 : 5200 + (s - 260) * 8,
    active: s < 160 || s >= 260, dt: [0, 1000 / 120, 1000 / 60, 100, 500][i % 5] };
});
for (const transformed of [false, true]) for (const spicy of [true, false]) for (const background of [false, true]) {
  const off = mount(bundle(original, transformed), spicy, 3, 5000, 4, null, 6800, { background });
  const on = mount(bundle(current + '\nexport { NativeGlyphPictureBuffered };', transformed), spicy, 3, 5000, 4, null, 6800,
    { background, component: 'NativeGlyphPictureBuffered' });
  let identities;
  for (const sample of replay) {
    off.active.value = on.active.value = sample.active;
    off.tick(sample.time, sample.dt); on.tick(sample.time, sample.dt);
    assert.equal(on.picture, off.picture, `exact command parity ${transformed}/${spicy}/${background}/${sample.time}`);
    assert.equal(on.pictures, off.pictures, 'same recording/idle decisions');
    assert.equal(on.notifications, off.notifications, 'same observable shared-value notifications');
    const state = on.motionState;
    assert.equal(JSON.stringify(state.floatClock), JSON.stringify(off.motionState.floatClock));
    assert.equal(JSON.stringify(state.motions), JSON.stringify(off.motionState.motions));
    assert.equal(JSON.stringify(state.words), JSON.stringify(off.motionState.words));
    const refs = [state, state.words, state.motions, state.emphasis, state.floatClock, state.nextFloatClock,
      ...state.words.flatMap(w => [w, w.word, w.word.scale, w.word.y, w.word.glow, w.letters,
        ...w.letters.flatMap(l => [l, l.scale, l.y, l.glow])]), ...state.motions.flatMap(m => [m, m.letters, ...m.letters]),
      ...state.emphasis.flatMap(e => [e, ...e])];
    if (identities) refs.forEach((ref, i) => assert.equal(ref, identities[i], 'generation-owned buffer identity'));
    identities = refs;
  }
  const independent = mount(bundle(current + '\nexport { NativeGlyphPictureBuffered };'), spicy, 1, 1200, 8, null, 2000,
    { component: 'NativeGlyphPictureBuffered' });
  independent.active.value = true; independent.tick(1400);
  assert.notEqual(independent.motionState, on.motionState, 'voice/generation ownership');
  assert.equal(independent.motionState.words.length, 1);
  const recorded = on.pictures; on.unmount(); on.tick(5700); assert.equal(on.pictures, recorded, 'cleanup disables callback');
  off.unmount(); independent.unmount();
}
// Exact equations and zero output-object/array allocation in the hot motion helpers.
{
  let objects = 0, arrays = 0;
  const entry = "export * from './motion-buffers'; export * from './reference-word-motion'; export * from './reference-motion'; export * from './amll-float-clock';";
  const bundled = buildSync({ stdin:{contents:entry,resolveDir:directory,loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false }).outputFiles[0].text;
  const instrumented = require('@babel/core').transformSync(bundled,{configFile:false,babelrc:false,plugins:[({types:t})=>({visitor:{
    'ObjectExpression|ArrayExpression': { exit(p) { const kind=p.isArrayExpression()?'array':'object'; p.replaceWith(t.callExpression(t.identifier('__allocated'),[t.stringLiteral(kind),p.node]));p.skip(); } },
  }})]}).code;
  const module={exports:{}};
  vm.runInNewContext(instrumented,{module,exports:module.exports,__allocated(kind,value){if(kind==='array')arrays++;else objects++;return value;}});
  const api=module.exports;
  const word={text:'office',start:1000,end:3000,letters:['o','f','f','i','c','e'],emphasized:true};
  const b=api.createMotionBuffers([{word,runs:word.letters}],true);
  let reference=api.initialWordSpringState(word),clock={active:false,releasePosition:-1,elapsed:0};
  const emphasis={scale:1,x:0,y:0,glow:0,radius:0};
  for(let i=0;i<2000;i++) {
    if(i===800) {word.text='changed';word.start=2000;word.end=4000;}
    const time=i%200<150?500+(i%200)*16:8000,dt=[0,1/120,1/60,.064][i%4],active=i%200<150;
    const expected=api.advanceReferenceWordMotion(word,reference,time,dt);reference=expected.state;
    clock=api.advanceAmllFloatClock(clock,active,time,dt*1000);
    const expectedEmphasis=api.amllEmphasis(time,word.start,word.end,i%6,6,i%2===0,i%3===0);
    objects=arrays=0;
    api.advanceWordMotionInto(word,b.words[0],b.motions[0],time,dt);
    api.advanceFloatClockInto(b.nextFloatClock,b.floatClock,active,time,dt*1000);
    api.amllEmphasisInto(emphasis,time,word.start,word.end,i%6,6,i%2===0,i%3===0);
    assert.equal(objects,0,'motion helpers allocate zero object literals');assert.equal(arrays,0,'motion helpers allocate zero array literals');
    assert.equal(JSON.stringify(b.words[0]),JSON.stringify(reference),'identity changes and spring resets');
    assert.equal(JSON.stringify(b.motions[0]),JSON.stringify(expected.motion));
    assert.equal(JSON.stringify(emphasis),JSON.stringify(expectedEmphasis));
    assert.equal(JSON.stringify(b.nextFloatClock),JSON.stringify(clock));
    Object.assign(b.floatClock,b.nextFloatClock);
  }
}
// Settings gates, session default, subscription and toggle transitions.
const setting = fs.readFileSync(path.join(directory, '../../../lib/motion-buffers-setting.ts'), 'utf8');
for (const dev of [false, true]) for (const os of ['ios', 'android', 'web']) {
  const listeners = [];
  const module = { exports: {} };
  const code = buildSync({ stdin: { contents: setting, loader: 'ts' }, format: 'cjs', write: false }).outputFiles[0].text;
  vm.runInNewContext(code, { module, exports: module.exports, __DEV__: dev,
    require: name => name === 'react-native' ? { Platform: { OS: os } } : { useSyncExternalStore(sub, get) { sub(() => listeners.push(get())); return get(); } } });
  const api = module.exports;
  assert.equal(api.useMotionBuffers(), false);
  api.setMotionBuffers(true); assert.equal(api.getMotionBuffers(), dev && os !== 'web');
  api.setMotionBuffers(false); assert.equal(api.getMotionBuffers(), false);
  assert.equal(listeners.length, dev && os !== 'web' ? 2 : 0);
}
// Exercise the actual development routing wrapper and shape-key invalidation.
{
  const module = { exports: {} };
  let ref;
  const react = { memo:f=>f, useRef:value=>ref??(ref={current:value}),
    useSyncExternalStore:(_subscribe,get)=>get(), createElement:(type,props)=>({type,props}) };
  const code = bundle(current + "\nexport { setMotionBuffers } from '@/lib/motion-buffers-setting';");
  vm.runInNewContext(code, { module, exports:module.exports, __DEV__:true, performance,
    require:name=>name==='react'?react:name==='react-native'?{Platform:{OS:'ios'}}:{} });
  const api=module.exports, props={words:[],spicy:true};
  const off=api.NativeGlyphPicture(props); assert.match(off.type.name,/^NativeGlyphPictureDevelopment/);
  api.setMotionBuffers(true); const on=api.NativeGlyphPicture(props);
  assert.match(on.type.name,/^NativeGlyphPictureBuffered/);
  const changed=api.NativeGlyphPicture({...props,words:[]}); assert.notEqual(changed.props.key,on.props.key);
  const style=api.NativeGlyphPicture({...props,spicy:false}); assert.notEqual(style.props.key,changed.props.key);
  api.setMotionBuffers(false); assert.equal(api.NativeGlyphPicture(props).type,off.type);
}
console.log('Motion buffers: strict command/spring/clock parity for 11,200 frames, stable nested identities, independent generations, cleanup, Babel worklet hydration, exact OFF bodies and settings gates PASS.');
module.exports = { bundle, original, current, replay };
