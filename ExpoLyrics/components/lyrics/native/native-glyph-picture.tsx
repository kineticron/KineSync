import { blurLayerBounds } from './blur-layer-bounds';
import { useArrivalPictureMeasurement } from '@/lib/lyrics-arrival-picture';
import { arrivalPicture, type ArrivalHandle, type ArrivalUiTotals } from '@/lib/lyrics-arrival-trace';
import React, { memo, useCallback, useEffect, useMemo } from 'react';
import { BlendMode, ClipOp, createPicture, Picture, Skia, TileMode, type SkCanvas, type SkFont, type SkImageFilter, type SkParagraph, type SkPaint, type SkPoint, type SkRect, type SkShader, type SkPath, type SkPicture } from '@shopify/react-native-skia';
import { useFrameCallback, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { reportNativePicture } from '@/lib/native-clock-diagnostics';
import { needsEmojiMask } from './native-glyph-mask';
import { amllRevealStart, glyphRowExtent, selectGlyphSlice } from './native-glyph-layout';
import type { NativePaintWord } from './native-lyrics-model';
import { advanceReferenceWordMotion, initialWordSpringState, type WordMotion } from './reference-word-motion';
import { amllEmphasis, amllFloat, clamp01 } from './reference-motion';
import type { ReferenceLineMotion } from './use-reference-line-motion';
import { spicyIsRtl } from './spicy-text-policy';
import { advanceAmllFloatClock, amllWordFloatPosition, type AmllFloatClock } from './amll-float-clock';

type GlyphRun = { glyphs: number[]; positions: SkPoint[]; font: SkFont };
export type PictureWord = { word: NativePaintWord; rects: SkRect[]; letters: SkRect[][]; width: number; before: number };
type ShapedGlyphWord = PictureWord & { runs: GlyphRun[][]; clips: SkPath[]; pictures: SkPicture[]; emojiMask: boolean[]; overlapMask: boolean[]; revealRects: SkRect[]; unionGroup?: number; unionInk?: SkRect };
type RevealShader = { x: number; y: number; endX: number; bright: number; dark: number; shader: SkShader };
type ReusableGlyphPaints = { unionPaints?: { encode: SkPaint; decode: SkPaint }; arrivalCounts?: ArrivalUiTotals; revealShaders: RevealShader[]; paint: SkPaint; glowPaint: SkPaint; blurRadii: number[]; blurFilters: SkImageFilter[] };

// Glow sigma is animation-derived and continuous. Reuse only bit-exact radii,
// with a small per-voice LRU so a long song cannot retain an unbounded filter set.
const MAX_GLOW_FILTER_CACHE_ENTRIES = 32;

function getGlowFilter(paints: ReusableGlyphPaints, radius: number) {
  'worklet';
  const existing = paints.blurRadii.indexOf(radius);
  if (existing >= 0) {
    const filter = paints.blurFilters[existing];
    if (existing !== paints.blurRadii.length - 1) {
      paints.blurRadii.splice(existing, 1);
      paints.blurFilters.splice(existing, 1);
      paints.blurRadii.push(radius);
      paints.blurFilters.push(filter);
    }
    return filter;
  }
  const filter = Skia.ImageFilter.MakeBlur(radius, radius, TileMode.Decal);
  if (paints.blurRadii.length === MAX_GLOW_FILTER_CACHE_ENTRIES) {
    paints.blurRadii.shift();
    paints.blurFilters.shift();
  }
  paints.blurRadii.push(radius);
  paints.blurFilters.push(filter);
  return filter;
}

// White RGB, shared endpoint Y, null positions, Clamp tiling and default
// matrix/flags are fixed here. Compare every varying input exactly; never quantize animation values.
const MAX_REVEAL_SHADER_CACHE_ENTRIES = 32;
function getRevealShader(paints: ReusableGlyphPaints, x: number, y: number, endX: number, bright: number, dark: number) {
  'worklet';
  const entries = paints.revealShaders;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (Object.is(entry.x, x) && Object.is(entry.y, y) && Object.is(entry.endX, endX) &&
        Object.is(entry.bright, bright) && Object.is(entry.dark, dark)) {
      // Move to MRU without allocating a key, array or cache entry on a hit.
      for (let j = i; j < entries.length - 1; j++) entries[j] = entries[j + 1];
      entries[entries.length - 1] = entry;
      return entry.shader;
    }
  }
  const shader = Skia.Shader.MakeLinearGradient({ x, y }, { x: endX, y },
    [Skia.Color(`rgba(255,255,255,${bright})`), Skia.Color(`rgba(255,255,255,${dark})`)], null, TileMode.Clamp);
  // SkShaders are immutable; recorded paints retain native references. Do not
  // explicitly dispose evicted handles while pictures may still reference them.
  if (entries.length === MAX_REVEAL_SHADER_CACHE_ENTRIES) entries.shift();
  entries.push({ x, y, endX, bright, dark, shader });
  return shader;
}

function measuredGlowFilter(paints: ReusableGlyphPaints, radius: number) {
  'worklet';
  if (!paints.arrivalCounts) return getGlowFilter(paints, radius);
  const hit = paints.blurRadii.includes(radius);
  const result = getGlowFilter(paints, radius);
  if (!hit && paints.arrivalCounts) paints.arrivalCounts.blurFilterConstructors++;
  return result;
}
function measuredRevealShader(paints: ReusableGlyphPaints, x: number, y: number, endX: number, bright: number, dark: number) {
  'worklet';
  if (!paints.arrivalCounts) return getRevealShader(paints, x, y, endX, bright, dark);
  const hit = paints.revealShaders.some(entry => Object.is(entry.x, x) && Object.is(entry.y, y) && Object.is(entry.endX, endX) &&
    Object.is(entry.bright, bright) && Object.is(entry.dark, dark));
  const result = getRevealShader(paints, x, y, endX, bright, dark);
  if (!hit && paints.arrivalCounts) paints.arrivalCounts.shaderConstructors++;
  return result;
}
const glowFilterForDraw = typeof __DEV__ !== 'undefined' && __DEV__ ? measuredGlowFilter : getGlowFilter;
const revealShaderForDraw = typeof __DEV__ !== 'undefined' && __DEV__ ? measuredRevealShader : getRevealShader;

/** Read the paragraph's actual shaped glyphs, including fallback fonts and RTL placement. */
export function shapeGlyphWords(paragraph: SkParagraph, words: PictureWord[], spicy = true): ShapedGlyphWord[] {
  const lines = paragraph.getLineMetrics();
  const allRects = words.flatMap(word => word.rects);
  const shaped: ShapedGlyphWord[] = words.map(word => {
    const parts = word.word.emphasized ? word.letters : [word.rects];
    const emojiMask = word.word.emphasized ? word.word.letters.map(needsEmojiMask) : [word.word.letters.some(needsEmojiMask)];
    const revealRects = parts.map(rects => {
      const rect = rects[0];
      if (!rect) return Skia.XYWHRect(0, 0, 0, 0);
      const extent = glyphRowExtent(rect, rects, lines);
      return Skia.XYWHRect(extent.x, rect.y, extent.width, rect.height);
    });
    return { ...word, emojiMask, overlapMask: parts.map(() => false), revealRects, pictures: [] as SkPicture[], runs: parts.map(() => [] as GlyphRun[]), clips: parts.map(rects => {
      const path = Skia.PathBuilder.Make();
      rects.forEach(rect => {
        const onLine = allRects.filter(r => Math.min(r.y + r.height, rect.y + rect.height) - Math.max(r.y, rect.y) > Math.min(r.height, rect.height) / 2);
        const left = Math.min(...onLine.map(r => r.x));
        const right = Math.max(...onLine.map(r => r.x + r.width));
        const padLeft = rect.x <= left + 0.1 ? 8 : 0;
        const padRight = rect.x + rect.width >= right - 0.1 ? 8 : 0;
        path.addRect(Skia.XYWHRect(rect.x - padLeft, rect.y - 8, rect.width + padLeft + padRight, rect.height + 16));
      });
      return path.detach();
    }) };
  });
  const sliceInk = shaped.map(word => word.runs.map(() => [] as SkRect[]));
  paragraph.extendedVisit((_line, run) => {
    if (!run) return;
    const selectionRun = { ...run, advances: run.font.getGlyphWidths(run.glyphs) };
    for (const [wordIndex, word] of shaped.entries()) {
      const parts = word.word.emphasized ? word.letters : [word.rects];
      parts.forEach((rects, index) => {
        const { glyphs, positions } = selectGlyphSlice(selectionRun, rects);
        if (glyphs.length) word.runs[index].push({ glyphs, positions, font: run.font });
        const inks = sliceInk[wordIndex][index];
        // Inspect actual shaped ink, including zero-advance marks and fallback
        // runs. Bounding-box overlap is conservative: false positives only use
        // the same alpha mask; glyph ownership and slice clips stay unchanged.
        run.glyphs.forEach((_glyph, glyphIndex) => {
          const x = run.origin.x + run.positions[glyphIndex].x;
          const y = run.origin.y + run.positions[glyphIndex].y;
          if (!positions.some(position => position.x === x && position.y === y)) return;
          const bounds = run.bounds[glyphIndex];
          const ink = { x: x + bounds.x, y: y + bounds.y, width: bounds.width, height: bounds.height };
          if (inks.some(other => Math.min(ink.x + ink.width, other.x + other.width) > Math.max(ink.x, other.x) &&
              Math.min(ink.y + ink.height, other.y + other.height) > Math.max(ink.y, other.y))) word.overlapMask[index] = true;
          inks.push(ink);
        });
        // An owned glyph may overhang its advance box. Keep that ink on its
        // own syllable without admitting the next syllable's glyphs. Shared
        // ligatures retain their original slice clip.
        const clip = Skia.PathBuilder.Make().addPath(word.clips[index]);
        run.glyphs.forEach((_glyph, glyphIndex) => {
          const x = run.origin.x + run.positions[glyphIndex].x;
          const y = run.origin.y + run.positions[glyphIndex].y;
          const advance = selectionRun.advances[glyphIndex];
          if (advance > 0 && rects.some(rect => y > rect.y && y <= rect.y + rect.height &&
            x >= rect.x - 0.01 && x + advance <= rect.x + rect.width + 0.01)) {
            const ink = run.bounds[glyphIndex];
            clip.addRect(Skia.XYWHRect(x + ink.x, y + ink.y, ink.width, ink.height));
          }
        });
        word.clips[index] = clip.detach();
      });
    }
  });
  // Connected timing atoms may still share ink after their independent
  // transforms. Keep their original ownership/motion, but composite presented
  // slices together. Whitespace/gap boundaries keep unrelated words direct.
  let groupStart = 0;
  const finishGroup = (end: number) => {
    if (shaped.slice(groupStart, end).reduce((n, word) => n + word.runs.filter(runs => runs.length > 0).length, 0) < 2) return;
    for (let i = groupStart; i < end; i++) {
      const rects = [...shaped[i].rects, ...shaped[i].letters.flat(), ...sliceInk[i].flat()];
      if (!rects.length) continue;
      const x = Math.min(...rects.map(rect => rect.x)), y = Math.min(...rects.map(rect => rect.y));
      shaped[i].unionGroup = groupStart;
      shaped[i].unionInk = { x, y, width: Math.max(...rects.map(rect => rect.x + rect.width)) - x,
        height: Math.max(...rects.map(rect => rect.y + rect.height)) - y };
    }
  };
  for (let i = 1; i <= shaped.length; i++) {
    const previous = shaped[i - 1], next = shaped[i];
    const joined = next && previous.word.offset + previous.word.text.length === next.word.offset && !previous.word.gapAfter &&
      !/\s$/.test(previous.word.text) && !/^\s/.test(next.word.text);
    const inkTouches = next && sliceInk[i - 1].some(part => part.some(a => sliceInk[i].some(other => other.some(b =>
      Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) && Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y)))));
    if (!joined && !inkTouches) { finishGroup(i); groupStart = i; }
  }
  const sourcePaint = Skia.Paint();
  sourcePaint.setAntiAlias(true);
  sourcePaint.setColor(Skia.Color('white'));
  for (const word of shaped) if (spicy || word.emojiMask.some(Boolean) || word.overlapMask.some(Boolean) || word.unionGroup !== undefined) word.pictures = word.runs.map((runs, index) => createPicture(canvas => {
    canvas.clipPath(word.clips[index], ClipOp.Intersect, true);
    for (const run of runs) canvas.drawGlyphs(run.glyphs, run.positions, 0, 0, run.font, sourcePaint);
  }));
  return shaped;
}

function transform(canvas: SkCanvas, rect: SkRect, scale: number, x: number, y: number, origin = 0.5) {
  'worklet';
  const ox = rect.x + rect.width * origin;
  const oy = rect.y + rect.height / 2;
  canvas.translate(x, y);
  canvas.translate(ox, oy);
  canvas.scale(scale, scale);
  canvas.translate(-ox, -oy);
}

function drawGlyphSlice(canvas: SkCanvas, word: ShapedGlyphWord, letter: number, paint: SkPaint) {
  'worklet';
  if (word.emojiMask[letter] || word.overlapMask?.[letter] || word.unionGroup !== undefined) {
    // shirorekha-alpha-union-v1: apply reveal alpha once to opaque glyph ink.
    // With coverage c1,c2 and alpha a, direct SrcOver gives
    // a*c1 + a*c2*(1-a*c1). Masking gives a*(c1+c2*(1-c1)),
    // so solid overlapping headline strokes stay at a rather than 2a-a².
    // Color fallback glyphs can ignore a glyph paint's shader. Apply the
    // reveal to the recorded glyph alpha, including the inactive dim state.
    canvas.saveLayer();
    canvas.drawPicture(word.pictures[letter]);
    paint.setBlendMode(BlendMode.SrcIn);
    canvas.drawPaint(paint);
    canvas.restore();
    paint.setBlendMode(BlendMode.SrcOver);
  } else for (const run of word.runs[letter]) canvas.drawGlyphs(run.glyphs, run.positions, 0, 0, run.font, paint);
}

// Encode the already-rasterized slice's alpha into opaque RGB. Lighten
// between opaque images is exactly max(Rsrc,Rdst), unlike Lighten on white
// translucent ink (whose alpha still uses SrcOver). Decode max(R) to white
// alpha once. This keeps each slice's transform, reveal and glow intact.
function getUnionPaints(paints: ReusableGlyphPaints) {
  'worklet';
  if (paints.unionPaints) return paints.unionPaints;
  const encode = Skia.Paint(), decode = Skia.Paint();
  encode.setColorFilter(Skia.ColorFilter.MakeMatrix([
    0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1,
  ]));
  encode.setBlendMode(BlendMode.Lighten);
  decode.setColorFilter(Skia.ColorFilter.MakeMatrix([
    0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0,
  ]));
  if (paints.arrivalCounts) paints.arrivalCounts.paintConstructors += 2;
  paints.unionPaints = { encode, decode };
  return paints.unionPaints;
}

// Bounds include actual fallback ink and conservatively bound both nested
// transforms and 4 sigma of glow. They are allocation hints, never new clips.
function unionBounds(words: ShapedGlyphWord[], motions: WordMotion[], start: number, end: number, time: number,
  spicy: boolean, background: boolean, fontSize: number, clock: AmllFloatClock) {
  'worklet';
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  let wordScale = 1, wordDelta = 0, letterScale = 1, letterDelta = 0, wordY = 0, letterX = 0, letterY = 0, sigma = 0;
  const unit = background ? fontSize / 0.75 : fontSize;
  for (let i = start; i < end; i++) {
    const word = words[i], motion = motions[i], ink = word.unionInk!;
    left = Math.min(left, ink.x); top = Math.min(top, ink.y);
    right = Math.max(right, ink.x + ink.width); bottom = Math.max(bottom, ink.y + ink.height);
    const scale = spicy ? motion.scale : 1;
    wordScale = Math.max(wordScale, Math.abs(scale)); wordDelta = Math.max(wordDelta, Math.abs(scale - 1));
    wordY = Math.max(wordY, Math.abs(spicy ? motion.y * unit : amllFloat(amllWordFloatPosition(clock, time, word.word.start, word.word.end), word.word.start, word.word.end, background) * fontSize));
    if (!word.word.emphasized && spicy) sigma = Math.max(sigma, (4 + 2 * motion.glow) / 2);
    if (word.word.emphasized) for (let letter = 0; letter < word.runs.length; letter++) {
      if (spicy) {
        const m = motion.letters[letter] ?? motion;
        letterScale = Math.max(letterScale, Math.abs(m.scale)); letterDelta = Math.max(letterDelta, Math.abs(m.scale - 1));
        letterY = Math.max(letterY, Math.abs(m.y * unit)); sigma = Math.max(sigma, (4 + 12 * m.glow) / 2);
      } else {
        const m = amllEmphasis(time, word.word.emphasis?.start ?? word.word.start, word.word.emphasis?.end ?? word.word.end,
          (word.word.emphasis?.index ?? 0) + letter, word.word.emphasis?.count ?? word.word.letters.length,
          word.word.emphasis?.last ?? i === words.length - 1, background);
        letterScale = Math.max(letterScale, Math.abs(m.scale)); letterDelta = Math.max(letterDelta, Math.abs(m.scale - 1));
        letterX = Math.max(letterX, Math.abs(m.x * fontSize)); letterY = Math.max(letterY, Math.abs(m.y * fontSize));
        sigma = Math.max(sigma, m.radius * fontSize / 2);
      }
    }
  }
  const expansion = wordDelta + wordScale * letterDelta;
  const blur = 4 * sigma * wordScale * letterScale + 2;
  const x = (right - left) * expansion + wordScale * letterX + blur;
  const y = (bottom - top) * expansion + wordY + wordScale * letterY + blur;
  return Skia.XYWHRect(left - x, top - y, right - left + x * 2, bottom - top + y * 2);
}

function drawVoice(canvas: SkCanvas, words: ShapedGlyphWord[], motions: WordMotion[], time: number, active: boolean,
  spicy: boolean, background: boolean, fontSize: number, lineEnd: number, line: ReferenceLineMotion, floatClock: AmllFloatClock,
  paints: ReusableGlyphPaints) {
  'worklet';
  const { paint, glowPaint } = paints;
  paint.setAntiAlias(true);
  // A reusable Paint must begin each recording with SkPaint's native default.
  paint.setColor(Skia.Color('black'));
  glowPaint.setAntiAlias(true);
  const fade = (words[0]?.rects[0]?.height ?? fontSize) * 0.56;
  let advanced = 0;
  if (!spicy) for (let i = 0; i < words.length; i++) {
    const word = words[i];
    advanced += clamp01((time - word.word.start) / Math.max(1, word.word.end - word.word.start)) *
      (word.width + (i === 0 ? fade * 1.5 : 0) + (i === words.length - 1 ? fade * 0.5 : 0));
  }
  let groupEnd = -1;
  let groupBounds: SkRect | undefined;
  words.forEach((word, index) => {
    const union = word.unionGroup !== undefined;
    if (union && index >= groupEnd) {
      groupEnd = index + 1;
      while (groupEnd < words.length && words[groupEnd].unionGroup === word.unionGroup) groupEnd++;
      groupBounds = unionBounds(words, motions, index, groupEnd, time, spicy, background, fontSize, floatClock);
      // cross-slice-alpha-max-v1: opaque RGB max of independently drawn slices.
      canvas.saveLayer(getUnionPaints(paints).decode, groupBounds);
      canvas.clear(Skia.Color('black'));
    }
    const bounds = word.rects[0];
    if (!bounds) { if (union && index + 1 === groupEnd) canvas.restore(); return; }
    const motion = motions[index];
    const sung = time > lineEnd;
    canvas.save();
    const floatTime = amllWordFloatPosition(floatClock, time, word.word.start, word.word.end);
    transform(canvas, bounds, spicy ? motion.scale : 1, 0,
      spicy ? motion.y * (background ? fontSize / 0.75 : fontSize) : amllFloat(floatTime, word.word.start, word.word.end, background) * fontSize, word.word.origin ?? 0.5);
    word.runs.forEach((_runs, letter) => {
      const rects = word.word.emphasized ? word.letters[letter] : word.rects;
      const rect = rects[0];
      if (!rect) return;
      if (union) canvas.saveLayer(getUnionPaints(paints).encode);
      canvas.save();
      let glow = 0;
      let radius = 0;
      let gradient = motion.gradient;
      if (word.word.emphasized) {
        if (spicy) {
          const m = motion.letters[letter] ?? motion;
          transform(canvas, rect, m.scale, 0, m.y * (background ? fontSize / 0.75 : fontSize));
          glow = clamp01(m.glow * 1.85) * 0.5;
          radius = (4 + 12 * m.glow) / 2;
          gradient = m.gradient;
        } else if (!spicy) {
          const m = amllEmphasis(time, word.word.emphasis?.start ?? word.word.start, word.word.emphasis?.end ?? word.word.end,
            (word.word.emphasis?.index ?? 0) + letter, word.word.emphasis?.count ?? word.word.letters.length,
            word.word.emphasis?.last ?? index === words.length - 1, background);
          transform(canvas, rect, m.scale, m.x * fontSize, m.y * fontSize);
          glow = m.glow;
          radius = m.radius * fontSize / 2;
        }
      } else if (spicy) {
        glow = clamp01(motion.glow * 0.35) * 0.5;
        radius = (4 + 2 * motion.glow) / 2;
      }
      let shader: SkShader | null = null;
      // AMLL's filtered bright/dark values keep releasing after deactivation.
      // Switching straight to uniform dark paint produces a one-frame flash.
      if (!active && spicy) {
        paint.setShader(null);
        paint.setColor(Skia.Color('white'));
        paint.setAlphaf(spicy ? sung ? background ? 0.6 : 0.85 : background ? 0.3 : 0.5 : line.dark);
      } else {
        const rtl = spicyIsRtl(word.word.text);
        const extent = spicy ? word.revealRects[letter] : rect;
        const x = spicy ? rtl ? extent.x + extent.width * (1 - gradient) : extent.x + extent.width * gradient : amllRevealStart(rect, word.rects, advanced, word.before, fade);
        const length = spicy ? extent.width * 0.2 * (rtl ? -1 : 1) : fade;
        paint.setAlphaf(1);
        shader = revealShaderForDraw(paints, x, rect.y, x + length,
          spicy ? background ? 0.6 : 0.85 : line.bright,
          spicy ? background ? 0.3 : 0.5 : line.dark);
        paint.setShader(shader);
      }
      if (glow > 0.001 && active) {
        glowPaint.setShader(spicy || word.emojiMask[letter] ? null : shader);
        glowPaint.setColor(Skia.Color('white'));
        glowPaint.setAlphaf(glow);
        // Blur the clipped letter image, not each whole intersecting glyph.
        // Ligatures shared by two slices must not emit their full glow twice.
        const sigma = Math.max(0.01, radius);
        glowPaint.setImageFilter(glowFilterForDraw(paints, sigma));
        // Unemphasized Spicy glows keep the original surface: changing its
        // bounds can change sub-byte blur tails exposed as zero-alpha PNG RGB.
        if (!spicy || word.word.emphasized) {
          const clip = word.clips[letter];
          const clipBounds = typeof clip?.getBounds === 'function' ? clip.getBounds() : rect;
          const layer = blurLayerBounds(clipBounds, sigma);
          canvas.saveLayer(glowPaint, Skia.XYWHRect(layer.x, layer.y, layer.width, layer.height));
        } else canvas.saveLayer(glowPaint);
        if (spicy) canvas.drawPicture(word.pictures[letter]);
        else {
          canvas.clipPath(word.clips[letter], ClipOp.Intersect, true);
          drawGlyphSlice(canvas, word, letter, paint);
        }
        canvas.restore();
      }
      canvas.clipPath(word.clips[letter], ClipOp.Intersect, true);
      drawGlyphSlice(canvas, word, letter, paint);
      canvas.restore();
      if (union) canvas.restore();
    });
    canvas.restore();
    if (union && index + 1 === groupEnd) canvas.restore();
  });
}

function reportArrivalPicture(handle: ArrivalHandle, generation: number, duration: number, epoch: number) {
  arrivalPicture(handle, generation, duration, epoch);
}

/** One native display list per voice, with no React glyph nodes or per-glyph alpha layers. */
const pictureNativeMonotonicNow = typeof performance !== 'undefined' ? performance.now : null;
const pictureTraceEnabled = typeof __DEV__ !== 'undefined' && __DEV__;
const NativeGlyphPictureDevelopment = function NativeGlyphPictureDevelopment({ words, width, height, position, active, spicy, background, fontSize, lineEnd, lineMotion, arrivalOwner, arrivalGeneration = 0 }: {
  arrivalOwner?: ArrivalHandle; arrivalGeneration?: number;
  words: ShapedGlyphWord[]; width: number; height: number; position: SharedValue<number>; active: SharedValue<boolean>;
  spicy: boolean; background: boolean; fontSize: number; lineEnd: number; lineMotion: SharedValue<ReferenceLineMotion>;
}) {
  const measurement = useArrivalPictureMeasurement(arrivalOwner, arrivalGeneration, words, width, height);
  const bounds = useMemo(() => Skia.XYWHRect(-64, -64, width + 128, height + 128), [height, width]);
  const empty = useMemo(() => createPicture(() => {}, bounds), [bounds]);
  const picture = useSharedValue(empty);
  const paints = useSharedValue<ReusableGlyphPaints | null>(null);
  const traceFrames = useSharedValue(0);
  const state = useSharedValue({ words: words.map(w => initialWordSpringState(w.word)), motions: [] as WordMotion[], time: -1, active: false, dark: -1, bright: -1,
    floatClock: { active: false, releasePosition: -1, elapsed: 0 } as AmllFloatClock, cached: false });
  const frame = useFrameCallback(useCallback(info => {
    'worklet';
    const time = position.value;
    const pictureStarted = pictureTraceEnabled ? performance.now() : 0;
    const previous = state.value;
    const isActive = active.value;
    // A proven idle picture needs no word scans while its presentation is unchanged.
    if (previous.cached && isActive === previous.active && lineMotion.value.dark === previous.dark && lineMotion.value.bright === previous.bright &&
      (time === previous.time || !isActive && (time < lineEnd) === (previous.time < lineEnd) &&
        (time < words[0].word.start || time > lineEnd + 1500))) {
      if (time !== previous.time) state.modify(s => { s.time = time; return s; }, false);
      return;
    }
    const dt = Math.min(0.064, Math.max(0, (info.timeSincePreviousFrame ?? 0) / 1000));
    const floatClock = advanceAmllFloatClock(previous.floatClock, isActive, time, dt * 1000);
    const floatSettled = spicy || words.every(w => amllWordFloatPosition(floatClock, time, w.word.start, w.word.end) <= w.word.start);
    const idle = floatSettled && !isActive && !previous.active && (time < lineEnd) === (previous.time < lineEnd);
    const settled = !spicy || previous.words.every(w => w.settled);
    if (settled && previous.motions.length && isActive === previous.active && (isActive || floatSettled) &&
      lineMotion.value.dark === previous.dark && lineMotion.value.bright === previous.bright && time === previous.time) {
      state.modify(s => { s.cached = true; return s; }, false);
      return;
    }
    // Future/settled voices keep a cached picture. Their position/blur/alpha is
    // composited by the parent without rebuilding glyph commands each frame.
    if (settled && previous.motions.length && idle && (time < words[0].word.start || time > lineEnd + 1500) &&
      lineMotion.value.dark === previous.dark && lineMotion.value.bright === previous.bright) {
      state.modify(s => { s.time = time; s.cached = true; return s; }, false);
      return;
    }
    const next = spicy ? words.map((w, index) => advanceReferenceWordMotion(w.word, previous.cached
      ? { ...previous.words[index], previousPosition: previous.time } : previous.words[index], time, dt)) : [];
    const motions = spicy ? next.map(w => w.motion) : previous.motions.length ? previous.motions : words.map(() => ({ scale: 1, y: 0, glow: 0, gradient: 0, letters: [] }));
    const cachedPaints = paints.value;
    const totals = pictureTraceEnabled && measurement && measurement.counts.value.active ? { ...measurement.counts.value } : undefined;
    if (totals && !cachedPaints) totals.paintConstructors += 2;
    const reusablePaints: ReusableGlyphPaints = cachedPaints ?? { paint: Skia.Paint(), glowPaint: Skia.Paint(), blurRadii: [], blurFilters: [], revealShaders: [] };
    if (pictureTraceEnabled && totals) reusablePaints.arrivalCounts = totals;
    const arrivalStarted = pictureTraceEnabled && totals && !totals.reported ? performance.now() : 0;
    picture.value = createPicture(canvas => drawVoice(canvas, words, motions, time, isActive, spicy, background, fontSize, lineEnd,
      lineMotion.value, floatClock, reusablePaints), bounds);
    if (pictureTraceEnabled && measurement && totals) {
      totals.pictureBuilds++;
      if (!totals.reported) {
        totals.reported = true;
        scheduleOnRN(reportArrivalPicture, measurement.handle, measurement.generation, performance.now() - arrivalStarted, measurement.epoch);
      }
      measurement.counts.value = totals;
      reusablePaints.arrivalCounts = undefined;
    }
    if (pictureTraceEnabled && isActive && traceFrames.value < 2) {
      traceFrames.value++;
      let nativeNow: number | null = null;
      try { nativeNow = pictureNativeMonotonicNow!(); } catch { /* Report unavailable native transfer explicitly. */ }
      scheduleOnRN(reportNativePicture, { style: spicy ? 'spicy' : 'amll', position: time, nativeNow,
        uiNow: performance.now(), pictureDurationMs: performance.now() - pictureStarted,
        lineStart: words[0]?.word.start ?? null, lineEnd, playing: true, background });
    }
    // Picture recording is synchronous and snapshots paint state. Release the
    // last frame's shader/filter refs while keeping the reusable Paint objects.
    reusablePaints.paint.setShader(null);
    reusablePaints.glowPaint.setShader(null);
    reusablePaints.glowPaint.setImageFilter(null);
    if (!cachedPaints) paints.value = reusablePaints;
    state.value = { words: spicy ? next.map(w => w.state) : previous.words, motions, time, active: isActive,
      dark: lineMotion.value.dark, bright: lineMotion.value.bright, floatClock, cached: false };
  }, [measurement, active, background, bounds, fontSize, lineEnd, lineMotion, paints, picture, position, spicy, state, traceFrames, words]), false);
  useEffect(() => { frame.setActive(words.length > 0); return () => frame.setActive(false); }, [frame, words]);
  return <Picture picture={picture} />;
};

// Exact c2aaa20 component body: no arrival hooks, shared values or callback captures.
const NativeGlyphPictureProduction = function NativeGlyphPicture({ words, width, height, position, active, spicy, background, fontSize, lineEnd, lineMotion }: {
  words: ShapedGlyphWord[]; width: number; height: number; position: SharedValue<number>; active: SharedValue<boolean>;
  spicy: boolean; background: boolean; fontSize: number; lineEnd: number; lineMotion: SharedValue<ReferenceLineMotion>;
}) {
  const bounds = useMemo(() => Skia.XYWHRect(-64, -64, width + 128, height + 128), [height, width]);
  const empty = useMemo(() => createPicture(() => {}, bounds), [bounds]);
  const picture = useSharedValue(empty);
  const paints = useSharedValue<ReusableGlyphPaints | null>(null);
  const traceFrames = useSharedValue(0);
  const state = useSharedValue({ words: words.map(w => initialWordSpringState(w.word)), motions: [] as WordMotion[], time: -1, active: false, dark: -1, bright: -1,
    floatClock: { active: false, releasePosition: -1, elapsed: 0 } as AmllFloatClock, cached: false });
  const frame = useFrameCallback(useCallback(info => {
    'worklet';
    const time = position.value;
    const pictureStarted = pictureTraceEnabled ? performance.now() : 0;
    const previous = state.value;
    const isActive = active.value;
    // A proven idle picture needs no word scans while its presentation is unchanged.
    if (previous.cached && isActive === previous.active && lineMotion.value.dark === previous.dark && lineMotion.value.bright === previous.bright &&
      (time === previous.time || !isActive && (time < lineEnd) === (previous.time < lineEnd) &&
        (time < words[0].word.start || time > lineEnd + 1500))) {
      if (time !== previous.time) state.modify(s => { s.time = time; return s; }, false);
      return;
    }
    const dt = Math.min(0.064, Math.max(0, (info.timeSincePreviousFrame ?? 0) / 1000));
    const floatClock = advanceAmllFloatClock(previous.floatClock, isActive, time, dt * 1000);
    const floatSettled = spicy || words.every(w => amllWordFloatPosition(floatClock, time, w.word.start, w.word.end) <= w.word.start);
    const idle = floatSettled && !isActive && !previous.active && (time < lineEnd) === (previous.time < lineEnd);
    const settled = !spicy || previous.words.every(w => w.settled);
    if (settled && previous.motions.length && isActive === previous.active && (isActive || floatSettled) &&
      lineMotion.value.dark === previous.dark && lineMotion.value.bright === previous.bright && time === previous.time) {
      state.modify(s => { s.cached = true; return s; }, false);
      return;
    }
    // Future/settled voices keep a cached picture. Their position/blur/alpha is
    // composited by the parent without rebuilding glyph commands each frame.
    if (settled && previous.motions.length && idle && (time < words[0].word.start || time > lineEnd + 1500) &&
      lineMotion.value.dark === previous.dark && lineMotion.value.bright === previous.bright) {
      state.modify(s => { s.time = time; s.cached = true; return s; }, false);
      return;
    }
    const next = spicy ? words.map((w, index) => advanceReferenceWordMotion(w.word, previous.cached
      ? { ...previous.words[index], previousPosition: previous.time } : previous.words[index], time, dt)) : [];
    const motions = spicy ? next.map(w => w.motion) : previous.motions.length ? previous.motions : words.map(() => ({ scale: 1, y: 0, glow: 0, gradient: 0, letters: [] }));
    const cachedPaints = paints.value;
    const reusablePaints = cachedPaints ?? { paint: Skia.Paint(), glowPaint: Skia.Paint(), blurRadii: [], blurFilters: [], revealShaders: [] };
    picture.value = createPicture(canvas => drawVoice(canvas, words, motions, time, isActive, spicy, background, fontSize, lineEnd,
      lineMotion.value, floatClock, reusablePaints), bounds);
    if (pictureTraceEnabled && isActive && traceFrames.value < 2) {
      traceFrames.value++;
      let nativeNow: number | null = null;
      try { nativeNow = pictureNativeMonotonicNow!(); } catch { /* Report unavailable native transfer explicitly. */ }
      scheduleOnRN(reportNativePicture, { style: spicy ? 'spicy' : 'amll', position: time, nativeNow,
        uiNow: performance.now(), pictureDurationMs: performance.now() - pictureStarted,
        lineStart: words[0]?.word.start ?? null, lineEnd, playing: true, background });
    }
    // Picture recording is synchronous and snapshots paint state. Release the
    // last frame's shader/filter refs while keeping the reusable Paint objects.
    reusablePaints.paint.setShader(null);
    reusablePaints.glowPaint.setShader(null);
    reusablePaints.glowPaint.setImageFilter(null);
    if (!cachedPaints) paints.value = reusablePaints;
    state.value = { words: spicy ? next.map(w => w.state) : previous.words, motions, time, active: isActive,
      dark: lineMotion.value.dark, bright: lineMotion.value.bright, floatClock, cached: false };
  }, [active, background, bounds, fontSize, lineEnd, lineMotion, paints, picture, position, spicy, state, traceFrames, words]), false);
  useEffect(() => { frame.setActive(words.length > 0); return () => frame.setActive(false); }, [frame, words]);
  return <Picture picture={picture} />;
};
export const NativeGlyphPicture = memo(pictureTraceEnabled ? NativeGlyphPictureDevelopment : NativeGlyphPictureProduction);
