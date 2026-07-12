import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { memo, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Reanimated, {
  FadeIn,
  FadeOut,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";

import { AnimatedBridgedArtwork } from "@/components/lyrics/animated-bridged-artwork";
import { LyricsTypeIconButton } from "@/components/lyrics/lyrics-type-icon-button";
import { MarqueeText } from "@/components/ui/marquee-text";
import {
  animateIconButtonPressIn,
  animateIconButtonPressOut,
  ICON_BUTTON_PRESS_SCALE,
} from "@/lib/icon-button-press-animation";
import type { LyricsTimingMode } from "@/lib/lyrics-timing";

type HorizontalPlayerPanelProps = {
  title: string;
  artist: string;
  artworkUrl: string;
  animatedArtworkUrl?: string;
  artworkSize: number;
  lyricsTimingMode?: LyricsTimingMode;
  lyricsSource?: string;
  onMenuPress: () => void;
  onArtworkPress: () => void;
  controlsOverlayVisible: boolean;
  controlsOverlay: ReactNode;
  utilityRow: ReactNode;
};

export const HorizontalPlayerPanel = memo(function HorizontalPlayerPanel({
  title,
  artist,
  artworkUrl,
  animatedArtworkUrl,
  artworkSize,
  lyricsTimingMode = "unknown",
  lyricsSource = "",
  onMenuPress,
  onArtworkPress,
  controlsOverlayVisible,
  controlsOverlay,
  utilityRow,
}: HorizontalPlayerPanelProps) {
  const menuScale = useSharedValue(1);
  const menuAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: menuScale.value }],
    opacity: interpolate(
      menuScale.value,
      [1, ICON_BUTTON_PRESS_SCALE],
      [1, 0.86],
    ),
  }));

  return (
    <View style={[styles.box, { width: artworkSize }]}>
      <Pressable
        style={[
          styles.artworkPressable,
          { width: artworkSize, height: artworkSize },
        ]}
        onPress={onArtworkPress}
        accessibilityLabel="Show playback controls"
      >
        {artworkUrl ? (
          <AnimatedBridgedArtwork
            staticUri={artworkUrl}
            animatedUri={animatedArtworkUrl}
            style={styles.artwork}
            recyclingKey={`landscape-artwork-${artworkUrl}-${animatedArtworkUrl || ""}`}
          />
        ) : (
          <View style={[styles.artwork, styles.artworkEmpty]} />
        )}

        {controlsOverlayVisible ? (
          <Reanimated.View
            style={styles.controlsOverlayBottom}
            pointerEvents="box-none"
          >
            <View style={styles.controlsBlurStrip}>
              <BlurView
                intensity={48}
                tint="dark"
                style={StyleSheet.absoluteFill}
              />
              <View style={styles.controlsOverlayContent}>
                {controlsOverlay}
              </View>
            </View>
          </Reanimated.View>
        ) : null}
      </Pressable>

      <View style={styles.metaSection}>
        <MarqueeText style={styles.title}>{title}</MarqueeText>
        <MarqueeText style={styles.artist}>{artist}</MarqueeText>

        <View style={styles.actionRow}>
          {utilityRow}

          {lyricsTimingMode !== "unknown" ? (
            <View style={styles.actionSlot}>
              <LyricsTypeIconButton
                mode={lyricsTimingMode}
                lyricsSource={lyricsSource}
                size={20}
                color="#F9FAFC"
              />
            </View>
          ) : null}

          <View style={styles.actionSlot}>
            <Reanimated.View style={menuAnimatedStyle}>
              <BlurView intensity={34} tint="light" style={styles.iconCapsule}>
                <Pressable
                  accessibilityLabel="Open player menu"
                  style={({ pressed }) => [
                    styles.iconButton,
                    pressed && styles.iconButtonPressed,
                  ]}
                  onPressIn={() => {
                    animateIconButtonPressIn(menuScale);
                  }}
                  onPressOut={() => {
                    animateIconButtonPressOut(menuScale);
                  }}
                  onPress={onMenuPress}
                >
                  <Ionicons
                    name="ellipsis-horizontal"
                    size={17}
                    color="#F9FAFC"
                  />
                </Pressable>
              </BlurView>
            </Reanimated.View>
          </View>
        </View>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  box: {
    alignSelf: "center",
    gap: 8,
  },
  artworkPressable: {
    borderRadius: 18,
    overflow: "hidden",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  artwork: {
    width: "100%",
    height: "100%",
  },
  artworkEmpty: {
    backgroundColor: "rgba(255,255,255,0.12)",
  },
  controlsOverlayBottom: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
  },
  controlsBlurStrip: {
    overflow: "hidden",
    borderBottomLeftRadius: 18,
    borderBottomRightRadius: 18,
  },
  controlsOverlayContent: {
    paddingHorizontal: 4,
    paddingTop: 4,
    paddingBottom: 6,
  },
  metaSection: {
    gap: 4,
    width: "100%",
  },
  title: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: -0.24,
  },
  artist: {
    color: "rgba(255,255,255,0.72)",
    fontSize: 13,
    fontWeight: "500",
    letterSpacing: 0.06,
  },
  actionRow: {
    marginTop: 2,
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    overflow: "visible",
    zIndex: 10,
  },
  actionSlot: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  iconCapsule: {
    borderRadius: 18,
    overflow: "hidden",
    backgroundColor: "rgba(255,255,255,0.1)",
  },
  iconButton: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonPressed: {
    backgroundColor: "rgba(255,255,255,0.18)",
    opacity: 0.94,
  },
});

