// Structural evidence for the requested zero-native-recording constraint.
// This is installed-source inspection, not a device timing or a variant B implementation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.dirname(require.resolve('@shopify/react-native-skia/package.json'));
const files = ['src/sksg/Container.native.ts', 'cpp/api/recorder/JsiRecorder.h', 'cpp/api/recorder/Paint.h'];
const contents = files.map(f => fs.readFileSync(path.join(root, f), 'utf8'));
assert.match(contents[0], /Rea\.startMapper\([\s\S]*?sharedRecorder\.applyUpdates\(sharedValues\);\s*nativeDrawOnscreen/);
assert.match(contents[0], /recorder\.play\(picture\)/);
assert.match(contents[1], /pictureRecorder\.beginRecording\([\s\S]*?getObject\(\)->play\([\s\S]*?pictureRecorder\.finishRecordingAsPicture\(/);
assert.match(contents[2], /clipPath\(path, op\)/);
const result = { skia:require('@shopify/react-native-skia/package.json').version,
  scope:'Installed source only; no native runtime/device measurement',
  animatedGroupUpdates:'Canvas mapper applies changes then replays native recorder, including new native SkPicture recording',
  zeroAppPictureFactoriesDoesNotMeanZeroNativeRecording:true,
  nativeGroupClip:'clipPath(path, op) omits original imperative antiAlias=true argument',
  sources:files.map((file,i)=>({file,sha256:createHash('sha256').update(contents[i]).digest('hex')})) };
console.log(JSON.stringify(result,null,2));
