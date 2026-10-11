import React, { memo, useCallback, useEffect, useMemo } from 'react';
import { BlurStyle, ClipOp, createPicture, Picture, Skia, TileMode, type SkCanvas, type SkFont, type SkParagraph, type SkPoint, type SkRect, type SkShader, type SkPath } from '@shopify/react-native-skia';
import { useFrameCallback, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { selectGlyphSlice } from './native-glyph-layout';
import type { NativePaintWord } from './native-lyrics-model';
import { advanceReferenceWordMotion, initialWordSpringState, type WordMotion } from './reference-word-motion';
import { amllEmphasis, amllFloat, clamp01 } from './reference-motion';
import type { ReferenceLineMotion } from './use-reference-line-motion';
import { spicyIsRtl } from './spicy-text-policy';
import { advanceAmllFloatClock, amllWordFloatPosition, type AmllFloatClock } from './amll-float-clock';

type GlyphRun = { glyphs: number[]; positions: SkPoint[]; font: SkFont };
export type PictureWord = { word: NativePaintWord; rects: SkRect[]; letters: SkRect[][]; width: number; before: number };
type ShapedGlyphWord = PictureWord & { runs: GlyphRun[][]; clips: SkPath[] };

/** Read the paragraph's actual shaped glyphs, including fallback fonts and RTL placement. */
export function shapeGlyphWords(paragraph: SkParagraph, words: PictureWord[]): ShapedGlyphWord[] {
  const shaped = words.map(word => {
    const parts = word.word.emphasized ? word.letters : [word.rects];
    return { ...word, runs: parts.map(() => [] as GlyphRun[]), clips: parts.map(rects => {
      const path = Skia.PathBuilder.Make();
      rects.forEach(rect => path.addRect(rect));
      return path.detach();
    }) };
  });
  paragraph.extendedVisit((_line, run) => {
    if (!run) return;
    for (const word of shaped) {
      const parts = word.word.emphasized ? word.letters : [word.rects];
      parts.forEach((rects, index) => {
        const { glyphs, positions } = selectGlyphSlice(run, rects);
        if (glyphs.length) word.runs[index].push({ glyphs, positions, font: run.font });
      });
    }
  });
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

function drawVoice(canvas: SkCanvas, words: ShapedGlyphWord[], motions: WordMotion[], time: number, active: boolean,
  spicy: boolean, background: boolean, fontSize: number, lineEnd: number, line: ReferenceLineMotion, floatClock: AmllFloatClock) {
  'worklet';
  const paint = Skia.Paint();
  paint.setAntiAlias(true);
  const glowPaint = Skia.Paint();
  glowPaint.setAntiAlias(true);
  const fade = (words[0]?.rects[0]?.height ?? fontSize) * 0.56;
  let advanced = 0;
  if (!spicy) for (let i = 0; i < words.length; i++) {
    const word = words[i];
    advanced += clamp01((time - word.word.start) / Math.max(1, word.word.end - word.word.start)) *
      (word.width + (i === 0 ? fade * 1.5 : 0) + (i === words.length - 1 ? fade * 0.5 : 0));
  }
  words.forEach((word, index) => {
    const bounds = word.rects[0];
    if (!bounds) return;
    const motion = motions[index];
    const sung = time > lineEnd;
    canvas.save();
    const floatTime = amllWordFloatPosition(floatClock, time, word.word.start, word.word.end);
    transform(canvas, bounds, spicy ? motion.scale : 1, 0,
      spicy ? motion.y * (background ? fontSize / 0.75 : fontSize) : amllFloat(floatTime, word.word.start, word.word.end, background) * fontSize, word.word.origin ?? 0.5);
    word.runs.forEach((runs, letter) => {
      const rect = (word.word.emphasized ? word.letters[letter] : word.rects)[0];
      if (!rect) return;
      canvas.save();
      let glow = 0;
      let radius = 0;
      let gradient = motion.gradient;
      if (word.word.emphasized) {
        if (spicy) {
          const m = motion.letters[letter] ?? motion;
          transform(canvas, rect, m.scale, 0, m.y * (background ? fontSize / 0.75 : fontSize));
          glow = clamp01(m.glow * 1.85);
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
        glow = clamp01(motion.glow * 0.35);
        radius = (4 + 2 * motion.glow) / 2;
      }
      let shader: SkShader | null = null;
      if (!active) {
        paint.setShader(null);
        paint.setColor(Skia.Color('white'));
        paint.setAlphaf(spicy ? sung ? background ? 0.6 : 0.85 : background ? 0.3 : 0.5 : line.dark);
      } else {
        const rtl = spicyIsRtl(word.word.text);
        const x = spicy ? rtl ? rect.x + rect.width * (1 - gradient) : rect.x + rect.width * gradient : rect.x + advanced - word.before - fade * 2;
        const length = spicy ? rect.width * 0.2 * (rtl ? -1 : 1) : fade;
        paint.setAlphaf(1);
        shader = Skia.Shader.MakeLinearGradient({ x, y: rect.y }, { x: x + length, y: rect.y },
          [Skia.Color(`rgba(255,255,255,${spicy ? background ? 0.6 : 0.85 : line.bright})`),
            Skia.Color(`rgba(255,255,255,${spicy ? background ? 0.3 : 0.5 : line.dark})`)], null, TileMode.Clamp);
        paint.setShader(shader);
      }
      if (glow > 0.001 && active) {
        glowPaint.setShader(spicy ? null : shader);
        glowPaint.setColor(Skia.Color('white'));
        glowPaint.setAlphaf(glow);
        glowPaint.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, Math.max(0.01, radius), true));
        for (const run of runs) canvas.drawGlyphs(run.glyphs, run.positions, 0, 0, run.font, glowPaint);
      }
      canvas.clipPath(word.clips[letter], ClipOp.Intersect, true);
      for (const run of runs) canvas.drawGlyphs(run.glyphs, run.positions, 0, 0, run.font, paint);
      canvas.restore();
    });
    canvas.restore();
  });
}

/** One native display list per voice, with no React glyph nodes or per-glyph alpha layers. */
export const NativeGlyphPicture = memo(function NativeGlyphPicture({ words, width, height, position, active, spicy, background, fontSize, lineEnd, lineMotion }: {
  words: ShapedGlyphWord[]; width: number; height: number; position: SharedValue<number>; active: SharedValue<boolean>;
  spicy: boolean; background: boolean; fontSize: number; lineEnd: number; lineMotion: SharedValue<ReferenceLineMotion>;
}) {
  const bounds = useMemo(() => Skia.XYWHRect(-32, -32, width + 64, height + 64), [height, width]);
  const empty = useMemo(() => createPicture(() => {}, bounds), [bounds]);
  const picture = useSharedValue(empty);
  const state = useSharedValue({ words: words.map(w => initialWordSpringState(w.word)), motions: [] as WordMotion[], time: -1, active: false, dark: -1, bright: -1,
    floatClock: { active: false, releasePosition: -1, elapsed: 0 } as AmllFloatClock });
  const frame = useFrameCallback(useCallback(info => {
    'worklet';
    const time = position.value;
    const previous = state.value;
    const isActive = active.value;
    const dt = Math.min(0.064, Math.max(0, (info.timeSincePreviousFrame ?? 0) / 1000));
    const floatClock = advanceAmllFloatClock(previous.floatClock, isActive, time, dt * 1000);
    const floatSettled = spicy || words.every(w => amllWordFloatPosition(floatClock, time, w.word.start, w.word.end) <= w.word.start);
    const idle = floatSettled && !isActive && !previous.active && (time < lineEnd) === (previous.time < lineEnd);
    const settled = !spicy || previous.words.every(w => w.settled);
    if (settled && previous.motions.length && isActive === previous.active && (isActive || floatSettled) &&
      lineMotion.value.dark === previous.dark && lineMotion.value.bright === previous.bright && time === previous.time) return;
    // Future/settled voices keep a cached picture. Their position/blur/alpha is
    // composited by the parent without rebuilding glyph commands each frame.
    if (settled && previous.motions.length && idle && (time < words[0].word.start || time > lineEnd + 1500) && lineMotion.value.dark === previous.dark) {
      state.modify(s => { s.time = time; for (const w of s.words) w.previousPosition = time; return s; }, false);
      return;
    }
    const next = spicy ? words.map((w, index) => advanceReferenceWordMotion(w.word, previous.words[index], time, dt)) : [];
    const motions = spicy ? next.map(w => w.motion) : previous.motions.length ? previous.motions : words.map(() => ({ scale: 1, y: 0, glow: 0, gradient: 0, letters: [] }));
    picture.value = createPicture(canvas => drawVoice(canvas, words, motions, time, isActive, spicy, background, fontSize, lineEnd, lineMotion.value, floatClock), bounds);
    state.value = { words: spicy ? next.map(w => w.state) : previous.words, motions, time, active: isActive,
      dark: lineMotion.value.dark, bright: lineMotion.value.bright, floatClock };
  }, [active, background, bounds, fontSize, lineEnd, lineMotion, picture, position, spicy, state, words]), false);
  useEffect(() => { frame.setActive(words.length > 0); return () => frame.setActive(false); }, [frame, words]);
  return <Picture picture={picture} />;
});

