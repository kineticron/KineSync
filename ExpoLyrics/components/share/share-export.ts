/**
 * Turning a prepared card into files: a PNG, or an MP4 made frame by frame.
 */
import { AlphaType, ColorType, ImageFormat, Skia } from '@shopify/react-native-skia';
import { File, Paths } from 'expo-file-system';
import { drawCard, renderCardImage, type PreparedCard } from '@/components/share/share-card';
import { frameCount, VIDEO_FPS, videoWindow, type ShareLine } from '@/lib/share/share-timeline';
import { addVideoFrame, cancelVideo, finishVideo, startVideo, videoFrameOrder } from '@/lib/share/video-encoder';

const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

export function savePicture(card: PreparedCard) {
  const image = renderCardImage(card, null);
  if (!image) throw new Error('Could not draw the picture.');
  const file = new File(Paths.cache, `kinesync-lyrics-${stamp()}.png`);
  file.create({ overwrite: true });
  file.write(image.encodeToBytes(ImageFormat.PNG, 100));
  return file.uri;
}

const pathOf = (uri: string) => decodeURIComponent(uri.replace(/^file:\/\//, ''));

/**
 * Draw every frame at its exact song time and hand it to the encoder.
 * `onProgress` gets 0..1; `cancelled` is checked between frames.
 */
export async function makeVideo(card: PreparedCard, lines: ShareLine[], onProgress: (fraction: number) => void, cancelled: () => boolean) {
  const { start, durationMs } = videoWindow(lines);
  const frames = frameCount(durationMs);
  const file = new File(Paths.cache, `kinesync-lyrics-${stamp()}.mp4`);
  const surface = Skia.Surface.Make(card.width, card.height);
  if (!surface) throw new Error('Could not draw the video.');
  const canvas = surface.getCanvas();
  // Each encoder takes its own byte order (RGBA on Android, BGRA on iOS); Skia reads either.
  const colorType = videoFrameOrder === 'bgra' ? ColorType.BGRA_8888 : ColorType.RGBA_8888;
  const info = { width: card.width, height: card.height, colorType, alphaType: AlphaType.Unpremul };
  startVideo(pathOf(file.uri), card.width, card.height, VIDEO_FPS, 6_000_000);
  try {
    for (let frame = 0; frame < frames; frame++) {
      if (cancelled()) { cancelVideo(); return null; }
      drawCard(canvas, card, start + (frame * 1000) / VIDEO_FPS);
      surface.flush();
      const pixels = canvas.readPixels(0, 0, info) ?? surface.makeImageSnapshot().readPixels(0, 0, info);
      if (!(pixels instanceof Uint8Array)) throw new Error('Could not read a video frame.');
      addVideoFrame(pixels);
      // Let the progress bar and the Cancel button update.
      if (frame % 4 === 0) { onProgress(frame / frames); await new Promise((resolve) => setTimeout(resolve, 0)); }
    }
    finishVideo();
    onProgress(1);
    return file.uri;
  } catch (error) {
    cancelVideo();
    throw error;
  }
}
