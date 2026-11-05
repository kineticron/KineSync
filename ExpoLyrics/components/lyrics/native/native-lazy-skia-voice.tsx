import { nativeGeometryCache } from './native-geometry-cache';
import { useArrivalVoice, useArrivalShapeAttribution } from '@/lib/lyrics-arrival-context';
import { arrivalEvent, arrivalSpan, arrivalCounter, arrivalNow, arrivalProduced } from '@/lib/lyrics-arrival-trace';
import React, { memo, useContext, useMemo, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { Blur, Canvas, Group, Paint, Paragraph, Skia, TextAlign } from '@shopify/react-native-skia';
import Animated, { Easing, useAnimatedReaction, useAnimatedStyle, useDerivedValue, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { type NativePaintWord, type NativeVoice } from './native-lyrics-model';
import { type ReferenceLineMotion } from './use-reference-line-motion';
import { NativeGlyphPicture, shapeGlyphWords } from './native-glyph-picture';
import { wrapSpicyText } from './spicy-native-layout';
import { NativeLyricsFontContext } from './native-lyrics-fonts';
import { balanceAmllText } from './amll-native-layout';

// Development-only canvas experiment. The baseline NativeSkiaVoice remains the
// default and release implementation, including its original cache/hook graph.
/** Keep exact paragraph heights; prepare glyph slices only on demand. */
export const NativeLazySkiaVoice = memo(function NativeLazySkiaVoice({ voice, position, fontSize, lineHeight, right, background,
  staticLyrics, blur, lineActive, lineMotion, spicy, showTranslation, hasDuet, batched = true, prepareGlyphs = true }: {
  voice: NativeVoice; position: SharedValue<number>; fontSize: number; lineHeight: number;
  right: boolean; hasDuet: boolean; background: boolean; animate: boolean; prepared: boolean; staticLyrics: boolean; blur: SharedValue<number>; lineActive: SharedValue<boolean>; lineMotion: SharedValue<ReferenceLineMotion>; spicy: boolean; playing: boolean; batched?: boolean; showTranslation: boolean; prepareGlyphs?: boolean;
}) {
  const trace = useArrivalVoice();
  if (__DEV__) arrivalCounter(trace.handle, 'voiceRenders');
  const fonts = useContext(NativeLyricsFontContext);
  const voiceWords = voice.words;
  const voicePaintWords = voice.paintWords;
  const voicePaintText = voice.paintText;
  const voiceStart = voice.start;
  const voiceEnd = voice.end;
  const translation = voice.translation;
  const [width, setWidth] = useState(0);
  const shapeRevision = useRef(0);
  // The outer line cancels its .2em margin with padding. Duet songs replace
  // the far-side padding with 15% of the lane; the main line's 1em cancels itself.
  const textWidth = Math.max(1, !spicy && !staticLyrics ? hasDuet ? width * 0.85 - fontSize * 0.2 : width - fontSize * 0.4 : width);
  const opacity = useSharedValue(1);
  useAnimatedReaction(() => !spicy || staticLyrics ? 1 : lineActive.value ? 1 : position.value > voiceEnd ? 0.497 : 0.51,
    (target, previous) => { if (target !== previous) opacity.value = previous === null ? target : withTiming(target,
      { duration: 200, easing: Easing.bezier(0.61, 1, 0.88, 1) }); });
  const presentation = useAnimatedStyle(() => ({ opacity: opacity.value }));
  const exactGlyphs = !__DEV__ || prepareGlyphs || staticLyrics;
  const layout = useMemo(() => {
    if (width <= 0 || !fonts) return null;
    // All consumed inputs are exact; retained paragraphs are never relaid out.
    return nativeGeometryCache.get(fonts, ['main-layout-v1', background, batched, fontSize, lineHeight,
      right, spicy, staticLyrics, textWidth, width, voiceStart, voiceEnd,
      voiceWords, voicePaintText, voicePaintWords], voicePaintText.length + voiceWords.reduce((n, word) => n + word.text.length, 0), () => {
      const layoutStart = __DEV__ ? arrivalNow(trace.handle) : undefined;
      const paragraphStyle = { textAlign: right ? TextAlign.Right : TextAlign.Left,
        strutStyle: { strutEnabled: true, forceStrutHeight: true, halfLeading: true,
          fontFamilies: ['SF Pro Display'], fontSize,
          fontStyle: { weight: background ? spicy ? 500 : 800 : staticLyrics ? 600 : spicy ? 700 : 800 }, heightMultiplier: lineHeight / fontSize },
        textStyle: { fontFamilies: ['SF Pro Display'], fontSize,
          fontStyle: { weight: background ? spicy ? 500 : 800 : staticLyrics ? 600 : spicy ? 700 : 800 }, color: Skia.Color('white'),
          heightMultiplier: lineHeight / fontSize, halfLeading: true, letterSpacing: staticLyrics ? 0.15 : 0 } };
      let text = staticLyrics ? voiceWords.map(w => w.text).join('') : voicePaintText;
      let paintWords = voicePaintWords;
      if (!spicy && !staticLyrics) {
        if (__DEV__) arrivalCounter(trace.handle, 'paragraphBuilds');
        const unwrapped = Skia.ParagraphBuilder.Make(paragraphStyle, fonts).addText(text).build();
        unwrapped.layout(100000);
        const balanced = balanceAmllText(text, paintWords, textWidth, (start, end) =>
          unwrapped.getRectsForRange(start, end).reduce((sum, rect) => sum + rect.width, 0));
        text = balanced.text;
        paintWords = balanced.words;
      }
      const makeParagraph = (inputText: string, inputWords: NativePaintWord[]) => {
        if (__DEV__) arrivalCounter(trace.handle, 'paragraphBuilds');
        const builder = Skia.ParagraphBuilder.Make(paragraphStyle, fonts);
        if (spicy && !staticLyrics && inputWords.some(word => word.gapAfter)) {
          if (__DEV__) arrivalCounter(trace.handle, 'paragraphBuilds');
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
      if (__DEV__) arrivalEvent(trace.handle, trace.generation, 'paragraph-height-layout', layoutStart, arrivalNow(trace.handle), 1);
      const mainPadding = !spicy && background && !staticLyrics ? fontSize * 0.2 : 0;
      return { paragraph, paintWords, height: paragraph.getHeight(), mainPadding };
    });
  }, [background, batched, fonts, fontSize, lineHeight, right, spicy, staticLyrics, textWidth,
    voicePaintText, voicePaintWords, voiceWords, voiceStart, voiceEnd, width]);
  const shaped = useMemo(() => {
    if (!layout) return null;
    ++shapeRevision.current;
    if (!exactGlyphs) return { ...layout, words: [], glyphWords: [] };
    return nativeGeometryCache.get(fonts!, ['main-v1', background, batched, fontSize, lineHeight,
      right, spicy, staticLyrics, textWidth, width, voiceStart, voiceEnd,
      voiceWords, voicePaintText, voicePaintWords], voicePaintText.length + voiceWords.reduce((n, word) => n + word.text.length, 0), () => {
      const { paragraph, paintWords, mainPadding } = layout;
      const rangeStart = __DEV__ ? arrivalNow(trace.handle) : undefined;
      let before = 0;
      const words = paintWords.map(word => {
        const rects = paragraph.getRectsForRange(word.offset, word.offset + (spicy ? word.text.length + Number(!!word.gapAfter) : word.text.trimEnd().length));
        let offset = word.offset;
        // Only emphasized words draw independent letter slices. Range queries
        // cross into SkParagraph; ordinary syllables already have their full rects.
        const letters = word.emphasized ? word.letters.map(letter => { const start = offset; offset += letter.length; return paragraph.getRectsForRange(start, offset); }) : [];
        const wordWidth = rects.reduce((sum, r) => sum + r.width, 0);
        const shapedWord = { word, rects, letters, width: wordWidth, before };
        before += wordWidth;
        return shapedWord;
      });
      if (__DEV__) arrivalEvent(trace.handle, trace.generation, 'word-letter-ranges', rangeStart, arrivalNow(trace.handle), 1);
      const result = { paragraph, height: paragraph.getHeight(), mainPadding, words,
        glyphWords: batched && !staticLyrics ? (__DEV__ ? arrivalSpan(trace.handle, trace.generation, 'glyph-shaping', () => shapeGlyphWords(paragraph, words, spicy)) : shapeGlyphWords(paragraph, words, spicy)) : [] };
      return __DEV__ ? arrivalProduced(trace.handle, trace.generation, result) : result;
    });
  }, [layout, exactGlyphs, background, batched, fonts, fontSize, lineHeight, right, spicy, staticLyrics, textWidth,
    voicePaintText, voicePaintWords, voiceWords, voiceStart, voiceEnd, width]);
  const translationLayout = useMemo(() => {
    if (width <= 0 || !fonts || staticLyrics || !showTranslation || !translation) return null;
    const translationStarted = __DEV__ ? arrivalNow(trace.handle) : undefined;
    const size = spicy ? fontSize * (background ? 12 / (32 * 1.05 * 0.75) : 14 / (32 * 1.05)) : Math.max(10, fontSize * 0.5);
    const leading = spicy ? fontSize * (background ? 16 / (32 * 1.05 * 0.75) : 18 / (32 * 1.05)) : size * 1.5;
    if (__DEV__) arrivalCounter(trace.handle, 'paragraphBuilds');
    const paragraph = Skia.ParagraphBuilder.Make({ textAlign: right ? TextAlign.Right : TextAlign.Left,
      textStyle: { fontFamilies: ['SF Pro Display'], fontSize: size, fontStyle: { weight: spicy ? 500 : 700 },
        heightMultiplier: leading / size, halfLeading: true, color: Skia.Color('rgba(255,255,255,0.3)') } }, fonts)
      .addText(translation).build();
    paragraph.layout(Math.max(1, textWidth - (spicy ? 4 : 0)));
    if (__DEV__) arrivalEvent(trace.handle, trace.generation, 'translation-layout', translationStarted, arrivalNow(trace.handle), 1);
    const result = { paragraph, height: paragraph.getHeight(), margin: spicy ? background ? 2 : 4 : 0 };
    return __DEV__ ? arrivalProduced(trace.handle, trace.generation, result) : result;
  }, [background, fontSize, fonts, right, showTranslation, spicy, staticLyrics, textWidth, translation, width]);
  useArrivalShapeAttribution(trace, shaped, translationLayout);
  // Cold inactive AMLL has no partial reveal: the exact picture shader is
  // uniformly dark before the voice and bright after it. Retained/promoted
  // voices keep the exact painter for release motion and partial reveals.
  // The independent outer Spicy opacity still applies once above.
  const inactiveOpacity = useDerivedValue(() => spicy
    ? position.value > voiceEnd ? background ? 0.6 : 0.85 : background ? 0.3 : 0.5
    : position.value > voiceEnd ? lineMotion.value.bright : lineMotion.value.dark);
  const paintBlur = useDerivedValue(() => spicy ? lineActive.value ? 0 : blur.value / 2 : blur.value);
  const height = shaped ? shaped.height + shaped.mainPadding * 2 + (translationLayout ? translationLayout.margin + translationLayout.height : 0) : lineHeight;
  return <Animated.View style={[{ height }, presentation]} onLayout={event => {
    if (__DEV__) arrivalEvent(trace.handle, trace.generation, 'voice-layout-callback', undefined, undefined, 1);
    const next = event.nativeEvent.layout.width;
    setWidth(previous => Math.abs(previous - next) > 0.1 ? next : previous);
  }}>
    {shaped && <Canvas pointerEvents="none" style={[styles.canvas, { height: height + 128 }]}>
      <Group transform={[{ translateY: staticLyrics ? 64 : spicy ? 63 : 62 }, { translateX: 64 + (right && !spicy && !staticLyrics ? width - textWidth : 0) }]}><Group>
        <Group layer={batched || !spicy ? <Paint><Blur blur={paintBlur} /></Paint> : undefined}>
        <Group transform={[{ translateY: shaped.mainPadding }]}>{!exactGlyphs ? <Group opacity={inactiveOpacity}><Paragraph paragraph={shaped.paragraph} x={0} y={0} width={textWidth} /></Group> : <NativeGlyphPicture {...(__DEV__ ? { arrivalOwner: trace.handle, arrivalGeneration: trace.generation } : undefined)} key={`${voiceStart}:${voiceEnd}:${shapeRevision.current}`} words={shaped.glyphWords} width={textWidth} height={shaped.height}
          position={position} active={lineActive} spicy={spicy} background={background} fontSize={fontSize} lineEnd={voiceEnd} lineMotion={lineMotion} />
        }</Group>
        {translationLayout && <Paragraph paragraph={translationLayout.paragraph} x={spicy ? 2 : 0}
          y={shaped.height + shaped.mainPadding * 2 + translationLayout.margin} width={textWidth - (spicy ? 4 : 0)} />}
        </Group>
      </Group></Group>
    </Canvas>}
  </Animated.View>;
});

const styles = StyleSheet.create({ canvas: { position: 'absolute', left: -64, right: -64, top: -64 } });
