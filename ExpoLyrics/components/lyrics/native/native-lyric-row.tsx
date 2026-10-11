import React, { memo, useMemo } from 'react';
import { StyleSheet, Text, View, type TextStyle } from 'react-native';
import { Pressable } from 'react-native-gesture-handler';
import MaskedView from '@react-native-masked-view/masked-view';
import { LinearGradient } from 'expo-linear-gradient';
import { useMappingHelper, useRecyclingState } from '@shopify/flash-list';
import Animated, { Easing, useAnimatedReaction, useAnimatedStyle, useDerivedValue, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import type { PlaybackWindowState } from '@/lib/lyrics-layout';
import { nativeWordProgress, type NativeLyricRow, type NativeLyricsStyle, type NativeVoice, type NativeWord } from './native-lyrics-model';
import { useReferenceLineMotion } from './use-reference-line-motion';
import { AmllBackground } from './amll-background';
import { NativeSkiaVoice } from './native-skia-voice';
import { useReferenceRowScroll, type ReferenceScroll } from './reference-scroll';

export type NativeReveal = 'clip' | 'mask' | 'canvas' | 'tree';
const gradientColors = ['#fff', '#fff', '#ffffff00'] as const;
const gradientStart = { x: 0, y: 0 };
const gradientEnd = { x: 1, y: 0 };

const PauseDot = memo(function PauseDot({ index, position, start, duration }: { index: number; position: SharedValue<number>; start: number; duration: number }) {
  const animation = useAnimatedStyle(() => {
    const progress = Math.max(0, Math.min(1, (position.value - start) / Math.max(1, duration)));
    return { opacity: 0.25 + 0.75 * Math.max(0, Math.min(1, progress * 3 - index)),
      transform: [{ scale: 1 + 0.12 * Math.sin(progress * Math.PI) }] };
  });
  return <Animated.View style={[styles.dot, animation]} />;
});

const PauseDots = memo(function PauseDots({ position, start, duration }: { position: SharedValue<number>; start: number; duration: number }) {
  return <View accessibilityLabel="Instrumental break" style={styles.dots}>{[0, 1, 2].map(index =>
    <PauseDot key={index} index={index} position={position} start={start} duration={duration} />)}</View>;
});

const NativeWordView = memo(function NativeWordView({ word, position, textStyle, reveal, spicy }: {
  word: NativeWord; position: SharedValue<number>; textStyle: TextStyle; reveal: NativeReveal; spicy: boolean;
}) {
  const [width, setWidth] = useRecyclingState(0, [word.text, textStyle.fontSize]);
  const { starts, ends, weights } = word;
  const rtl = /[\u0590-\u08ff]/u.test(word.text);
  const progress = useDerivedValue(() => nativeWordProgress(position.value, starts, ends, weights));
  const clip = useAnimatedStyle(() => ({ transform: [{ translateX: (rtl ? 1 : -1) * (1 - progress.value) * width }] }));
  const counter = useAnimatedStyle(() => ({ transform: [{ translateX: (rtl ? -1 : 1) * (1 - progress.value) * width }] }));
  const lift = useAnimatedStyle(() => {
    const p = progress.value;
    const pulse = Math.sin(p * Math.PI);
    return { transform: [{ translateY: -pulse * (spicy ? 3 : 2) }, { scale: 1 + pulse * (spicy ? 0.035 : 0.02) }] };
  });
  return <Animated.View style={[styles.word, lift]} onLayout={event => {
    const next = event.nativeEvent.layout.width;
    setWidth(previous => Math.abs(previous - next) > 0.1 ? next : previous);
  }}>
    <Text allowFontScaling={false} style={[textStyle, styles.unsung]}>{word.text}</Text>
    {width > 0 && (reveal === 'mask'
      ? <MaskedView pointerEvents="none" style={StyleSheet.absoluteFill} androidRenderingMode="software"
          maskElement={<Animated.View style={[styles.fill, clip]}><LinearGradient colors={gradientColors} start={gradientStart} end={gradientEnd} style={styles.fill} /></Animated.View>}>
          <Text allowFontScaling={false} style={textStyle}>{word.text}</Text>
        </MaskedView>
      : <Animated.View pointerEvents="none" style={[styles.fill, styles.clip, clip]}>
          <Animated.View style={counter}><Text allowFontScaling={false} style={textStyle}>{word.text}</Text></Animated.View>
        </Animated.View>)}
  </Animated.View>;
});

const NativeVoiceView = memo(function NativeVoiceView({ voice, position, fontSize, lineHeight, background, right, animate, showTranslation, reveal, spicy, staticLyrics, blur, playing, prepared, rowActive, blurValue, hasDuet }: {
  voice: NativeVoice; hasDuet: boolean; position: SharedValue<number>; fontSize: number; lineHeight: number; background: boolean;
  right: boolean; animate: boolean; showTranslation: boolean; reveal: NativeReveal; spicy: boolean; staticLyrics: boolean;
  blur: number; playing: boolean; prepared: boolean; rowActive: SharedValue<boolean>; blurValue: SharedValue<number>;
}) {
  const { getMappingKey } = useMappingHelper();
  const lineMotion = useReferenceLineMotion(rowActive, !spicy && !staticLyrics, background, !spicy && playing);
  const voiceStyle = useAnimatedStyle(() => ({ transform: [{ scale: spicy || staticLyrics ? 1 : lineMotion.value.scale }], transformOrigin: right ? 'right center' : 'left center' }));
  const textStyle = useMemo<TextStyle>(() => ({ color: '#fff', fontSize, lineHeight,
    fontWeight: background ? '500' : staticLyrics ? '600' : '800', includeFontPadding: false,
    letterSpacing: staticLyrics ? 0.15 : 0, textAlign: right ? 'right' : 'left',
    ...(staticLyrics && background ? { color: 'rgba(255,255,255,0.78)' } : {}) }), [background, fontSize, lineHeight, right, staticLyrics]);
  const text = useMemo(() => voice.words.map(word => word.text).join(''), [voice.words]);
  return <Animated.View style={[background && (staticLyrics ? styles.staticBackground : spicy ? styles.background : undefined), voiceStyle]}>
    {(reveal === 'canvas' || reveal === 'tree')
      ? <NativeSkiaVoice hasDuet={hasDuet} voice={voice} position={position} fontSize={fontSize} lineHeight={lineHeight} right={right}
          showTranslation={showTranslation} batched={reveal !== 'tree'} background={background} animate={animate} prepared={prepared} staticLyrics={staticLyrics} blur={blurValue} lineActive={rowActive} lineMotion={lineMotion} spicy={spicy} playing={playing} />
      : animate && !staticLyrics
      ? <View style={[styles.words, right && styles.rightWords]}>{voice.words.map((word, index) =>
          <NativeWordView key={getMappingKey(index, index)} word={word} position={position} textStyle={textStyle} reveal={reveal} spicy={spicy} />)}</View>
      : <Text allowFontScaling={false} style={[textStyle, !staticLyrics && styles.unsung]}>{text}</Text>}
    {showTranslation && !!voice.translation && (staticLyrics || reveal !== 'canvas' && reveal !== 'tree') && <Text allowFontScaling={false} style={[
      styles.translation, { fontSize: fontSize * (staticLyrics ? background ? 15 / 18 : 18 / 26 : spicy ? background ? 12 / (32 * 1.05 * 0.75) : 14 / (32 * 1.05) : 0.5),
        lineHeight: fontSize * (staticLyrics ? background ? 21 / 18 : 25.92 / 26 : spicy ? background ? 16 / (32 * 1.05 * 0.75) : 18 / (32 * 1.05) : 0.75),
        marginTop: staticLyrics ? background ? 2 : 6 : 4, textAlign: right ? 'right' : 'left',
        ...(!staticLyrics && !spicy ? { color: 'rgba(255,255,255,0.3)', fontWeight: '700' as const, marginTop: 0, marginLeft: right ? fontSize * 2 : 0, marginRight: right ? 0 : fontSize * 2 } : {}),
        ...(staticLyrics ? { color: background ? 'rgba(255,255,255,0.58)' : 'rgba(255,255,255,0.68)', letterSpacing: 0.1 } : {}) },
    ]}>{voice.translation}</Text>}
  </Animated.View>;
});

export const NativeLyricRowView = memo(function NativeLyricRowView({ row, position, style, fontScale, landscape, preview, active, selected, staticLyrics, showTranslation, reveal, tapToSeek, onPress, onLongPress, pause, distance, playing, viewportWidth, referenceScroll, presentationWindow, hasDuet }: {
  row: NativeLyricRow; hasDuet: boolean; position: SharedValue<number>; style: NativeLyricsStyle; fontScale: number; landscape: boolean;
  preview: boolean; active: boolean; selected: boolean; staticLyrics: boolean; showTranslation: boolean; reveal: NativeReveal;
  tapToSeek: boolean; onPress?: (row: NativeLyricRow) => void; onLongPress?: (row: NativeLyricRow) => void;
  pause?: { start: number; duration: number; before: boolean };
  distance: number; playing: boolean; viewportWidth: number; referenceScroll: ReferenceScroll; presentationWindow: SharedValue<PlaybackWindowState>;
}) {
  const { getMappingKey } = useMappingHelper();
  const spicy = style === 'spicy';
  const scrollStyle = useReferenceRowScroll(referenceScroll, row.index, !staticLyrics);
  const rowActive = useDerivedValue(() => row.index >= presentationWindow.value.visualActiveLineStartIndex && row.index <= presentationWindow.value.visualActiveLineEndIndex);
  const blurValue = useDerivedValue(() => {
    const focus = Math.max(0, presentationWindow.value.focusLineIndex);
    const distance = Math.abs(row.index - focus);
    const target = staticLyrics || rowActive.value ? 0 : spicy ? Math.min(6.83125, distance * 1.25) : Math.min(5, (distance + (row.index < focus ? 2 : 1)) * 0.8);
    return spicy ? target : withTiming(target, { duration: 400, easing: Easing.bezier(0.25, 0.1, 0.25, 1) });
  });
  const opacity = useSharedValue(!spicy && active && !staticLyrics ? 0.85 : 1);
  useAnimatedReaction(() => !spicy && rowActive.value && !staticLyrics ? 0.85 : 1, (target, previous) => {
    if (target !== previous) opacity.value = withTiming(target, { duration: 400, easing: Easing.bezier(0.25, 0.1, 0.25, 1) });
  });
  const presentation = useAnimatedStyle(() => ({ opacity: opacity.value }));
  const fontSize = (staticLyrics || preview ? 26 : spicy || landscape ? 32 : 36) * fontScale * (!staticLyrics && spicy && (reveal === 'canvas' || reveal === 'tree') ? 1.05 : 1);
  const lineHeight = staticLyrics ? fontSize * 1.46 : (preview ? 36 : spicy ? (reveal === 'canvas' || reveal === 'tree') ? 42 * 1.05 : 42 : fontSize / fontScale * 1.2) * fontScale;
  const blur = staticLyrics || active ? 0 : spicy ? Math.min(6.83125, distance * 1.25) : Math.min(5, (distance + 1) * 0.8);
  const right = staticLyrics ? landscape : !spicy && landscape ? !row.line.oppositeAligned : Boolean(row.line.oppositeAligned);
  const backgroundViews = row.backgrounds.map((voice, index) => <NativeVoiceView hasDuet={hasDuet} key={getMappingKey(index, index)} voice={voice} position={position}
        fontSize={staticLyrics ? 18 * fontScale : fontSize * (spicy ? 0.75 : 0.7)} lineHeight={staticLyrics ? 25.2 * fontScale : lineHeight * (spicy ? 0.62 : 0.7)} background right={right} animate={active}
        prepared={distance <= 1} showTranslation={showTranslation} reveal={reveal} spicy={spicy} staticLyrics={staticLyrics} blur={blur} rowActive={rowActive} blurValue={blurValue} playing={playing} />);
  return <Animated.View style={[scrollStyle, presentation]}><Pressable accessibilityRole={tapToSeek ? 'button' : 'text'} accessibilityLabel={row.lead.words.map(word => word.text).join('')}
    accessibilityState={{ selected }} delayLongPress={540}
    onPress={() => { if (tapToSeek) onPress?.(row); }} onLongPress={() => onLongPress?.(row)}
    style={[styles.row, { minHeight: staticLyrics ? 0 : (spicy ? 84 : 72) * fontScale,
      paddingVertical: !staticLyrics ? spicy ? 12 : fontSize * 0.4 : 10,
      paddingHorizontal: staticLyrics ? 28 : spicy ? landscape ? 14 : 28 : (landscape ? 28 : 22) + (viewportWidth <= 500 ? 20 : fontSize) }, staticLyrics && styles.staticRow, selected && styles.selected]}>
    <View style={[styles.lane, { width: staticLyrics || !spicy && (reveal === 'canvas' || reveal === 'tree') ? '100%' : landscape ? '90%' : '88%' }, staticLyrics && styles.staticLane, right && styles.rightLane]}>
      {pause?.before && <PauseDots position={position} start={pause.start} duration={pause.duration} />}
      <NativeVoiceView hasDuet={hasDuet} voice={row.lead} position={position} fontSize={fontSize} lineHeight={lineHeight} background={false}
        right={right} animate={active} prepared={distance <= 1} showTranslation={showTranslation} reveal={reveal} spicy={spicy} staticLyrics={staticLyrics} blur={blur} rowActive={rowActive} blurValue={blurValue} playing={playing} />
      {!!row.backgrounds.length && (!spicy && !staticLyrics
        ? <AmllBackground active={rowActive} playing={playing} fontSize={fontSize} referenceScroll={referenceScroll} index={row.index} right={right}>{backgroundViews}</AmllBackground>
        : backgroundViews)}
      {pause && !pause.before && <PauseDots position={position} start={pause.start} duration={pause.duration} />}
    </View>
  </Pressable></Animated.View>;
});

const styles = StyleSheet.create({
  row: { paddingVertical: 10, justifyContent: 'center', borderRadius: 8 },
  lane: { alignSelf: 'flex-start' }, rightLane: { alignSelf: 'flex-end' },
  words: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline' }, rightWords: { justifyContent: 'flex-end' },
  word: { maxWidth: '100%', overflow: 'hidden' },
  fill: { ...StyleSheet.absoluteFill }, clip: { overflow: 'hidden' },
  unsung: { color: 'rgba(255,255,255,0.35)' },
  background: { marginTop: 3 }, translation: { color: 'rgba(255,255,255,0.65)', marginTop: 4, fontWeight: '500', includeFontPadding: false },
  staticRow: { paddingTop: 0, paddingBottom: 14 }, staticLane: { maxWidth: 300 }, staticBackground: { marginTop: 5 },
  selected: { backgroundColor: 'rgba(255,255,255,0.13)' },
  dots: { height: 16, marginTop: 15, marginBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#fff' },
});
