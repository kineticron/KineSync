import React, { memo, useCallback, useContext, useEffect, useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { Canvas, Shadow, Text as SkiaText, matchFont } from '@shopify/react-native-skia';
import Animated, { Easing, useAnimatedReaction, useAnimatedStyle, useDerivedValue, useFrameCallback,
  useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { advanceSpicyDot, amllInterludeSnapshot, initialDotSpringState, spicyDotExitEasing,
  spicyDotTiming, type NativeInterlude } from './native-interlude-motion';
import { NativeLyricsFontContext } from './native-lyrics-fonts';

const SpicyDot = memo(function SpicyDot({ start, end, position, fontSize }: {
  start: number; end: number; position: SharedValue<number>; fontSize: number;
}) {
  const fonts = useContext(NativeLyricsFontContext);
  const font = useMemo(() => fonts ? matchFont({ fontFamily: 'SF Pro Display', fontSize: fontSize * 1.3,
    fontWeight: '700' }, fonts) : null, [fontSize, fonts]);
  const ink = font?.measureText('•');
  const width = font?.getGlyphWidths(font.getGlyphIDs('•'))[0] ?? fontSize * 0.5;
  const dotHeight = fontSize * 1.3 * 0.65;
  // A compact native Text line box clips SF Pro's bullet and its shadow on iOS.
  // Draw the actual bundled glyph into a padded canvas without enlarging flow.
  const padding = 32;
  const state = useSharedValue(initialDotSpringState());
  useAnimatedReaction(() => ({ start, end }), (current, previous) => {
    if (current.start !== previous?.start || current.end !== previous?.end)
      state.value = initialDotSpringState();
  });
  const frame = useFrameCallback(useCallback(info => {
    'worklet';
    const time = position.value;
    if (time < start - 1000 || time > end + 1000) return;
    state.value = advanceSpicyDot(state.value, time, start, end,
      Math.min(0.064, Math.max(0, (info.timeSincePreviousFrame ?? 0) / 1000)));
  }, [end, position, start, state]), false);
  useEffect(() => { frame.setActive(true); return () => frame.setActive(false); }, [frame]);
  const style = useAnimatedStyle(() => ({ opacity: state.value.opacity.p,
    transform: [{ translateY: state.value.y.p * fontSize }, { scale: state.value.scale.p }] }));
  const blur = useDerivedValue(() => (4 + 6 * state.value.glow.p) / 2);
  const shadowColor = useDerivedValue(() => `rgba(255,255,255,${Math.min(1, Math.max(0, state.value.glow.p * 0.9))})`);
  return <Animated.View style={[{ width, height: dotHeight }, style]}>
    {font && ink && <Canvas style={{ position: 'absolute', left: -padding, top: -padding,
      width: width + padding * 2, height: dotHeight + padding * 2 }}>
      <SkiaText text="•" font={font} color="rgba(255,255,255,0.85)"
        x={padding + (width - ink.width) / 2 - ink.x} y={padding + (dotHeight - ink.height) / 2 - ink.y}>
        <Shadow dx={0} dy={0} blur={blur} color={shadowColor} />
      </SkiaText>
    </Canvas>}
  </Animated.View>;
});

const AmllDot = memo(function AmllDot({ index, snapshot, size }: {
  index: number; snapshot: SharedValue<ReturnType<typeof amllInterludeSnapshot>>; size: number;
}) {
  const style = useAnimatedStyle(() => ({ opacity: snapshot.value.dots[index] }));
  return <Animated.View style={[styles.circle, { width: size, height: size, marginRight: index < 2 ? 4 : 0 }, style]} />;
});

/** Persistent slot: animate its height instead of mounting/removing space at JS cues. */
export const NativeInterludeView = memo(function NativeInterludeView({ interlude, position, seekVersion, spicy, fontSize, viewportWidth, right }: {
  interlude: NativeInterlude; position: SharedValue<number>; seekVersion: SharedValue<number>;
  spicy: boolean; fontSize: number; viewportWidth: number; right: boolean;
}) {
  const { start, end } = interlude;
  const height = useSharedValue(0);
  const groupScale = useSharedValue(0);
  const groupOpacity = useSharedValue(0);
  const fullHeight = spicy ? fontSize * 1.3 * 0.65 : fontSize * 1.3 + viewportWidth * 0.05;
  const snapshot = useDerivedValue(() => amllInterludeSnapshot(position.value, start, end - 250));
  useAnimatedReaction(() => ({
    expanded: position.value >= start && position.value < end - (spicy ? 500 : 625),
    shown: position.value >= start && position.value < end - 500,
    seek: seekVersion.value, start, end, fullHeight,
  }), (current, previous) => {
    const reset = previous === null || current.seek !== previous.seek || current.start !== previous.start || current.end !== previous.end || current.fullHeight !== previous.fullHeight;
    if (reset || current.expanded !== previous.expanded)
      height.value = reset ? current.expanded ? fullHeight : 0 : withTiming(current.expanded ? fullHeight : 0,
        { duration: spicy ? 400 : 375, easing: Easing.bezier(0.25, 0.1, 0.25, 1) });
    if (reset || current.shown !== previous.shown) {
      groupScale.value = reset ? Number(current.shown) : withTiming(Number(current.shown),
        { duration: current.shown ? 300 : 400, easing: current.shown ? Easing.bezier(0.25, 0.1, 0.25, 1) : spicyDotExitEasing });
      groupOpacity.value = reset ? Number(current.shown) : withTiming(Number(current.shown), { duration: 140 });
    }
  });
  const slot = useAnimatedStyle(() => ({ height: height.value }));
  const group = useAnimatedStyle(() => ({
    opacity: spicy ? groupOpacity.value : 1,
    transform: [{ scale: spicy ? groupScale.value : snapshot.value.scale }],
  }));
  return <Animated.View pointerEvents="none" accessibilityLabel="Instrumental break" style={slot}>
    <Animated.View style={[styles.group, { top: spicy ? 0 : fontSize * 0.4,
      gap: spicy ? 2.88 : fontSize * 0.25, paddingHorizontal: 0,
      left: right ? undefined : 0, right: right ? 0 : undefined,
      transformOrigin: spicy ? 'center center' : right ? 'right center' : 'left center' }, group]}>
      {spicy ? spicyDotTiming(start, end).map(([dotStart, dotEnd], index) =>
        <SpicyDot key={index} start={dotStart} end={dotEnd} position={position} fontSize={fontSize} />)
        : [0, 1, 2].map(index => <AmllDot key={index} index={index} snapshot={snapshot} size={fontSize * 0.5} />)}
    </Animated.View>
  </Animated.View>;
});

const styles = StyleSheet.create({
  group: { position: 'absolute', flexDirection: 'row', alignItems: 'center' },
  circle: { borderRadius: 100, backgroundColor: '#fff' },
});
