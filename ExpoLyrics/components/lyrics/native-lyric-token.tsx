import MaskedView from "@react-native-masked-view/masked-view";
import { LinearGradient } from "expo-linear-gradient";
import { memo, useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, View, type TextStyle } from "react-native";
import Animated, { cancelAnimation, Easing, runOnUI, useAnimatedStyle,
  useFrameCallback, useSharedValue, withTiming, type SharedValue } from "react-native-reanimated";

import { AMLL_WORD_FADE_WIDTH, amlEmphasis, amlEmphasisParameters, amlFloat, amlTokenMaskOffset, clampAml } from "@/lib/amll-native";
import { getGraphemes } from "@/lib/graphemes";
import type { LyricSyllable } from "@/types/bridge";

export type NativeEmphasis = {
  start: number;
  count: number;
  index: number;
  params: ReturnType<typeof amlEmphasisParameters>;
};

export function nativeAnimationCharacters(text: string) {
  // Keep cursive/Indic shaping and bidi runs intact. A continuous pixel mask
  // still sweeps these runs; detaching their letters would change the font.
  return /[\u0590-\u08ff\u0900-\u0dff]/u.test(text) ? [text] : getGraphemes(text);
}

export function syncNativeTimeline(clock: SharedValue<number>, position: number, end: number, playing: boolean) {
  cancelAnimation(clock);
  runOnUI((next: number, finish: number, animate: boolean) => {
    "worklet";
    if (!animate || Math.abs(clock.value - next) > 250) clock.value = next;
    if (animate && next < finish) clock.value = withTiming(finish, { duration: finish - next, easing: Easing.linear });
  })(position, end, playing);
  return () => cancelAnimation(clock);
}

export function useNativeLyricTimeline(words: LyricSyllable[], position: number, playing: boolean,
  enabled: boolean, highlighted: boolean, scale: SharedValue<number>, fontSize: number, lineHeight: number) {
  const clock = useSharedValue(position);
  // Do not sample a shared value during React render. Highlight state already
  // determines the same cold-start alpha target and avoids strict-mode warning
  // spam for every mounted token row while scrolling.
  const initialFactor = highlighted ? 1 : 0;
  const alpha = useSharedValue({ dark: 0.2 + initialFactor * 0.2,
    bright: 0.2 + initialFactor * (highlighted ? 0.8 : 0.2) });
  const fade = lineHeight * AMLL_WORD_FADE_WIDTH;
  const end = useMemo(() => Math.max(0, ...words.map(w => w.endTime + Math.max(1000, w.endTime - w.startTime) * 2)), [words]);
  useEffect(() => {
    if (!enabled) {
      cancelAnimation(clock);
      return;
    }
    // syncNativeTimeline already cancels/replaces the current animation. Do not
    // also return its cancellation as an update cleanup: React would cancel the
    // same clock once for cleanup and again for the next sync on every anchor
    // correction. Unmount cleanup is handled by the dedicated effect below.
    syncNativeTimeline(clock, position, end, playing);
  }, [clock, enabled, end, playing, position]);
  useEffect(() => () => cancelAnimation(clock), [clock]);

  // Port 0.5.2's asymmetric exponential alpha filter, driven by the actual
  // spring scale. Time-based integration stays identical at 60 and 120 Hz.
  const alphaFrame = useFrameCallback(frame => {
    "worklet";
    const factor = clampAml((scale.value - 0.97) / 0.03);
    const dark = 0.2 + factor * 0.2;
    const bright = highlighted ? 0.2 + factor * 0.8 : dark;
    const dt = (frame.timeSincePreviousFrame ?? 16) / 1000;
    const current = alpha.value;
    const darkDelta = dark - current.dark;
    const brightDelta = bright - current.bright;
    alpha.value = {
      dark: Math.abs(darkDelta) < 0.001 ? dark : current.dark + darkDelta * (1 - Math.exp(-(darkDelta > 0 ? 50 : 7) * dt)),
      bright: Math.abs(brightDelta) < 0.001 ? bright : current.bright + brightDelta * (1 - Math.exp(-(brightDelta > 0 ? 50 : 7) * dt)),
    };
  }, false);
  useEffect(() => {
    if (!enabled) { alphaFrame.setActive(false); return; }
    alphaFrame.setActive(true);
    const timer = setTimeout(() => alphaFrame.setActive(false), 2400);
    return () => { clearTimeout(timer); alphaFrame.setActive(false); };
  }, [alphaFrame, enabled, highlighted, playing]);
  // Stable identity: fresh object literals here would defeat the token memo
  // on every parent render, re-rendering every syllable for unrelated updates.
  return useMemo(() => ({ clock, alpha, fade }), [alpha, clock, fade]);
}

type Timeline = ReturnType<typeof useNativeLyricTimeline>;

const EmphasisCharacter = memo(function EmphasisCharacter({ text, index, emphasis, timeline, fontSize, background, textStyle }: {
  text: string; index: number; emphasis: NativeEmphasis; timeline: Timeline; fontSize: number;
  background: boolean; textStyle: TextStyle;
}) {
  const motion = useAnimatedStyle(() => {
    const value = amlEmphasis(timeline.clock.value, emphasis.start, emphasis.index + index,
      emphasis.count, emphasis.params, fontSize, background);
    // Clamp and fix the precision: near-zero glow formats with an exponent
    // (e.g. 5.4e-7), which Reanimated's color parser rejects as invalid.
    const glowAlpha = Math.min(1, Math.max(0, value.shadowOpacity)).toFixed(4);
    return { transform: [{ translateX: value.x }, { translateY: value.y }, { scale: value.scale }],
      textShadowColor: `rgba(255,255,255,${glowAlpha})`,
      textShadowOffset: { width: 0, height: 0 }, textShadowRadius: value.shadowRadius };
  });
  return <Animated.Text style={[textStyle, { padding: fontSize, margin: -fontSize }, motion]}>{text}</Animated.Text>;
});

export const NativeLyricToken = memo(function NativeLyricToken({ text, word, timeline,
  fontSize, lineHeight, background = false, emphasis }: {
  text: string; word: LyricSyllable; timeline: Timeline; fontSize: number; lineHeight: number;
  background?: boolean; emphasis?: NativeEmphasis;
}) {
  const measurementKey = `${background ? 1 : 0}:${fontSize}:${text}`;
  const [measurement, setMeasurement] = useState(() => ({ key: measurementKey, width: 0 }));
  // FlashList may reuse the React subtree for another lyric row before its new
  // onLayout event arrives. Never paint the new syllable with the old token's
  // width during that intervening render.
  const width = measurement.key === measurementKey ? measurement.width : 0;
  const padding = fontSize;
  const boxWidth = width + padding * 2;
  const gradientWidth = boxWidth * 2 + timeline.fade;
  const characters = useMemo(() => nativeAnimationCharacters(text), [text]);
  const textStyle: TextStyle = useMemo(
    () => ({
      fontSize,
      lineHeight,
      fontWeight: (background ? "500" : "700") as TextStyle["fontWeight"],
      letterSpacing: 0.1,
      color: "white",
    }),
    [background, fontSize, lineHeight],
  );
  const floatStyle = useAnimatedStyle(() => ({ transform: [{ translateY:
    amlFloat(timeline.clock.value, word.startTime, word.endTime, fontSize, background) }] }));
  const baseMask = useAnimatedStyle(() => ({ opacity: timeline.alpha.value.dark }));
  const movingMask = useAnimatedStyle(() => {
    const { bright, dark } = timeline.alpha.value;
    const offset = amlTokenMaskOffset(
      timeline.clock.value,
      word.startTime,
      word.endTime,
      width,
      padding,
      timeline.fade,
    );
    return {
      // Keep the moving highlight dark until this token has its own geometry.
      // Once measured, the current playback time is applied immediately, so no
      // sibling layout ordering can make several syllables reveal together.
      opacity: width > 0 ? (bright - dark) / Math.max(0.001, 1 - dark) : 0,
      transform: [{ translateX: offset }],
    };
  });
  const measure = (event: { nativeEvent: { layout: { width: number } } }) => {
    const measured = event.nativeEvent.layout.width;
    if (!Number.isFinite(measured) || measured < 0) {
      return;
    }
    if (measurement.key !== measurementKey || Math.abs(measured - width) > 0.01) {
      setMeasurement({ key: measurementKey, width: measured });
    }
  };
  return <Animated.View style={floatStyle}>
    <MaskedView androidRenderingMode="software" style={{ margin: -padding }}
      maskElement={<View style={StyleSheet.absoluteFill}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.white, baseMask]} />
        <Animated.View style={[styles.gradient, { width: gradientWidth }, movingMask]}>
          <LinearGradient colors={["white", "white", "rgba(255,255,255,0)", "rgba(255,255,255,0)"]}
            locations={[0, boxWidth / gradientWidth, (boxWidth + timeline.fade) / gradientWidth, 1]}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
        </Animated.View>
      </View>}>
      <View style={{ padding, opacity: background ? 0.4 : 1 }}>
        {emphasis ? <View onLayout={measure} style={styles.characters}>
          {characters.map((character, charIndex) => <EmphasisCharacter key={charIndex} text={character} index={charIndex}
            emphasis={emphasis} timeline={timeline} fontSize={fontSize} background={background} textStyle={textStyle} />)}
        </View> : <Text onLayout={measure} style={textStyle}>{text}</Text>}
      </View>
    </MaskedView>
  </Animated.View>;
});

const styles = StyleSheet.create({
  white: { backgroundColor: "white" },
  gradient: { position: "absolute", top: 0, bottom: 0, left: 0 },
  characters: { flexDirection: "row", alignItems: "flex-start" },
});
