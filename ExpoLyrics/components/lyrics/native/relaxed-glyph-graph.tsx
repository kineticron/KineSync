import { changedScalar } from './relaxed-epsilon';
import React, { memo, useCallback, useEffect, useMemo } from 'react';
import { Blur, ColorMatrix, Fill, ClipOp, createPicture, Group, LinearGradient, Paint, Path, Picture, Skia, type SkColor, type SkRect } from '@shopify/react-native-skia';
import { makeMutable, useFrameCallback, type SharedValue } from 'react-native-reanimated';
import type { ShapedGlyphWord } from './native-glyph-picture';
import { initialWordSpringState, type WordMotion, type WordSpringState } from './reference-word-motion';
import { advanceReferenceWordMotion } from './reference-word-motion';
import { amllEmphasis, amllFloat, clamp01 } from './reference-motion';
import { amllWordFloatPosition, type AmllFloatClock } from './amll-float-clock';
import { amllRevealStart } from './native-glyph-layout';
import { spicyIsRtl } from './spicy-text-policy';
import type { ReferenceLineMotion } from './use-reference-line-motion';

type AmllEmphasis = ReturnType<typeof amllEmphasis>;

type Cell = { emphasis: AmllEmphasis; matrix: SharedValue<number[]>; start: SharedValue<{ x: number; y: number }>; end: SharedValue<{ x: number; y: number }>;
  colors: SharedValue<SkColor[]>; glow: SharedValue<number>; inkOpacity: SharedValue<number>; radius: SharedValue<number> };
type WordCell = { rtl: boolean; matrix: SharedValue<number[]>; slices: Cell[]; spring: WordSpringState; motion: WordMotion };
export type RelaxedGlyphState = { ready: SharedValue<number>; words: WordCell[]; clock: AmllFloatClock; time: number; active: boolean; cached: boolean; dark: number; bright: number };
export type RelaxedGlyphOptions = { spicy: boolean; background: boolean; fontSize: number; lineEnd: number; epsilon?: boolean };
const identity = () => [1, 0, 0, 0, 1, 0, 0, 0, 1];
export function createRelaxedGlyphState(words: ShapedGlyphWord[]): RelaxedGlyphState {
  return { ready: makeMutable(0), words: words.map(word => ({ rtl: spicyIsRtl(word.word.text), matrix: makeMutable(identity()), spring: initialWordSpringState(word.word),
    motion: { scale: 1, y: 0, glow: 0, gradient: 0, letters: word.word.emphasized ? word.word.letters.map(() => ({ scale: 1, y: 0, glow: 0, gradient: 0 })) : [] },
    slices: word.runs.map(() => ({ emphasis: { scale: 1, x: 0, y: 0, glow: 0, radius: 0 }, matrix: makeMutable(identity()), start: makeMutable({ x: 0, y: 0 }), end: makeMutable({ x: 1, y: 0 }),
      colors: makeMutable([Skia.Color('white'), Skia.Color('white')]), glow: makeMutable(0), inkOpacity: makeMutable(1), radius: makeMutable(0.01) })) })),
    clock: { active: false, releasePosition: -1, elapsed: 0 }, time: -1, active: false, cached: false, dark: -1, bright: -1 };
}
function notify<T>(value: T): T { 'worklet'; return value; }
function setMatrix(cell: SharedValue<number[]>, rect: SkRect, scale: number, x: number, y: number, origin = 0.5, epsilon = false, force = false) {
  'worklet';
  const ox = rect.x + rect.width * origin, oy = rect.y + rect.height / 2;
  const matrix = cell.value;
  const tx = x + ox - scale * ox, ty = y + oy - scale * oy;
  if (!changedScalar(matrix[0], scale, epsilon, force) && !changedScalar(matrix[2], tx, epsilon, force, 0.05) && !changedScalar(matrix[5], ty, epsilon, force, 0.05)) return;
  matrix[0] = scale; matrix[4] = scale;
  matrix[2] = tx; matrix[5] = ty;
  cell.modify(notify);
}
/** UI-runtime property updates only. The native recorder owns the draw traversal. */
export function updateRelaxedGlyphState(state: RelaxedGlyphState, words: ShapedGlyphWord[], time: number, active: boolean,
  dt: number, line: ReferenceLineMotion, options: RelaxedGlyphOptions) {
  'worklet';
  if (!words.length) return;
  state.ready.value = 1;
  const { spicy, background, fontSize, lineEnd, epsilon = false } = options;
  const force = active !== state.active || time < state.time || Math.abs(time - state.time) > 1000 || time === state.time;
  if (state.cached && active === state.active && line.dark === state.dark && line.bright === state.bright &&
    (time === state.time || !active && (time < lineEnd) === (state.time < lineEnd) &&
      (time < words[0].word.start || time > lineEnd + 1500))) { state.time = time; return; }
  const clock = state.clock;
  if (active) { clock.active = true; clock.releasePosition = time; clock.elapsed = 0; }
  else { clock.elapsed = clock.active ? dt * 1000 : clock.elapsed + dt * 1000; clock.active = false; }
  let floatSettled = true, settled = true;
  for (let i = 0; i < words.length; i++) {
    if (!spicy && amllWordFloatPosition(clock, time, words[i].word.start, words[i].word.end) > words[i].word.start) floatSettled = false;
    if (spicy && !state.words[i].spring.settled) settled = false;
  }
  const idle = floatSettled && !active && !state.active && (time < lineEnd) === (state.time < lineEnd);
  if (state.time !== -1 && settled && line.dark === state.dark && line.bright === state.bright &&
    (active === state.active && (active || floatSettled) && time === state.time || idle && (time < words[0].word.start || time > lineEnd + 1500))) {
    state.cached = true; state.time = time; return;
  }
  const fade = (words[0]?.rects[0]?.height ?? fontSize) * 0.56;
  let advanced = 0;
  if (!spicy) for (let i = 0; i < words.length; i++) advanced += clamp01((time - words[i].word.start) / Math.max(1, words[i].word.end - words[i].word.start)) *
    (words[i].width + (i === 0 ? fade * 1.5 : 0) + (i === words.length - 1 ? fade * 0.5 : 0));
  for (let i = 0; i < words.length; i++) {
    const word = words[i], cell = state.words[i], bounds = word.rects[0];
    let motion = cell.motion;
    if (spicy) { if (state.cached) cell.spring.previousPosition = state.time; const next = advanceReferenceWordMotion(word.word, cell.spring, time, dt); cell.spring = next.state; cell.motion = next.motion; motion = next.motion; }
    if (!bounds) continue;
    const publishFinal = force || spicy && cell.spring.settled || !active && floatSettled;
    const unit = background ? fontSize / 0.75 : fontSize;
    setMatrix(cell.matrix, bounds, spicy ? motion.scale : 1, 0, spicy ? motion.y * unit :
      amllFloat(amllWordFloatPosition(clock, time, word.word.start, word.word.end), word.word.start, word.word.end, background) * fontSize, word.word.origin ?? 0.5, epsilon, force || spicy && cell.spring.settled);
    for (let letter = 0; letter < cell.slices.length; letter++) {
      const rect = (word.word.emphasized ? word.letters[letter] : word.rects)[0];
      if (!rect) continue;
      const slice = cell.slices[letter];
      let glow = 0, radius = 0, gradient = motion.gradient;
      if (word.word.emphasized) {
        if (spicy) {
          const m = motion.letters[letter] ?? motion; setMatrix(slice.matrix, rect, m.scale, 0, m.y * unit, 0.5, epsilon, force || cell.spring.settled);
          glow = clamp01(m.glow * 1.85) * 0.5; radius = (4 + 12 * m.glow) / 2; gradient = m.gradient;
        } else {
          const m = amllEmphasis(time, word.word.emphasis?.start ?? word.word.start, word.word.emphasis?.end ?? word.word.end,
            (word.word.emphasis?.index ?? 0) + letter, word.word.emphasis?.count ?? word.word.letters.length,
            word.word.emphasis?.last ?? i === words.length - 1, background);
          setMatrix(slice.matrix, rect, m.scale, m.x * fontSize, m.y * fontSize, 0.5, epsilon, force || m.scale === 1); glow = m.glow; radius = m.radius * fontSize / 2;
        }
      } else if (spicy) { glow = clamp01(motion.glow * 0.35) * 0.5; radius = (4 + 2 * motion.glow) / 2; }
      const rtl = cell.rtl, extent = spicy ? word.revealRects[letter] : rect;
      const x = spicy ? rtl ? extent.x + extent.width * (1 - gradient) : extent.x + extent.width * gradient : amllRevealStart(rect, word.rects, advanced, word.before, fade);
      const length = spicy ? extent.width * 0.2 * (rtl ? -1 : 1) : fade;
      const start = slice.start.value, end = slice.end.value;
      if (changedScalar(start.x, x, epsilon, publishFinal, 0.05) || start.y !== rect.y) {
        start.x = x; start.y = rect.y; slice.start.modify(notify);
      }
      if (changedScalar(end.x, x + length, epsilon, publishFinal, 0.05) || end.y !== rect.y) {
        end.x = x + length; end.y = rect.y; slice.end.modify(notify);
      }
      const uniform = spicy && !active;
      const bright = spicy ? background ? 0.6 : 0.85 : line.bright;
      const dark = spicy ? background ? 0.3 : 0.5 : line.dark;
      const colors = slice.colors.value;
      const firstAlpha = uniform ? 1 : bright, lastAlpha = uniform ? 1 : dark;
      if (changedScalar(colors[0][3], firstAlpha, epsilon, publishFinal) || changedScalar(colors[1][3], lastAlpha, epsilon, publishFinal)) {
        colors[0][3] = firstAlpha; colors[1][3] = lastAlpha; slice.colors.modify(notify);
      }
      const opacity = uniform ? time > lineEnd ? bright : dark : 1;
      const alpha = active && glow > 0.001 ? glow : 0;
      const sigma = Math.max(0.01, radius);
      if (changedScalar(slice.inkOpacity.value, opacity, epsilon, force || opacity === 1)) slice.inkOpacity.value = opacity;
      if (changedScalar(slice.glow.value, alpha, epsilon, force || alpha === 0)) slice.glow.value = alpha;
      if (changedScalar(slice.radius.value, sigma, epsilon, publishFinal, 0.05)) slice.radius.value = sigma;
    }
  }
  state.time = time; state.active = active; state.dark = line.dark; state.bright = line.bright; state.cached = false;
}
const encode = [0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1];
const decode = [0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0];
// Group clips are aliased in Skia 2.13.1. The mask alternative is experimental
// until the real raster comparison demonstrates identical boundary coverage.
function SliceClip({ word, letter, children, clipMode }: { word: ShapedGlyphWord; letter: number; children: React.ReactNode; clipMode: 'mask' | 'group' }) {
  return clipMode === 'group' ? <Group clip={word.clips[letter]}>{children}</Group> : <Group layer>
    {children}<Group layer={<Paint blendMode="dstIn" />}><Path path={word.clips[letter]} color="white" antiAlias /></Group>
  </Group>;
}
function SliceInk({ word, letter, cell }: { word: ShapedGlyphWord; letter: number; cell: Cell }) {
  return <Group layer>
    <Picture picture={word.pictures[letter]} /><Fill blendMode="srcIn" opacity={cell.inkOpacity}>
      <LinearGradient start={cell.start} end={cell.end} colors={cell.colors} />
    </Fill>
  </Group>;
}
/** All ink is recorded once per shape, including ordinary AMLL slices. Existing
 * shaped Spicy/emoji/union pictures are shared; shader and transform state stay live.
 */
function pictureWords(words: ShapedGlyphWord[]): ShapedGlyphWord[] {
  const paint = Skia.Paint();
  paint.setAntiAlias(true); paint.setColor(Skia.Color('white'));
  return words.map(word => word.pictures.length === word.runs.length ? word : {
    ...word, pictures: word.runs.map((runs, letter) => createPicture(canvas => {
      canvas.clipPath(word.clips[letter], ClipOp.Intersect, true);
      for (const run of runs) canvas.drawGlyphs(run.glyphs, run.positions, 0, 0, run.font, paint);
    })),
  });
}
export function RelaxedGlyphGraph({ words, state, spicy, clipMode = 'group' }: { words: ShapedGlyphWord[]; state: RelaxedGlyphState; spicy: boolean; clipMode?: 'mask' | 'group' }) {
  const nodes: React.ReactNode[] = [];
  for (let index = 0; index < words.length;) {
    const start = index, group = words[index].unionGroup; index++;
    if (group !== undefined) while (index < words.length && words[index].unionGroup === group) index++;
    const content = words.slice(start, index).map((word, offset) => {
      const cell = state.words[start + offset];
      return <Group key={start + offset} matrix={cell.matrix}>{word.runs.map((_runs, letter) => {
        if (!(word.word.emphasized ? word.letters[letter] : word.rects)[0]) return null;
        const slice = cell.slices[letter], ink = <SliceInk word={word} letter={letter} cell={slice} />;
        const transformed = <Group matrix={slice.matrix}>
          <Group layer={<Paint opacity={slice.glow}>
            {!spicy && !word.emojiMask[letter] && <LinearGradient start={slice.start} end={slice.end} colors={slice.colors} />}
            <Blur blur={slice.radius} mode="decal" />
          </Paint>}>
            {spicy ? <Picture picture={word.pictures[letter]} /> : <SliceClip word={word} letter={letter} clipMode={clipMode}>{ink}</SliceClip>}
          </Group>
          <SliceClip word={word} letter={letter} clipMode={clipMode}>{ink}</SliceClip>
        </Group>;
        return group !== undefined ? <Group key={letter} layer={<Paint blendMode="lighten"><ColorMatrix matrix={encode} /></Paint>}>{transformed}</Group> : <Group key={letter}>{transformed}</Group>;
      })}</Group>;
    });
    nodes.push(group === undefined ? <Group key={start}>{content}</Group> : <Group key={start} layer={<Paint><ColorMatrix matrix={decode} /></Paint>}>
      <Fill color="black" blendMode="src" />{content}
    </Group>);
  }
  return <Group layer={<Paint opacity={state.ready} />}>{nodes}</Group>;
}
/** Static glyph ink plus live transforms, reveal and glow. No per-frame app picture recording. */
export const RelaxedGlyphPicture = memo(function RelaxedGlyphPicture({ words: inputWords, position, active, lineMotion, spicy, background, fontSize, lineEnd, epsilon = false, clipMode = 'group' }: {
  clipMode?: 'mask' | 'group'; words: ShapedGlyphWord[]; position: SharedValue<number>; active: SharedValue<boolean>; lineMotion: SharedValue<ReferenceLineMotion>;
} & RelaxedGlyphOptions) {
  const words = useMemo(() => pictureWords(inputWords), [inputWords]);
  const buffers = useMemo(() => createRelaxedGlyphState(words), [words]);
  const state = useMemo(() => makeMutable(buffers), [buffers]);
  const options = useMemo(() => ({ spicy, background, fontSize, lineEnd, epsilon }), [spicy, background, fontSize, lineEnd, epsilon]);
  const frame = useFrameCallback(useCallback(info => {
    'worklet';
    updateRelaxedGlyphState(state.value, words, position.value, active.value,
      Math.min(0.064, Math.max(0, (info.timeSincePreviousFrame ?? 0) / 1000)), lineMotion.value, options);
  }, [active, lineMotion, options, position, state, words]), false);
  useEffect(() => { frame.setActive(words.length > 0); return () => frame.setActive(false); }, [frame, words]);
  return <RelaxedGlyphGraph words={words} state={buffers} spicy={spicy} clipMode={clipMode} />;
});

