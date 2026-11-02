import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import CrcCalculator from 'pngjs/lib/crc.js';
import { nativePNGMetadata } from './simulator-png-metadata.mjs';
import { reviewPNG } from './simulator-review-png.mjs';
const raw = fs.readFileSync(new URL('./fixtures/native-window-exif8.png', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(raw), 'b36ff56fe38f4d7f3b67169506882ee70edd2906256054a81fb0c0654852b3ac');
const snapshot = Buffer.from(raw);
const result = reviewPNG(raw, 'landscape');
assert.deepEqual(raw, snapshot);
assert.equal(result.conversion.exifOrientation, 8);
assert.equal(result.conversion.outputWidth, 2622);
assert.equal(result.conversion.outputHeight, 1206);
const input = PNG.sync.read(raw), output = PNG.sync.read(result.bytes);
assert.deepEqual(output.data.subarray(0, 4), input.data.subarray((input.width - 1) * 4, input.width * 4));
assert.deepEqual(reviewPNG(result.bytes, 'landscape').bytes, result.bytes, 'No double orientation');
console.log('Actual native EXIF8 fixture review conversion and original preservation passed (not a native scenario PASS).');

function withExif(bytes, orientation) {
  const tiff = Buffer.alloc(26); tiff.write('MM'); tiff.writeUInt16BE(42, 2); tiff.writeUInt32BE(8, 4); tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x112, 10); tiff.writeUInt16BE(3, 12); tiff.writeUInt32BE(1, 14); tiff.writeUInt16BE(orientation, 18);
  const chunk = Buffer.alloc(38); chunk.writeUInt32BE(26); chunk.write('eXIf', 4); tiff.copy(chunk, 8);
  chunk.writeInt32BE(CrcCalculator.crc32(chunk.subarray(4, -4)), 34);
  return Buffer.concat([bytes.subarray(0, 33), chunk, bytes.subarray(33)]);
}
const asymmetric = new PNG({ width: 2, height: 3 });
for (let i = 0; i < 6; i++) { asymmetric.data[i * 4] = i + 1; asymmetric.data[i * 4 + 3] = 255; }
const plain = PNG.sync.write(asymmetric);
const expected = [[1,2,3,4,5,6], [2,1,4,3,6,5], [6,5,4,3,2,1], [5,6,3,4,1,2], [1,3,5,2,4,6], [5,3,1,6,4,2], [6,4,2,5,3,1], [2,4,6,1,3,5]];
for (let tag = 1; tag <= 8; tag++) {
  const original = withExif(plain, tag), saved = Buffer.from(original);
  const orientation = tag >= 5 ? 'landscape' : 'portrait';
  const converted = reviewPNG(original, orientation);
  const pixels = PNG.sync.read(converted.bytes);
  assert.deepEqual(Array.from({ length: 6 }, (_, i) => pixels.data[i * 4]), expected[tag - 1]);
  assert.deepEqual(original, saved);
  assert.equal(converted.conversion.sourceSHA256, hash(original));
  assert.equal(converted.conversion.outputSHA256, hash(converted.bytes));
  assert.deepEqual(reviewPNG(converted.bytes, orientation).bytes, converted.bytes);
  if (tag !== 1) assert.equal(nativePNGMetadata(converted.bytes).exifOrientation, null);
}
assert.throws(() => reviewPNG(plain, 'landscape'), /no inferred rotation/);
assert.throws(() => reviewPNG(withExif(plain, 1), 'landscape'), /dimensions invalid/);
assert.throws(() => reviewPNG(withExif(plain, 9), 'landscape'), /EXIF/);
assert.throws(() => reviewPNG(withExif(withExif(plain, 8), 8), 'landscape'), /EXIF/);
assert.throws(() => reviewPNG(Buffer.from('invalid'), 'landscape'));
console.log('All eight EXIF orientations, no double transform, missing/unsupported/duplicate metadata regressions passed.');

assert.throws(() => reviewPNG(raw, 'portrait'), /dimensions invalid/, 'Landscape EXIF cannot satisfy portrait restoration proof');
