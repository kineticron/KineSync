// Review-only TIFF/EXIF orientation normalization. Native input bytes remain immutable.
import { PNG } from 'pngjs';
import { createHash } from 'node:crypto';
import { nativePNGMetadata } from './simulator-png-metadata.mjs';
export function reviewPNG(original, orientation) {
  const image = PNG.sync.read(original); // Validates chunk CRCs before using metadata.
  const metadata = nativePNGMetadata(original);
  const tag = metadata.exifOrientation;
  if (!['portrait', 'landscape'].includes(orientation)) throw Error('Invalid review orientation');
  let bytes = original;
  if (tag !== null && tag !== 1) {
    const swapped = tag >= 5;
    const output = new PNG({ width: swapped ? image.height : image.width, height: swapped ? image.width : image.height });
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      const w = image.width - 1, h = image.height - 1;
      const [dx, dy] = {
        2: [w - x, y], 3: [w - x, h - y], 4: [x, h - y],
        5: [y, x], 6: [h - y, x], 7: [h - y, w - x], 8: [y, w - x],
      }[tag];
      image.data.copy(output.data, (dy * output.width + dx) * 4, (y * image.width + x) * 4, (y * image.width + x + 1) * 4);
    }
    bytes = PNG.sync.write(output); // EXIF removed; output pixels are already oriented.
  }
  const output = nativePNGMetadata(bytes);
  if (orientation === 'landscape' ? output.encodedWidth <= output.encodedHeight : output.encodedHeight <= output.encodedWidth) throw Error(`Review ${orientation} dimensions invalid; EXIF orientation=${tag ?? 'absent'} (no inferred rotation)`);
  const hash = data => createHash('sha256').update(data).digest('hex');
  return { bytes, conversion: { algorithm: 'tiff-orientation-v1/pngjs', exifOrientation: tag, operation: tag === null || tag === 1 ? 'identity' : `exif-${tag}`, sourceSHA256: hash(original), sourceWidth: image.width, sourceHeight: image.height, outputSHA256: hash(bytes), outputWidth: output.encodedWidth, outputHeight: output.encodedHeight, outputExifOrientation: output.exifOrientation } };
}
