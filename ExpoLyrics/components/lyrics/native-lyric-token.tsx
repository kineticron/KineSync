import MaskedView from "@react-native-masked-view/masked-view";
import { LinearGradient } from "expo-linear-gradient";
import { memo, useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, View, type TextStyle } from "react-native";
import Animated, { cancelAnimation, Easing, runOnUI, useAnimatedStyle, useDerivedValue,
  useFrameCallback, useSharedValue, withTiming, type SharedValue } from "react-native-reanimated";

import { AMLL_WORD_FADE_WIDTH, amlEmphasis, amlEmphasisParameters, amlFloat, amlMaskCursor, clampAml } from "@/lib/amll-native";
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
  const widths = useSharedValue<number[]>([]);
  const clock = useSharedValue(position);
  const initialFactor = clampAml((scale.value - 0.97) / 0.03);
  const alpha = useSharedValue({ dark: 0.2 + initialFactor * 0.2,
    bright: 0.2 + initialFactor * (highlighted ? 0.8 : 0.2) });
  const fade = lineHeight * AMLL_WORD_FADE_WIDTH;
  const end = useMemo(() => Math.max(0, ...words.map(w => w.endTime + Math.max(1000, w.endTime - w.startTime) * 2)), [words]);
  useEffect(() => {
    cancelAnimation(clock);
    if (!enabled) return;
    return syncNativeTimeline(clock, position, end, playing);
  }, [clock, enabled, end, playing, position]);

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
  const cursor = useDerivedValue(() => amlMaskCursor(clock.value, words, widths.value, fade));
  return { widths, clock, alpha, cursor, fade };
}

type Timeline = ReturnType<typeof useNativeLyricTimeline>;

const EmphasisCharacter = memo(function EmphasisCharacter({ text, index, emphasis, timeline, fontSize, background, textStyle }: {
  text: string; index: number; emphasis: NativeEmphasis; timeline: Timeline; fontSize: number;
  background: boolean; textStyle: TextStyle;
}) {
  const motion = useAnimatedStyle(() => {
    const value = amlEmphasis(timeline.clock.value, emphasis.start, emphasis.index + index,
      emphasis.count, emphasis.params, fontSize, background);
    return { transform: [{ translateX: value.x }, { translateY: value.y }, { scale: value.scale }],
      textShadowColor: `rgba(255,255,255,${value.shadowOpacity})`,
      textShadowOffset: { width: 0, height: 0 }, textShadowRadius: value.shadowRadius };
  });
  return <Animated.Text style={[textStyle, { padding: fontSize, margin: -fontSize }, motion]}>{text}</Animated.Text>;
});

export const NativeLyricToken = memo(function NativeLyricToken({ text, word, index, timeline,
  fontSize, lineHeight, background = false, emphasis }: {
  text: string; word: LyricSyllable; index: number; timeline: Timeline; fontSize: number; lineHeight: number;
  background?: boolean; emphasis?: NativeEmphasis;
}) {
  const [width, setWidth] = useState(0);
  const padding = fontSize;
  const boxWidth = width + padding * 2;
  const gradientWidth = boxWidth * 2 + timeline.fade;
  const characters = useMemo(() => nativeAnimationCharacters(text), [text]);
  const textStyle: TextStyle = { fontSize, lineHeight, fontWeight: background ? "500" : "700",
    letterSpacing: 0.1, color: "white" };
  const floatStyle = useAnimatedStyle(() => ({ transform: [{ translateY:
    amlFloat(timeline.clock.value, word.startTime, word.endTime, fontSize, background) }] }));
  const baseMask = useAnimatedStyle(() => ({ opacity: timeline.alpha.value.dark }));
  const movingMask = useAnimatedStyle(() => {
    let before = 0;
    for (let i = 0; i < index; i++) before += timeline.widths.value[i] || 0;
    const offset = Math.max(-boxWidth - timeline.fade, Math.min(0, padding + timeline.cursor.value - before - boxWidth));
    const { bright, dark } = timeline.alpha.value;
    return { opacity: (bright - dark) / Math.max(0.001, 1 - dark), transform: [{ translateX: offset }] };
  });
  const measure = (event: { nativeEvent: { layout: { width: number } } }) => {
    const measured = event.nativeEvent.layout.width;
    if (Math.abs(measured - width) > 0.01) setWidth(measured);
    if (Math.abs(measured - (timeline.widths.value[index] || 0)) > 0.01) {
      const next = [...timeline.widths.value];
      next[index] = measured;
      timeline.widths.value = next;
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
