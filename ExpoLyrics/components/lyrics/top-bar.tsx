import Ionicons from "@react-native-vector-icons/ionicons";
import { BlurView } from "expo-blur";
import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
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
  tourHighlight?: boolean;
  fitTitle?: boolean;
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
  tourHighlight = false,
  fitTitle = false,
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
        accessibilityRole={onTrackPress ? 'button' : undefined}
        accessibilityLabel={onTrackPress ? `${title}, ${artist}. Show album artwork` : `${title}, ${artist}`}
        style={({ pressed }) => [
          styles.trackMetaWrap,
          pressed && styles.trackMetaWrapPressed,
        ]}
        onPress={onTrackPress}
        onPressIn={onTrackPressIn}
        onPressOut={onTrackPressOut}
        disabled={!onTrackPress}>
        {tourHighlight && <View pointerEvents="none" style={styles.tourHighlight} />}
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
          <Image source={require('@/assets/images/R.png')} style={styles.coverArt} />
        )}

        <View collapsable={false} style={styles.titleWrap}>
          {fitTitle ? <>
            <Text style={[styles.title, styles.fittedTitle]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{title}</Text>
            <Text style={[styles.artist, styles.fittedArtist]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{artist}</Text>
          </> : <>
            <MarqueeText style={styles.title}>{title}</MarqueeText>
            <MarqueeText style={styles.artist}>{artist}</MarqueeText>
          </>}
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
              accessibilityRole="button"
              accessibilityLabel="Open player menu"
              hitSlop={5}
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
  fittedTitle: { lineHeight: 25, paddingVertical: 1 },
  fittedArtist: { lineHeight: 20 },
  // Draw outside the measured artwork slot: borders must not shift the parent morph layer.
  tourHighlight: { position: 'absolute', top: -6, bottom: -6, left: -6, right: -6, borderWidth: 2, borderColor: '#A8F0CF', borderRadius: 17 },
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
    flexShrink: 0,
  },
  coverArt: {
    width: 56,
    height: 56,
    flexShrink: 0,
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
    overflow: "hidden",
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
