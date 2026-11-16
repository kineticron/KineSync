// Run the unchanged Skia timing modules to generate scalar reference receipts.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../../..');
const ts = require(path.join(root, 'ExpoLyrics/node_modules/typescript'));
const dir = 'ExpoLyrics/components/lyrics/native/';
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const file = path.join(root, dir, name + '.ts');
  const module = { exports: {} };
  const localRequire = createRequire(file);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  new Function('require', 'module', 'exports', code)(id => id === './reference-motion' ? load('reference-motion') : localRequire(id), module, module.exports);
  cache.set(name, module.exports);
  return module.exports;
}
const m = load('native-interlude-motion');
const r = load('reference-motion');
const start = 2000, end = 6000;
const windows = m.spicyDotTiming(start, end);
let dots = windows.map(() => m.initialDotSpringState());
let previous = null;
const frames = [2000, 2150, 2600, 5499, 5500, 5540, 5600, 5750, 5900].map(time => {
  const dt = previous === null ? 0 : Math.min(.064, (time - previous) / 1000);
  dots = dots.map((state, i) => m.advanceSpicyDot(state, time, ...windows[i], dt));
  previous = time;
  const shownExit = end - 500;
  const groupScale = time < start + 300 ? r.cubicBezier((time - start) / 300, .25, .1, .25, 1) : time < shownExit ? 1 : 1 - m.spicyDotExitEasing(Math.min(1, (time - shownExit) / 400));
  const quad = p => p < .5 ? 2*p*p : 1 - (-2*p+2)**2/2;
  const groupOpacity = time < start + 140 ? quad((time-start)/140) : time < shownExit ? 1 : 1 - quad(Math.min(1, (time-shownExit)/140));
  return { time, dt, amll: m.amllInterludeSnapshot(time, start, end - 250),
    rowOpacity: time < shownExit ? 1 : 1 - .15*r.cubicBezier(Math.min(1,(time-shownExit)/400),.25,.1,.25,1),
    spicy: { groupScale, groupOpacity, dots: dots.map(d => [d.scale.p, d.y.p, d.glow.p, d.opacity.p]) } };
});
const sources = ['native-interlude-motion.ts','reference-motion.ts','native-interlude.tsx','native-lyric-row.tsx'].map(name => ({ path:dir+name, sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,dir,name))).digest('hex') }));
fs.writeFileSync(path.join(root,'native/lyrics-renderer/test/interlude-reference.json'), JSON.stringify({ sources, start, end, frames }, null, 2)+'\n');
