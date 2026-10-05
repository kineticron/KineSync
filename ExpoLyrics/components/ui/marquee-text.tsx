import { useFocusEffect } from "expo-router";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Animated, AppState, Easing, ScrollView, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { useReducedMotion } from "react-native-reanimated";

type MarqueeTextProps = {
  children: string;
  style?: StyleProp<TextStyle>;
  containerStyle?: StyleProp<ViewStyle>;
};

export const MarqueeText = memo(function MarqueeText(props: MarqueeTextProps) {
  // Remount the animation and measurements together so a new label never
  // inherits the previous track's native offset or pending layout callbacks.
  return <MarqueeLabel key={props.children} {...props} />;
});

function MarqueeLabel({
  children,
  style,
  containerStyle,
}: MarqueeTextProps) {
  const [viewportWidth, setViewportWidth] = useState(0);
  const [contentWidth, setContentWidth] = useState(0);
  const [appActive, setAppActive] = useState(AppState.currentState === "active");
  const [focused, setFocused] = useState(false);
  const reduceMotion = useReducedMotion();
  const offset = useRef(new Animated.Value(0)).current;
  const overflow = Math.max(0, contentWidth - viewportWidth);

  useFocusEffect(useCallback(() => {
    setFocused(true);
    return () => setFocused(false);
  }, []));

  useEffect(() => {
    const subscription = AppState.addEventListener("change", state => setAppActive(state === "active"));
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    offset.stopAnimation();
    offset.setValue(0);
    if (!reduceMotion && focused && appActive && viewportWidth > 0 && overflow > 1) {
      const duration = Math.max(1600, overflow / 28 * 1000);
      const animation = Animated.loop(Animated.sequence([
        Animated.delay(1400),
        Animated.timing(offset, { toValue: -overflow, duration, easing: Easing.linear, useNativeDriver: true, isInteraction: false }),
        Animated.delay(1400),
        Animated.timing(offset, { toValue: 0, duration, easing: Easing.linear, useNativeDriver: true, isInteraction: false }),
      ]));
      animation.start();
      return () => animation.stop();
    }
    return () => offset.stopAnimation();
  }, [children, overflow, viewportWidth, reduceMotion, focused, appActive, offset]);

  if (reduceMotion) {
    return <View collapsable={false} style={[styles.viewport, containerStyle]}><Text style={style} numberOfLines={1} ellipsizeMode="tail">{children}</Text></View>;
  }

  return (
    <View collapsable={false} style={[styles.viewport, containerStyle]}>
      <ScrollView
        horizontal
        scrollEnabled={false}
        pointerEvents="none"
        showsHorizontalScrollIndicator={false}
        style={styles.scroller}
        contentContainerStyle={styles.content}
        onLayout={event => setViewportWidth(event.nativeEvent.layout.width)}
        onContentSizeChange={width => setContentWidth(width)}>
        <Animated.Text style={[style, styles.label, { transform: [{ translateX: offset }] }]} numberOfLines={1}>{children}</Animated.Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  viewport: { width: "100%", overflow: "hidden", minWidth: 0 },
  scroller: { flexGrow: 0, flexShrink: 0 },
  content: { flexGrow: 1 },
  label: { flexShrink: 0, flexGrow: 1 },
});
