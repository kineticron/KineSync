import { BlurView } from "expo-blur";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Reanimated, { FadeIn, FadeOut } from "react-native-reanimated";

import { LyricsTypeIcon } from "@/components/lyrics/lyrics-type-icon";
import { formatLyricsSourceLabel } from "@/lib/format-lyrics-source";
import type { LyricsTimingMode } from "@/lib/lyrics-timing";

const TOOLTIP_VISIBLE_MS = 2500;

type LyricsTypeIconButtonProps = {
  mode: LyricsTimingMode;
  lyricsSource: string;
  size?: number;
  color?: string;
};

export const LyricsTypeIconButton = memo(function LyricsTypeIconButton({
  mode,
  lyricsSource,
  size = 20,
  color = "#F9FAFC",
}: LyricsTypeIconButtonProps) {
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sourceLabel = formatLyricsSourceLabel(lyricsSource);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const toggleTooltip = useCallback(() => {
    if (tooltipVisible) {
      clearHideTimer();
      setTooltipVisible(false);
      return;
    }

    clearHideTimer();
    setTooltipVisible(true);
    hideTimerRef.current = setTimeout(() => {
      setTooltipVisible(false);
      hideTimerRef.current = null;
    }, TOOLTIP_VISIBLE_MS);
  }, [clearHideTimer, tooltipVisible]);

  useEffect(() => clearHideTimer, [clearHideTimer]);

  if (mode === "unknown") {
    return null;
  }

  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityLabel={
          lyricsTimingModeLabel(mode) +
          `. Source: ${sourceLabel}. Tap to ${tooltipVisible ? "hide" : "show"} source.`
        }
        accessibilityRole="button"
        style={({ pressed }) => [
          styles.iconButton,
          pressed && styles.iconButtonPressed,
        ]}
        onPress={toggleTooltip}
      >
        <LyricsTypeIcon mode={mode} size={size} color={color} />
      </Pressable>

      {tooltipVisible ? (
        <Reanimated.View
          entering={FadeIn.duration(160)}
          exiting={FadeOut.duration(180)}
          style={styles.tooltipAnchor}
          pointerEvents="none"
        >
          <BlurView intensity={34} tint="light" style={styles.tooltip}>
            <View style={styles.tooltipContent}>
              <Text style={styles.tooltipText} numberOfLines={1}>
                {sourceLabel}
              </Text>
            </View>
          </BlurView>
        </Reanimated.View>
      ) : null}
    </View>
  );
});

function lyricsTimingModeLabel(mode: LyricsTimingMode) {
  if (mode === "karaoke") {
    return "Karaoke lyrics";
  }
  if (mode === "static") {
    return "Plain lyrics";
  }
  return "Line lyrics";
}

const styles = StyleSheet.create({
  wrap: {
    position: "relative",
    overflow: "visible",
    zIndex: 20,
  },
  iconButton: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonPressed: {
    opacity: 0.78,
    transform: [{ scale: 0.96 }],
  },
  tooltipAnchor: {
    position: "absolute",
    top: 36,
    left: -72,
    right: -72,
    alignItems: "center",
    zIndex: 30,
  },
  tooltip: {
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.16)",
    backgroundColor: "rgba(255,255,255,0.1)",
    alignSelf: "center",
  },
  tooltipContent: {
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  tooltipText: {
    color: "#F9FAFC",
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.08,
    textAlign: "center",
    flexShrink: 0,
  },
});
