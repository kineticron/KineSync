import { memo } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";

import type { LyricsTimingMode } from "@/lib/lyrics-timing";

type LyricsTypeIconProps = {
  mode: LyricsTimingMode;
  size?: number;
  color?: string;
};

/** Head at top-right, handle at bottom-left — matches the app icon. */
const MIC_ROTATION = "45deg";
const MIC_BODY_SCALE = 1.28;

function Sparkle({
  size,
  color,
  style,
}: {
  size: number;
  color: string;
  style?: ViewStyle;
}) {
  const pointLength = size * 0.54;
  const pointWidth = Math.max(1.1, size * 0.19);

  return (
    <View
      style={[
        styles.sparkleWrap,
        { width: size, height: size },
        style,
      ]}>
      {[0, 90].map((deg) => (
        <View
          key={deg}
          style={[
            styles.sparkleArm,
            {
              width: pointWidth,
              height: pointLength,
              borderRadius: pointWidth * 0.12,
              backgroundColor: color,
              transform: [{ rotate: `${deg}deg` }],
            },
          ]}
        />
      ))}
    </View>
  );
}

function MicBody({
  filled,
  color,
  scale,
  variant = "line",
}: {
  filled: boolean;
  color: string;
  scale: number;
  variant?: "karaoke" | "line" | "static";
}) {
  const micScale = scale * MIC_BODY_SCALE;
  const stroke = Math.max(1.35, 1.65 * micScale);
  const headSize = (variant === "static" ? 8.2 : 8.6) * micScale;
  const handleWidth = (variant === "static" ? 3.6 : 4) * micScale;
  const handleHeight = (variant === "static" ? 10.8 : 12.2) * micScale;
  const handleRadius = 2 * micScale;
  const showNeckArcs = !filled && variant === "line";

  return (
    <View style={styles.micBody}>
      <View
        style={{
          width: headSize,
          height: headSize,
          borderRadius: headSize / 2,
          borderWidth: filled ? 0 : stroke,
          borderColor: color,
          backgroundColor: filled ? color : "transparent",
        }}
      />
      {showNeckArcs ? (
        <View style={styles.neckWrap}>
          <View
            style={[
              styles.neckArc,
              {
                width: headSize * 0.92,
                height: headSize * 0.42,
                borderColor: color,
                borderWidth: stroke * 0.72,
              },
            ]}
          />
          <View
            style={[
              styles.neckArc,
              styles.neckArcLower,
              {
                width: headSize * 0.78,
                height: headSize * 0.34,
                borderColor: color,
                borderWidth: stroke * 0.72,
              },
            ]}
          />
        </View>
      ) : filled ? (
        <View
          style={{
            width: handleWidth + stroke,
            height: stroke * 1.1,
            marginTop: -stroke * 0.35,
            borderRadius: stroke,
            backgroundColor: color,
          }}
        />
      ) : (
        <View
          style={{
            width: stroke * 0.9,
            height: stroke * 1.15,
            marginTop: -stroke * 0.25,
            borderRadius: stroke,
            backgroundColor: color,
          }}
        />
      )}
      <View
        style={{
          width: handleWidth,
          height: handleHeight,
          marginTop: filled
            ? -stroke * 0.2
            : showNeckArcs
              ? -stroke * 0.55
              : -stroke * 0.2,
          borderRadius: handleRadius,
          borderWidth: filled ? 0 : stroke,
          borderColor: color,
          backgroundColor: filled ? color : "transparent",
        }}
      />
    </View>
  );
}

export const LyricsTypeIcon = memo(function LyricsTypeIcon({
  mode,
  size = 20,
  color = "#F9FAFC",
}: LyricsTypeIconProps) {
  const isKaraoke = mode === "karaoke";
  const isStatic = mode === "static";
  const opacity = mode === "unknown" ? 0.42 : 1;
  const scale = size / 24;
  const micVariant = isKaraoke ? "karaoke" : isStatic ? "static" : "line";

  return (
    <View style={[styles.canvas, { width: size, height: size, opacity }]}>
      {isKaraoke ? (
        <>
          <Sparkle
            size={6.4 * scale}
            color={color}
            style={{ position: "absolute", left: -0.4 * scale, top: -0.2 * scale }}
          />
          <Sparkle
            size={3.1 * scale}
            color={color}
            style={{ position: "absolute", left: 5.6 * scale, top: 0.6 * scale }}
          />
          <Sparkle
            size={2.6 * scale}
            color={color}
            style={{ position: "absolute", left: 1.2 * scale, top: 5.8 * scale }}
          />
          <Sparkle
            size={6.4 * scale}
            color={color}
            style={{
              position: "absolute",
              right: -0.4 * scale,
              bottom: -0.2 * scale,
            }}
          />
          <Sparkle
            size={3.1 * scale}
            color={color}
            style={{
              position: "absolute",
              right: 5.6 * scale,
              bottom: 0.6 * scale,
            }}
          />
          <Sparkle
            size={2.6 * scale}
            color={color}
            style={{
              position: "absolute",
              right: 1.2 * scale,
              bottom: 5.8 * scale,
            }}
          />
        </>
      ) : null}

      <View
        style={[
          styles.micWrap,
          { transform: [{ rotate: MIC_ROTATION }] },
        ]}>
        <MicBody
          filled={isKaraoke}
          color={color}
          scale={scale}
          variant={micVariant}
        />
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  canvas: {
    position: "relative",
    overflow: "visible",
  },
  sparkleWrap: {
    alignItems: "center",
    justifyContent: "center",
  },
  sparkleArm: {
    position: "absolute",
  },
  micWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  micBody: {
    alignItems: "center",
  },
  neckWrap: {
    alignItems: "center",
    marginTop: -2,
  },
  neckArc: {
    borderTopLeftRadius: 999,
    borderTopRightRadius: 999,
    borderBottomWidth: 0,
    backgroundColor: "transparent",
  },
  neckArcLower: {
    marginTop: -3,
  },
});
