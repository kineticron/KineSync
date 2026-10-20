import { Skia, type SkData, type SkImage } from '@shopify/react-native-skia';
import { createWorkletRuntime, runOnRuntimeAsync, type WorkletRuntime } from 'react-native-worklets';
import { blendKawarpTextures, makeKawarpEffects, makeKawarpFrame, makeKawarpTexture } from './kawarp-texture';

export type PreparedArtwork = {
  texture: SkImage; frame: SkImage; previousFrame: SkImage | null;
  effects: NonNullable<ReturnType<typeof makeKawarpEffects>>;
};
let runtime: WorkletRuntime | undefined;

function prepare(data: SkData, old: PreparedArtwork | null, progress: number, time: number,
  width: number, height: number, density: number): PreparedArtwork {
  'worklet';
  const effects = old?.effects ?? makeKawarpEffects();
  if (!effects) throw new Error('Cannot compile artwork background');
  const image = Skia.Image.MakeImageFromEncoded(data);
  if (!image) throw new Error('Cannot decode artwork background');
  let texture: SkImage;
  try { texture = makeKawarpTexture(image, effects); }
  finally { image.dispose(); }
  let frame: SkImage | null = null;
  try {
    frame = makeKawarpFrame(texture, effects.warp, time, width, height, density);
    const previousFrame = old ? progress < 1
      ? blendKawarpTextures(old.previousFrame, old.frame, progress)
      : makeKawarpFrame(old.texture, effects.warp, time, width, height, density) : null;
    return { texture, frame, previousFrame, effects };
  } catch (error) { frame?.dispose(); texture.dispose(); throw error; }
}

/** Decode, blur and rasterize on a worker; neither the RN nor UI runtime draws these surfaces. */
export function prepareKawarpArtwork(data: SkData, old: PreparedArtwork | null, progress: number,
  time: number, width: number, height: number, density: number) {
  runtime ??= createWorkletRuntime({ name: 'Artwork preparation', enableEventLoop: false });
  return runOnRuntimeAsync(runtime, prepare, data, old, progress, time, width, height, density);
}
