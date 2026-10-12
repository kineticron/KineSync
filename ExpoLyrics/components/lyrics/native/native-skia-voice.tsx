import React, { memo, useContext, useMemo, useState } from 'react';
import { StyleSheet } from 'react-native';
import { Blur, Canvas, Group, LinearGradient, Mask, Paint, Paragraph, Rect, Skia, TextAlign,
  type SkParagraph, type SkRect } from '@shopify/react-native-skia';
import Animated, { Easing, useAnimatedReaction, useAnimatedStyle, useDerivedValue, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { type NativePaintWord, type NativeVoice } from './native-lyrics-model';
import { amllEmphasis, amllFloat, clamp01 } from './reference-motion';
import { useReferenceWordMotion, type WordMotion } from './use-reference-word-motion';
import { type ReferenceLineMotion } from './use-reference-line-motion';
import { NativeGlyphPicture, shapeGlyphWords } from './native-glyph-picture';
import { wrapSpicyText } from './spicy-native-layout';
import { spicyIsRtl } from './spicy-text-policy';
import { amllRevealStart } from './native-glyph-layout';
import { NativeLyricsFontContext } from './native-lyrics-fonts';
import { balanceAmllText } from './amll-native-layout';

type ShapedWord = { word: NativePaintWord; rects: SkRect[]; letters: SkRect[][]; width: number; before: number };
type WordProps = { shaped: ShapedWord; paragraph: SkParagraph; width: number; position: SharedValue<number>;
  fontSize: number; spicy: boolean; background: boolean; enabled: boolean; last: boolean; words: ShapedWord[]; lineMotion: SharedValue<ReferenceLineMotion>;
  lineActive: SharedValue<boolean>; blur: SharedValue<number>; lineEnd: number };

const AnimatedWord = memo(function AnimatedWord({ shaped, paragraph, width, position, fontSize, spicy, background, enabled, last, words, lineMotion, lineActive, blur, lineEnd }: WordProps) {
  const { word, rects, letters } = shaped;
  const motion = useReferenceWordMotion(word, position, enabled && spicy);
  const transform = useDerivedValue(() => spicy
    ? [{ translateY: motion.value.y * (background ? fontSize / 0.75 : fontSize) }, { scale: motion.value.scale }]
    : [{ translateY: amllFloat(position.value, word.start, word.end, background) * fontSize }, { scale: 1 }]);
  const bounds = rects[0];
  if (!bounds) return null;
  return <Group transform={transform} origin={{ x: bounds.x + bounds.width * (word.origin ?? 0.5), y: bounds.y + bounds.height / 2 }}>
    {(word.emphasized ? letters : [rects]).map((slices, index) => <AnimatedGlyph key={index}
      rects={slices} shaped={shaped} paragraph={paragraph} width={width} position={position} fontSize={fontSize}
      spicy={spicy} background={background} motion={motion} letter={word.emphasized ? index : -1} last={last} words={words} lineMotion={lineMotion} lineActive={lineActive} blur={blur} lineEnd={lineEnd} />)}
  </Group>;
});

const AnimatedGlyph = memo(function AnimatedGlyph({ rects, shaped, paragraph, width, position, fontSize, spicy, background, motion, letter, last, words, lineMotion, lineActive, blur, lineEnd }: {
  rects: SkRect[]; shaped: ShapedWord; paragraph: SkParagraph; width: number; position: SharedValue<number>;
  fontSize: number; spicy: boolean; background: boolean; motion: SharedValue<WordMotion>; letter: number; last: boolean; words: ShapedWord[]; lineMotion: SharedValue<ReferenceLineMotion>;
  lineActive: SharedValue<boolean>; blur: SharedValue<number>; lineEnd: number;
}) {
  const { word } = shaped;
  const visual = useDerivedValue(() => {
    if (spicy) {
      const m = letter < 0 ? motion.value : motion.value.letters[letter] ?? motion.value;
      return { scale: letter < 0 ? 1 : m.scale, x: 0, y: letter < 0 ? 0 : m.y * (background ? fontSize / 0.75 : fontSize),
        glow: Math.min(1, Math.max(0, m.glow * (letter < 0 ? 0.35 : 1.85))) * 0.5, radius: 4 + (letter < 0 ? 2 : 12) * m.glow };
    }
    if (letter < 0) return { scale: 1, x: 0, y: 0, glow: 0, radius: 0 };
    const m = amllEmphasis(position.value, word.emphasis?.start ?? word.start, word.emphasis?.end ?? word.end,
      (word.emphasis?.index ?? 0) + letter, word.emphasis?.count ?? word.letters.length, word.emphasis?.last ?? last, background);
    return { ...m, x: m.x * fontSize, y: m.y * fontSize, radius: m.radius * fontSize };
  });
  const transform = useDerivedValue(() => [{ translateX: visual.value.x }, { translateY: visual.value.y }, { scale: visual.value.scale }]);
  const glow = useDerivedValue(() => visual.value.glow);
  const radius = useDerivedValue(() => Math.max(0, visual.value.radius / 2));
  const origin = rects[0] ? { x: rects[0].x + rects[0].width / 2, y: rects[0].y + rects[0].height / 2 } : { x: 0, y: 0 };
  return <Group transform={transform} origin={origin}>{rects.map((rect, index) => <GlyphSlice key={index}
    rect={rect} paragraph={paragraph} width={width} position={position} shaped={shaped} words={words}
    spicy={spicy} background={background} motion={motion} letter={letter} glow={glow} radius={radius} lineMotion={lineMotion} lineActive={lineActive} blur={blur} lineEnd={lineEnd} />)}</Group>;
});

const GlyphSlice = memo(function GlyphSlice({ rect, paragraph, width, position, shaped, words, spicy, background, motion, letter, glow, radius, lineMotion, lineActive, blur, lineEnd }: {
  rect: SkRect; paragraph: SkParagraph; width: number; position: SharedValue<number>; shaped: ShapedWord; words: ShapedWord[];
  spicy: boolean; background: boolean; motion: SharedValue<WordMotion>; letter: number; glow: SharedValue<number>; radius: SharedValue<number>; lineMotion: SharedValue<ReferenceLineMotion>;
  lineActive: SharedValue<boolean>; blur: SharedValue<number>; lineEnd: number;
}) {
  const rtl = spicyIsRtl(shaped.word.text);
  const start = useDerivedValue(() => {
    if (spicy) {
      const m = letter < 0 ? motion.value : motion.value.letters[letter] ?? motion.value;
      const local = rect.width * m.gradient;
      return { x: rtl ? rect.x + rect.width - local : rect.x + local, y: rect.y };
    }
    const fade = rect.height * 0.56;
    let advanced = 0;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const progress = clamp01((position.value - w.word.start) / Math.max(1, w.word.end - w.word.start));
      advanced += progress * (w.width + (i === 0 ? fade * 1.5 : 0) + (i === words.length - 1 ? fade * 0.5 : 0));
    }
    return { x: amllRevealStart(rect, shaped.rects, advanced, shaped.before, fade), y: rect.y };
  });
  const end = useDerivedValue(() => ({ x: start.value.x + (rtl ? -1 : 1) * (spicy ? rect.width * 0.2 : rect.height * 0.56), y: rect.y }));
  const colors = useDerivedValue(() => spicy ? background ? ['rgba(255,255,255,0.6)', 'rgba(255,255,255,0.3)']
    : ['rgba(255,255,255,0.85)', 'rgba(255,255,255,0.5)']
    : [`rgba(255,255,255,${lineMotion.value.bright})`, `rgba(255,255,255,${lineMotion.value.dark})`]);
  const shadowOpacity = useDerivedValue(() => position.value > lineEnd ? background ? 0.6 : 0.85 : background ? 0.3 : 0.5);
  const inactiveShadow = useDerivedValue(() => spicy && !lineActive.value ? shadowOpacity.value : 0);
  const activeGlow = useDerivedValue(() => spicy && !lineActive.value ? 0 : glow.value);
  const activeColors = useDerivedValue(() => spicy && !lineActive.value ? ['transparent', 'transparent'] : colors.value);
  const shadowBlur = useDerivedValue(() => blur.value / 2);
  return <><Mask mask={<Rect x={rect.x - 32} y={rect.y - 32} width={rect.width + 64} height={rect.height + 64} color="white" opacity={inactiveShadow} />}>
    <Group layer={<Paint><Blur blur={shadowBlur} /></Paint>}><Group clip={rect}><Paragraph paragraph={paragraph} x={0} y={0} width={width} /></Group></Group>
  </Mask>
    <Mask mask={<Rect x={rect.x - 32} y={rect.y - 32} width={rect.width + 64} height={rect.height + 64} color="white" opacity={activeGlow} />}>
      <Group layer={<Paint><Blur blur={radius} /></Paint>}>
        <Group clip={rect}><Paragraph paragraph={paragraph} x={0} y={0} width={width} /></Group>
      </Group>
    </Mask>
    <Mask mask={<Rect rect={rect}><LinearGradient colors={activeColors} start={start} end={end} /></Rect>}><Paragraph paragraph={paragraph} x={0} y={0} width={width} /></Mask>
  </>;
});

/** Shape the full voice once; animate the reference's timed syllables and graphemes on the UI thread. */
export const NativeSkiaVoice = memo(function NativeSkiaVoice({ voice, position, fontSize, lineHeight, right, background,
  staticLyrics, blur, lineActive, lineMotion, spicy, showTranslation, hasDuet, batched = true }: {
  voice: NativeVoice; position: SharedValue<number>; fontSize: number; lineHeight: number;
  right: boolean; hasDuet: boolean; background: boolean; animate: boolean; prepared: boolean; staticLyrics: boolean; blur: SharedValue<number>; lineActive: SharedValue<boolean>; lineMotion: SharedValue<ReferenceLineMotion>; spicy: boolean; playing: boolean; batched?: boolean; showTranslation: boolean;
}) {
  const fonts = useContext(NativeLyricsFontContext);
  const [width, setWidth] = useState(0);
  // The outer line cancels its .2em margin with padding. Duet songs replace
  // the far-side padding with 15% of the lane; the main line's 1em cancels itself.
  const textWidth = Math.max(1, !spicy && !staticLyrics ? hasDuet ? width * 0.85 - fontSize * 0.2 : width - fontSize * 0.4 : width);
  const opacity = useSharedValue(1);
  useAnimatedReaction(() => !spicy || staticLyrics ? 1 : lineActive.value ? 1 : position.value > voice.end ? 0.497 : 0.51,
    (target, previous) => { if (target !== previous) opacity.value = previous === null ? target : withTiming(target,
      { duration: 200, easing: Easing.bezier(0.61, 1, 0.88, 1) }); });
  const presentation = useAnimatedStyle(() => ({ opacity: opacity.value }));
  const shaped = useMemo(() => {
    if (width <= 0 || !fonts) return null;
    const paragraphStyle = { textAlign: right ? TextAlign.Right : TextAlign.Left,
      strutStyle: { strutEnabled: true, forceStrutHeight: true, halfLeading: true,
        fontFamilies: ['SF Pro Display'], fontSize,
        fontStyle: { weight: background ? spicy ? 500 : 800 : staticLyrics ? 600 : spicy ? 700 : 800 }, heightMultiplier: lineHeight / fontSize },
      textStyle: { fontFamilies: ['SF Pro Display'], fontSize,
        fontStyle: { weight: background ? spicy ? 500 : 800 : staticLyrics ? 600 : spicy ? 700 : 800 }, color: Skia.Color('white'),
        heightMultiplier: lineHeight / fontSize, halfLeading: true, letterSpacing: staticLyrics ? 0.15 : 0 } };
    let text = staticLyrics ? voice.words.map(w => w.text).join('') : voice.paintText;
    let paintWords = voice.paintWords;
    if (!spicy && !staticLyrics) {
      const unwrapped = Skia.ParagraphBuilder.Make(paragraphStyle, fonts).addText(text).build();
      unwrapped.layout(100000);
      const balanced = balanceAmllText(text, paintWords, textWidth, (start, end) =>
        unwrapped.getRectsForRange(start, end).reduce((sum, rect) => sum + rect.width, 0));
      text = balanced.text;
      paintWords = balanced.words;
    }
    const makeParagraph = (inputText: string, inputWords: NativePaintWord[]) => {
      const builder = Skia.ParagraphBuilder.Make(paragraphStyle, fonts);
      if (spicy && !staticLyrics && inputWords.some(word => word.gapAfter)) {
        const probe = Skia.ParagraphBuilder.Make(paragraphStyle, fonts).addText('0 ').build();
        probe.layout(1000);
        const ch = probe.getRectsForRange(0, 1).reduce((sum, rect) => sum + rect.width, 0);
        const space = probe.getRectsForRange(1, 2).reduce((sum, rect) => sum + rect.width, 0);
        let cursor = 0;
        for (const word of inputWords) if (word.gapAfter) {
          const gap = word.offset + word.text.length;
          builder.addText(inputText.slice(cursor, gap));
          builder.pushStyle({ ...paragraphStyle.textStyle, letterSpacing: ch * 0.32 - space }).addText(' ').pop();
          cursor = gap + 1;
        }
        builder.addText(inputText.slice(cursor));
      } else builder.addText(inputText);
      return builder.build();
    };
    if (spicy && !staticLyrics) {
      const unwrapped = makeParagraph(text, paintWords);
      unwrapped.layout(100000);
      const wrapped = wrapSpicyText(text, paintWords, textWidth, (start, end) =>
        unwrapped.getRectsForRange(start, end).reduce((sum, rect) => sum + rect.width, 0));
      text = wrapped.text;
      paintWords = wrapped.words;
    }
    const paragraph = makeParagraph(text, paintWords);
    paragraph.layout(textWidth);
    let before = 0;
    const words = paintWords.map(word => {
      const rects = paragraph.getRectsForRange(word.offset, word.offset + (spicy ? word.text.length + Number(!!word.gapAfter) : word.text.trimEnd().length));
      let offset = word.offset;
      const letters = word.letters.map(letter => { const start = offset; offset += letter.length; return paragraph.getRectsForRange(start, offset); });
      const wordWidth = rects.reduce((sum, r) => sum + r.width, 0);
      const shapedWord = { word, rects, letters, width: wordWidth, before };
      before += wordWidth;
      return shapedWord;
    });
    let translation: SkParagraph | null = null;
    const translationMargin = spicy ? background ? 2 : 4 : 0;
    if (showTranslation && !staticLyrics && voice.translation) {
      const size = spicy ? fontSize * (background ? 12 / (32 * 1.05 * 0.75) : 14 / (32 * 1.05)) : Math.max(10, fontSize * 0.5);
      const leading = spicy ? fontSize * (background ? 16 / (32 * 1.05 * 0.75) : 18 / (32 * 1.05)) : size * 1.5;
      translation = Skia.ParagraphBuilder.Make({ textAlign: right ? TextAlign.Right : TextAlign.Left,
        textStyle: { fontFamilies: paragraphStyle.textStyle.fontFamilies, fontSize: size, fontStyle: { weight: spicy ? 500 : 700 },
          heightMultiplier: leading / size, halfLeading: true, color: Skia.Color('rgba(255,255,255,0.3)') } }, fonts).addText(voice.translation).build();
      translation.layout(Math.max(1, textWidth - (spicy ? 4 : 0)));
    }
    const mainPadding = !spicy && background && !staticLyrics ? fontSize * 0.2 : 0;
    return { paragraph, height: paragraph.getHeight(), translation, translationMargin, mainPadding,
      totalHeight: paragraph.getHeight() + mainPadding * 2 + (translation ? translationMargin + translation.getHeight() : 0), words, glyphWords: batched && !staticLyrics ? shapeGlyphWords(paragraph, words, spicy) : [] };
  }, [background, batched, fonts, fontSize, lineHeight, right, showTranslation, spicy, staticLyrics, textWidth, voice, width]);
  const inactiveOpacity = useDerivedValue(() => staticLyrics ? background ? 0.78 : 1
    : spicy ? position.value > voice.end ? 0.497 : 0.51 : lineMotion.value.dark);
  const paintBlur = useDerivedValue(() => spicy ? lineActive.value ? 0 : blur.value / 2 : blur.value);
  const height = shaped?.totalHeight ?? lineHeight;
  return <Animated.View style={[{ height }, presentation]} onLayout={event => {
    const next = event.nativeEvent.layout.width;
    setWidth(previous => Math.abs(previous - next) > 0.1 ? next : previous);
  }}>
    {shaped && <Canvas pointerEvents="none" style={[styles.canvas, { height: height + 128 }]}>
      <Group transform={[{ translateY: staticLyrics ? 64 : spicy ? 63 : 62 }, { translateX: 64 + (right && !spicy && !staticLyrics ? width - textWidth : 0) }]}><Group>
        <Group layer={batched || !spicy ? <Paint><Blur blur={paintBlur} /></Paint> : undefined}>
        <Group transform={[{ translateY: shaped.mainPadding }]}>{batched && !staticLyrics ? <NativeGlyphPicture key={`${voice.start}:${voice.end}:${voice.paintText}:${textWidth}:${shaped.height}:${fontSize}`} words={shaped.glyphWords} width={textWidth} height={shaped.height}
          position={position} active={lineActive} spicy={spicy} background={background} fontSize={fontSize} lineEnd={voice.end} lineMotion={lineMotion} />
          : !staticLyrics ? shaped.words.map((word, index) => <AnimatedWord key={index} shaped={word}
          paragraph={shaped.paragraph} width={textWidth} position={position} fontSize={fontSize} spicy={spicy} background={background}
          enabled={true} last={index === shaped.words.length - 1} words={shaped.words} lineMotion={lineMotion} lineActive={lineActive} blur={blur} lineEnd={voice.end} />)
          : <Mask mask={<Rect x={-32} y={-32} width={width + 64} height={height + 64} color="white" opacity={inactiveOpacity} />}>
                <Group layer={<Paint><Blur blur={blur} /></Paint>}>
                    <Paragraph paragraph={shaped.paragraph} x={0} y={0} width={textWidth} />
                </Group>
            </Mask>}</Group>
        {shaped.translation && <Paragraph paragraph={shaped.translation} x={spicy ? 2 : 0} y={shaped.height + shaped.mainPadding * 2 + shaped.translationMargin} width={textWidth - (spicy ? 4 : 0)} />}
        </Group>
      </Group></Group>
    </Canvas>}
  </Animated.View>;
});

const styles = StyleSheet.create({ canvas: { position: 'absolute', left: -64, right: -64, top: -64 } });
