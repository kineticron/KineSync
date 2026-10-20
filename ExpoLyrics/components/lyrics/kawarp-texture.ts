import {
  FilterMode, MipmapMode, Skia, TileMode,
  type SkImage, type SkRuntimeEffect, type SkShader,
} from '@shopify/react-native-skia';
import {
  KAWARP_BLUR_PASSES, KAWARP_BLUR_SHADER, KAWARP_TEXTURE_SIZE,
  KAWARP_TINT_SHADER, KAWARP_WARP_SHADER,
} from './kawarp-shaders';

export function makeKawarpEffects() {
  'worklet';
  try {
    const tint = Skia.RuntimeEffect.Make(KAWARP_TINT_SHADER);
    const blur = Skia.RuntimeEffect.Make(KAWARP_BLUR_SHADER);
    const warp = Skia.RuntimeEffect.Make(KAWARP_WARP_SHADER);
    return tint && blur && warp ? { tint, blur, warp } : null;
  } catch {
    return null;
  }
}

function imageShader(image: SkImage) {
  'worklet';
  return image.makeShaderOptions(TileMode.Clamp, TileMode.Clamp, FilterMode.Linear, MipmapMode.None);
}

function renderTexture(shader: SkShader, width?: number, height?: number, density = 1) {
  'worklet';
  width ??= KAWARP_TEXTURE_SIZE;
  height ??= KAWARP_TEXTURE_SIZE;
  // A tiny raster surface is safe to hand from JS to the UI renderer on both platforms.
  try {
    const surface = Skia.Surface.Make(Math.ceil(width * density), Math.ceil(height * density));
    if (!surface) throw new Error('Cannot allocate artwork background texture');
    const paint = Skia.Paint();
    try {
      paint.setShader(shader);
      const canvas = surface.getCanvas();
      canvas.scale(density, density);
      canvas.drawRect(Skia.XYWHRect(0, 0, width, height), paint);
      return surface.makeImageSnapshot();
    } finally {
      paint.dispose();
      surface.dispose();
    }
  } finally {
    shader.dispose();
  }
}

/** Tint and eight Kawase passes run once per artwork, never on animation frames. */
export function makeKawarpTexture(image: SkImage, effects: { tint: SkRuntimeEffect; blur: SkRuntimeEffect }) {
  'worklet';
  const source = image.makeShaderOptions(TileMode.Clamp, TileMode.Clamp, FilterMode.Linear, MipmapMode.None,
    Skia.Matrix().scale(KAWARP_TEXTURE_SIZE / image.width(), KAWARP_TEXTURE_SIZE / image.height()));
  let texture: SkImage;
  try {
    texture = renderTexture(effects.tint.makeShaderWithChildren([], [source]));
  } finally {
    source.dispose();
  }
  for (let pass = 0; pass < KAWARP_BLUR_PASSES; pass++) {
    const input = imageShader(texture);
    let next: SkImage;
    try {
      next = renderTexture(effects.blur.makeShaderWithChildren([pass + 0.5], [input]));
    } finally {
      input.dispose();
      texture.dispose();
    }
    texture = next;
  }
  return texture;
}

/** Preserve the on-screen color mix if another track arrives during a crossfade. */
export function blendKawarpTextures(previous: SkImage | null, current: SkImage, blend: number): SkImage | null {
  'worklet';
  if (blend >= 1) return current;
  if (blend <= 0) return previous;
  const base = previous ?? current;
  const surface = Skia.Surface.Make(base.width(), base.height());
  if (!surface) return current;
  const paint = Skia.Paint();
  try {
    const canvas = surface.getCanvas();
    if (previous) canvas.drawImage(previous, 0, 0);
    paint.setAlphaf(blend);
    canvas.drawImageRect(current, Skia.XYWHRect(0, 0, current.width(), current.height()),
      Skia.XYWHRect(0, 0, base.width(), base.height()), paint);
    return surface.makeImageSnapshot();
  } finally {
    paint.dispose();
    surface.dispose();
  }
}

/** Fully rasterize the warp before publishing a frame to the visible canvas. */
export function makeKawarpFrame(image: SkImage, effect: SkRuntimeEffect, time: number, width: number, height: number, density: number) {
  'worklet';
  const source = imageShader(image);
  try {
    return renderTexture(effect.makeShaderWithChildren([width, height, time, 1], [source, source]), width, height, density);
  } finally { source.dispose(); }
}
