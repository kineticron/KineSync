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
import { RustLyricsView } from "@/components/lyrics/rust/rust-lyrics-view";
import { NativeAmllLyricsView } from "@/components/lyrics/native-amll-lyrics-view";
import { NativeSpicyLyricsView } from "@/components/lyrics/native-spicy-lyrics-view";
import { MotionPressable } from "@/components/ui/motion-pressable";
import { BlurView } from 'expo-blur';
import { Design } from "@/constants/design";
import { usePlaybackStore } from "@/store/playback-store";

import type { PreviewPlaybackAnchor } from "@/components/lyrics/use-playback-timeline-clock";
import { DEMO_LYRICS } from "@/lib/onboarding-demo-lyrics";

const PREVIEW_DURATION_MS = 25000;

export function RendererPreview({ active, sideBySide = false }: { active: boolean; sideBySide?: boolean }) {
  const selected = usePlaybackStore((s) => s.lyricsStyle);
  const select = usePlaybackStore((s) => s.setLyricsStyle);
  const backend = usePlaybackStore((s) => s.lyricsRendererBackend);
  const backendHydrated = usePlaybackStore((s) => s.lyricsRendererBackendHydrated);
  const [playback, setPlayback] = useState<PreviewPlaybackAnchor | null>(null);
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const insets = useSafeAreaInsets();
  const running = active && foreground && backendHydrated;
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    setForeground(AppState.currentState === "active");
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!running) {
      setPlayback(null);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const restart = () => {
      setPlayback({ anchorPositionMs: 0, anchorMonotonicMs: performance.now(), isPlaying: true });
      timer = setTimeout(restart, PREVIEW_DURATION_MS);
    };
    restart();
    return () => clearTimeout(timer);
  }, [running]);
  const SkiaLyricsView = selected === 'amll' ? NativeAmllLyricsView : NativeSpicyLyricsView;
  const previewProps = playback && {
    demoLyrics: DEMO_LYRICS,
    demoPlayback: playback,
    demoDurationMs: PREVIEW_DURATION_MS,
    active: true,
    tapToSeekEnabled: false,
    showTranslatedText: true,
    fontScale: 0.82,
  };
  return (
    <View style={styles.comparison}>
      <View style={[styles.panels, sideBySide && styles.panelsSideBySide]}>
      {(["spicy", "amll"] as const).map((style) => {
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
              {running && previewProps && selected === style ? (
                backend === 'rust'
                  ? <RustLyricsView {...previewProps} demoStyle={style} />
                  : <SkiaLyricsView {...previewProps} demoLayout="preview" />
              ) : (
                <View style={styles.sample}>
                  {DEMO_LYRICS.slice(0, 2).map((line) => (
                    <Text key={line.lineStartTime} style={styles.sampleLine} numberOfLines={1}>
                      {line.syllables.map((syllable) => syllable.text).join("")}
                    </Text>
                  ))}
                </View>
              )}
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
  sample: { flex: 1, justifyContent: "center", paddingHorizontal: 16, gap: 4 },
  sampleLine: { color: Design.muted, fontSize: 17, fontWeight: "700" },
});

