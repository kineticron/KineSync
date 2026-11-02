import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
const source = fs.readFileSync(new URL('../components/ui/marquee-text.tsx', import.meta.url), 'utf8');
const start = source.indexOf('    offset.stopAnimation();');
const end = source.indexOf('\n  }, [', start);
const effect = source.slice(start, end);
for (const captureFrozen of [false, true]) {
  let started = 0, value;
  vm.runInNewContext(transformSync(`(() => {${effect}})()`, { loader: 'ts' }).code, {
    captureFrozen, offset: { stopAnimation() {}, setValue(v) { value = v; } },
    reduceMotion: false, focused: true, appActive: true, viewportWidth: 150, overflow: 240,
    Animated: { loop: () => ({ start() { started++; }, stop() {} }), sequence: x => x, delay() {}, timing() {} }, Easing: { linear: x => x },
  });
  assert.equal(value, 0);
  assert.equal(started, captureFrozen ? 0 : 1, 'Snapshot must stop independent wall-clock marquee even while playback is paused');
}
console.log('Actual marquee effect: live animation preserved; snapshot offset frozen at zero.');
