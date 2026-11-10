import type { SkRect } from '@shopify/react-native-skia';

// Worklet dependencies must be initialized before callers capture them.
export function blurLayerOutset(sigma: number) {
  'worklet';
  // Skia's finite Gaussian support is <= 3 sigma. Keep 4 sigma plus
  // two local pixels for antialiasing and device-space rounding.
  return Math.ceil(4 * Math.max(0.01, sigma)) + 2;
}

export function blurLayerBounds(clip: SkRect, sigma: number) {
  'worklet';
  const pad = blurLayerOutset(sigma);
  // Local coordinates: saveLayer applies the current word AND letter matrix.
  // Use the actual shaped clip, including fallback ink and overhangs. No clip
  // is added, and spring overshoot never needs an assumed maximum transform.
  return { x: clip.x - pad, y: clip.y - pad,
    width: clip.width + 2 * pad, height: clip.height + 2 * pad };
}
