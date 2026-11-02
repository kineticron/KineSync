// Observe raw XCTest PNG metadata. Never transpose geometry or transform pixels.
import { Buffer } from 'node:buffer';
export function nativePNGMetadata(bytes) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') throw Error('Invalid native PNG header');
  const result = { encodedWidth: bytes.readUInt32BE(16), encodedHeight: bytes.readUInt32BE(20), exifOrientation: null };
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) throw Error('Truncated native PNG chunk');
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'eXIf') {
      const tiff = bytes.subarray(offset + 8, offset + 8 + length);
      const little = tiff.toString('ascii', 0, 2) === 'II';
      if (!little && tiff.toString('ascii', 0, 2) !== 'MM') throw Error('Invalid native PNG EXIF byte order');
      if (tiff.length < 8) throw Error('Truncated native PNG EXIF header');
      const u16 = at => little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at);
      const u32 = at => little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at);
      if (u16(2) !== 42) throw Error('Invalid native PNG EXIF magic');
      const ifd = u32(4);
      if (ifd > tiff.length - 2) throw Error('Invalid native PNG EXIF directory');
      const count = u16(ifd);
      if (count > Math.floor((tiff.length - ifd - 2) / 12)) throw Error('Truncated native PNG EXIF directory');
      for (let index = 0; index < count; index++) {
        const entry = ifd + 2 + index * 12;
        if (u16(entry) !== 0x112) continue;
        if (u16(entry + 2) !== 3 || u32(entry + 4) !== 1) throw Error('Invalid native PNG EXIF orientation field');
        const orientation = u16(entry + 8);
        if (orientation < 1 || orientation > 8 || result.exifOrientation !== null) throw Error('Invalid native PNG EXIF orientation');
        result.exifOrientation = orientation;
      }
    }
    offset += length + 12;
  }
  return result;
}
