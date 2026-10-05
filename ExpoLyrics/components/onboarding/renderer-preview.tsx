import Ionicons from "@react-native-vector-icons/ionicons";
import { useEffect, useState } from "react";
import {
  AppState,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AmllLyricsView } from "@/components/lyrics/amll-lyrics-view";
import { SpicyLyricsView } from "@/components/lyrics/spicy-lyrics-view";
import { MotionPressable } from "@/components/ui/motion-pressable";
import { BlurView } from 'expo-blur';
import { Design } from "@/constants/design";
import { usePlaybackStore } from "@/store/playback-store";
import type { LyricLine } from "@/types/bridge";

// Original demo lyrics, shared by both production renderers.
const phrases = [
  ["Follow the lyrics", "Suis les paroles"],
  ["Testing one two three", "Test un deux trois"],
  ["If you can read this it works", "Si vous pouvez le lire ça marche"],
  ["This is a cool app waow", "C'est un appli super waow"],
  [
    "Well I guess this song has to end",
    "Bon je suppose que cette chanson doit finir",
  ],
];
export const DEMO_LYRICS: LyricLine[] = phrases.map(
  ([text, translation], index) => {
    const start = index * 5000;
    const words = text.split(" ");
    return {
      lineStartTime: start,
      lineEndTime: start + 4600,
      syllables: words.map((word, i) => ({
        text: word + (i < words.length - 1 ? " " : ""),
        startTime: start + i * 650,
        endTime: i === words.length - 1 ? start + 4600 : start + (i + 1) * 650,
      })),
      translatedText: translation,
      ...(index === 1 || index === 3
        ? {
            backgroundSyllables: [
              {
                text: "Background lyrics",
                startTime: start + 1800,
                endTime: start + 4600,
              },
            ],
            backgroundTranslatedText: "Paroles de fond",
          }
        : {}),
      oppositeAligned: index === 3,
    };
  },
);

export function RendererPreview({ active, sideBySide = false }: { active: boolean; sideBySide?: boolean }) {
  const selected = usePlaybackStore((s) => s.lyricsStyle);
  const select = usePlaybackStore((s) => s.setLyricsStyle);
  const [position, setPosition] = useState(0);
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const insets = useSafeAreaInsets();
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!active || !foreground) return;
    const start = Date.now();
    const timer = setInterval(
      () => setPosition((Date.now() - start) % 25000),
      100,
    );
    return () => clearInterval(timer);
  }, [active, foreground]);
  return (
    <View style={styles.comparison}>
      <View style={[styles.panels, sideBySide && styles.panelsSideBySide]}>
      {(["spicy", "amll"] as const).map((style) => {
        const Renderer = style === "spicy" ? SpicyLyricsView : AmllLyricsView;
        return (
          <View
            key={style}
            style={[
              styles.panel,
              sideBySide && styles.panelSideBySide,
              {
                height: sideBySide
                  ? Math.max(240, height - insets.top - insets.bottom - 150)
                  : Math.max(landscape ? 110 : 150, (height - insets.top - insets.bottom - (landscape ? 170 : 350)) / 2),
              },
              selected === style && styles.selected,
            ]}
          >
            <BlurView pointerEvents="none" intensity={24} tint="dark" style={StyleSheet.absoluteFill} />
            <MotionPressable
              accessibilityRole="radio"
              accessibilityState={{ checked: selected === style }}
              accessibilityLabel={`Choose ${style === "spicy" ? "Spicy Lyrics" : "AMLL"}`}
              onPress={() => select(style)}
              style={styles.label}
            >
              <View style={styles.labelCopy}>
                <Text style={styles.title}>
                  {style === "spicy" ? "Spicy Lyrics" : "AMLL"}
                </Text>
                <Text style={styles.hint}>
                  {style === "spicy"
                    ? "Match the Spicy Lyrics Spicetify Extension"
                    : "Match Apple Music Lyrics"}
                </Text>
              </View>
              <Ionicons
                name={
                  selected === style ? "checkmark-circle" : "ellipse-outline"
                }
                size={25}
                color={selected === style ? Design.accent : Design.muted}
              />
            </MotionPressable>
            <View style={styles.lyrics}>
              <Renderer
                demoLyrics={DEMO_LYRICS}
                previewPositionMs={position}
                active={active && foreground}
                tapToSeekEnabled={false}
                showTranslatedText
                fontScale={0.82}
              />
            </View>
          </View>
        );
      })}
      </View>
      <Text style={styles.hint}>
        Both renderers are gratefully sourced from OSS projects.
      </Text>
    </View>
  );
}
const styles = StyleSheet.create({
  comparison: { width: "100%", gap: 10 },
  panels: { gap: 10 },
  panelsSideBySide: { flexDirection: 'row' },
  panelSideBySide: { flex: 1, minWidth: 0 },
  panel: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: Design.border,
    backgroundColor: "rgba(20,26,36,0.28)",
    overflow: "hidden",
  },
  selected: { borderColor: Design.accent },
  label: {
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: { color: Design.text, fontSize: 17, fontWeight: "700" },
  labelCopy: { flex: 1, minWidth: 0, paddingRight: 8 },
  hint: { color: Design.muted, fontSize: 11, marginTop: 3 },
  lyrics: { flex: 1 },
});
