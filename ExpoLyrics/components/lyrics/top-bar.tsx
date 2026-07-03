import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { memo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Reanimated, {
  interpolate,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";

import { BridgedArtworkImage } from "@/components/lyrics/bridged-artwork-image";
import { LyricsTypeIconButton } from "@/components/lyrics/lyrics-type-icon-button";
import { MarqueeText } from "@/components/ui/marquee-text";
import {
  animateIconButtonPressIn,
  animateIconButtonPressOut,
  ICON_BUTTON_PRESS_SCALE,
} from "@/lib/icon-button-press-animation";
import type { LyricsTimingMode } from "@/lib/lyrics-timing";

type TopBarProps = {
  title: string;
  artist: string;
  artworkUrl: string;
  onTrackPress?: () => void;
  onTrackPressIn?: () => void;
  onTrackPressOut?: () => void;
  /** When true, reserves cover-art space but artwork is drawn by the parent morph layer. */
  hideArtwork?: boolean;
  lyricsTimingMode?: LyricsTimingMode;
  lyricsSource?: string;
  onMenuPress: () => void;
};

export const TopBar = memo(function TopBar({
  title,
  artist,
  artworkUrl,
  onTrackPress,
  onTrackPressIn,
  onTrackPressOut,
  hideArtwork = false,
  lyricsTimingMode = "unknown",
  lyricsSource = "",
  onMenuPress,
}: TopBarProps) {
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
    <View style={styles.container}>
      <Pressable
        style={({ pressed }) => [
          styles.trackMetaWrap,
          pressed && styles.trackMetaWrapPressed,
        ]}
        onPress={onTrackPress}
        onPressIn={onTrackPressIn}
        onPressOut={onTrackPressOut}
        disabled={!onTrackPress}>
        {hideArtwork ? (
          <View style={styles.coverArtSlot} />
        ) : artworkUrl ? (
          <BridgedArtworkImage
            uri={artworkUrl}
            style={styles.coverArt}
            contentFit="cover"
            recyclingKey={`topbar-${artworkUrl}`}
          />
        ) : (
          <View style={[styles.coverArt, styles.coverArtEmpty]} />
        )}

        <View style={styles.titleWrap}>
          <MarqueeText style={styles.title}>{title}</MarqueeText>
          <MarqueeText style={styles.artist}>{artist}</MarqueeText>
        </View>
      </Pressable>

      <View style={styles.actionRow}>
        {lyricsTimingMode !== "unknown" ? (
          <LyricsTypeIconButton
            mode={lyricsTimingMode}
            lyricsSource={lyricsSource}
            size={20}
            color="#F9FAFC"
          />
        ) : null}

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
              onPress={onMenuPress}>
              <Ionicons name="ellipsis-horizontal" size={17} color="#F9FAFC" />
            </Pressable>
          </BlurView>
        </Reanimated.View>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: 18,
    paddingHorizontal: 24,
    paddingTop: 18,
    paddingBottom: 10,
  },
  trackMetaWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    minWidth: 0,
  },
  trackMetaWrapPressed: {
    opacity: 0.82,
    transform: [{ scale: 0.99 }],
  },
  coverArtSlot: {
    width: 56,
    height: 56,
  },
  coverArt: {
    width: 56,
    height: 56,
    borderRadius: 11,
    backgroundColor: "rgba(255,255,255,0.12)",
    overflow: "hidden",
  },
  coverArtEmpty: {
    backgroundColor: "rgba(255,255,255,0.12)",
  },
  titleWrap: {
    flex: 1,
    minWidth: 0,
    paddingRight: 6,
  },
  title: {
    color: "#FFFFFF",
    fontSize: 19,
    fontWeight: "700",
    letterSpacing: -0.28,
  },
  artist: {
    marginTop: 3,
    color: "rgba(255,255,255,0.72)",
    fontSize: 15,
    fontWeight: "500",
    letterSpacing: 0.08,
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    overflow: "visible",
    zIndex: 10,
  },
  iconCapsule: {
    borderRadius: 18,
    overflow: "hidden",
    borderWidth: 0,
    borderColor: "rgba(255,255,255,0.16)",
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
