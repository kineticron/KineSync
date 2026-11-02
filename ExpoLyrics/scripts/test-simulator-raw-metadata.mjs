// Encoded geometry must remain authoritative even when EXIF displays landscape.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { NativeCapture } from './simulator-native-capture.mjs';
import { nativePNGMetadata } from './simulator-png-metadata.mjs';
import { Buffer } from 'node:buffer';
import CrcCalculator from 'pngjs/lib/crc.js';

function withExif(png, orientation, little = false) {
  const tiff = Buffer.alloc(26);
  tiff.write(little ? 'II' : 'MM');
  const u16 = (v, at) => little ? tiff.writeUInt16LE(v, at) : tiff.writeUInt16BE(v, at);
  const u32 = (v, at) => little ? tiff.writeUInt32LE(v, at) : tiff.writeUInt32BE(v, at);
  u16(42, 2); u32(8, 4); u16(1, 8); u16(0x112, 10); u16(3, 12); u32(1, 14); u16(orientation, 18);
  const chunk = Buffer.alloc(12 + tiff.length);
  chunk.writeUInt32BE(tiff.length); chunk.write('eXIf', 4); tiff.copy(chunk, 8);
  chunk.writeInt32BE(CrcCalculator.crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
}
const portrait = PNG.sync.write(new PNG({ width: 3, height: 5 }));
for (const little of [false, true]) for (const orientation of [1, 3, 6, 8]) {
  const bytes = withExif(portrait, orientation, little);
  assert.deepEqual(nativePNGMetadata(bytes), { encodedWidth: 3, encodedHeight: 5, exifOrientation: orientation });
}
assert.deepEqual(nativePNGMetadata(portrait), { encodedWidth: 3, encodedHeight: 5, exifOrientation: null });
assert.throws(() => nativePNGMetadata(Buffer.from('bad')), /PNG/);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-exif-'));
const session = '12345678-1234-1234-1234-123456789abc';
const raw = withExif(portrait, 8);
try {
  const capture = new NativeCapture({ mailbox: root, session, udid: 'device', command: async (_cmd, args) => { fs.writeFileSync(args.at(-1), raw); },
    state: { outputDir: root, now: Date.now, check() {} },
    pause: async () => {
      const request = JSON.parse(fs.readFileSync(path.join(root, 'request.json')));
      fs.writeFileSync(path.join(root, `${request.id}.png`), raw);
      fs.writeFileSync(path.join(root, `${request.id}.json`), JSON.stringify({ ...request, observedUDID: 'device', bundle: 'dev.kineticron.KineSync', foreground: 'true', deviceOrientation: request.orientation, windowWidth: '5', windowHeight: '3' }));
    } });
  const destination = path.join(root, 'result.png');
  await assert.rejects(capture.capture(destination, { run: 'run', stage: 'stage_7_rotation', token: 'run_stage_7_rotation', orientation: 'landscape' }), /dimensions invalid.*EXIF orientation=8/);
  assert.deepEqual(fs.readFileSync(destination), raw, 'EXIF must never trigger pixel rotation or PNG reencoding');
  const record = JSON.parse(fs.readFileSync(path.join(root, 'native-captures.jsonl'), 'utf8').trim());
  assert.equal(record.exifOrientation, 8);
  assert.equal(record.width, 3); assert.equal(record.height, 5);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log('EXIF orientation is diagnostic only; encoded landscape gate rejects portrait bytes unchanged.');
