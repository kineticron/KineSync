import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import { decode as decodeJpeg } from "jpeg-js";
import { normalizeBridgeArtworkUri } from "./artwork";

const DEFAULT_ACCENT = "#8B5CF6";
const SAMPLE_SIZE = 56;

export type AccentPalette = {
  accent: string;
  background: string;
  title: string;
  subtitle: string;
  source: string;
};

const paletteCache = new Map<string, AccentPalette>();

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function rgbToHex(red: number, green: number, blue: number) {
  const toHex = (channel: number) =>
    clamp(Math.round(channel), 0, 255).toString(16).padStart(2, "0");
  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

function mixHex(base: string, target: string, amount: number) {
  const parse = (hex: string) => {
    const normalized = hex.replace("#", "");
    return {
      r: Number.parseInt(normalized.slice(0, 2), 16),
      g: Number.parseInt(normalized.slice(2, 4), 16),
      b: Number.parseInt(normalized.slice(4, 6), 16),
    };
  };

  const from = parse(base);
  const to = parse(target);
  const ratio = clamp(amount, 0, 1);

  return rgbToHex(
    from.r + (to.r - from.r) * ratio,
    from.g + (to.g - from.g) * ratio,
    from.b + (to.b - from.b) * ratio,
  );
}

function base64ToBytes(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function hueFromRgb(red: number, green: number, blue: number) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  if (delta < 0.00001) {
    return 0;
  }

  let hue = 0;
  if (max === r) {
    hue = ((g - b) / delta) % 6;
  } else if (max === g) {
    hue = (b - r) / delta + 2;
  } else {
    hue = (r - g) / delta + 4;
  }

  return Math.round(((hue * 60) + 360) % 360);
}

function pickVibrantAccentFromRgba(data: Uint8Array) {
  const buckets = new Map<
    number,
    { red: number; green: number; blue: number; weight: number }
  >();

  let totalRed = 0;
  let totalGreen = 0;
  let totalBlue = 0;
  let totalWeight = 0;

  for (let index = 0; index < data.length; index += 4) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const alpha = data[index + 3];
    if (alpha < 48) {
      continue;
    }

    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const lightness = (max + min) / 510;
    const saturation = max === 0 ? 0 : (max - min) / max;

    const weight = saturation * saturation * (1 - Math.abs(lightness - 0.46));
    totalRed += red * weight;
    totalGreen += green * weight;
    totalBlue += blue * weight;
    totalWeight += weight;

    if (lightness < 0.1 || lightness > 0.94 || saturation < 0.14) {
      continue;
    }

    const bucket = Math.floor(hueFromRgb(red, green, blue) / 15) * 15;
    const current = buckets.get(bucket);
    if (!current || weight > current.weight) {
      buckets.set(bucket, { red, green, blue, weight });
    }
  }

  let best: { red: number; green: number; blue: number; weight: number } | null =
    null;
  for (const candidate of buckets.values()) {
    if (!best || candidate.weight > best.weight) {
      best = candidate;
    }
  }

  if (best) {
    return rgbToHex(best.red, best.green, best.blue);
  }

  if (totalWeight > 0) {
    return rgbToHex(
      totalRed / totalWeight,
      totalGreen / totalWeight,
      totalBlue / totalWeight,
    );
  }

  return DEFAULT_ACCENT;
}

async function extractAccentFromArtworkUri(artworkUrl: string) {
  const normalized = normalizeBridgeArtworkUri(artworkUrl);
  if (!normalized) {
    return DEFAULT_ACCENT;
  }

  const manipulated = await manipulateAsync(
    normalized,
    [{ resize: { width: SAMPLE_SIZE, height: SAMPLE_SIZE } }],
    {
      compress: 0.82,
      format: SaveFormat.JPEG,
      base64: true,
    },
  );

  if (!manipulated.base64) {
    return DEFAULT_ACCENT;
  }

  const decoded = decodeJpeg(base64ToBytes(manipulated.base64), {
    useTArray: true,
  });
  return pickVibrantAccentFromRgba(decoded.data);
}

export function buildAccentPalette(accent: string): AccentPalette {
  const safeAccent = accent.startsWith("#") ? accent : DEFAULT_ACCENT;

  return {
    accent: safeAccent,
    background: mixHex(safeAccent, "#000000", 0.72),
    title: "#F9FAFC",
    subtitle: mixHex(safeAccent, "#FFFFFF", 0.55),
    source: mixHex(safeAccent, "#FFFFFF", 0.38),
  };
}

export function getCachedArtworkAccent(artworkUrl?: string) {
  const normalized = normalizeBridgeArtworkUri(artworkUrl);
  if (!normalized) {
    return DEFAULT_ACCENT;
  }
  return paletteCache.get(normalized)?.accent ?? DEFAULT_ACCENT;
}

export async function prefetchArtworkAccent(artworkUrl?: string) {
  const palette = await resolveArtworkAccentPalette(artworkUrl);
  return palette.accent;
}

export async function resolveArtworkAccentPalette(
  artworkUrl?: string,
): Promise<AccentPalette> {
  const normalized = normalizeBridgeArtworkUri(artworkUrl);
  if (!normalized) {
    return buildAccentPalette(DEFAULT_ACCENT);
  }

  const cached = paletteCache.get(normalized);
  if (cached) {
    return cached;
  }

  try {
    const accent = await extractAccentFromArtworkUri(normalized);
    const palette = buildAccentPalette(accent);
    paletteCache.set(normalized, palette);
    return palette;
  } catch {
    const fallback = buildAccentPalette(DEFAULT_ACCENT);
    paletteCache.set(normalized, fallback);
    return fallback;
  }
}
