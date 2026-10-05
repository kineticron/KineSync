import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
import { MotionPressable as Button } from "@/components/ui/motion-pressable";
import { Design } from "@/constants/design";
import { TOUR_STEPS, usePlayerTourStore } from "@/store/player-tour-store";

const overlayEntrance = FadeIn.duration(240).reduceMotion(ReduceMotion.System);

const COPY = {
  welcome: ["Let's show you around", "Explore the app, or skip."],
  artwork: [
    "Open Fullscreen Mode",
    "Tap the highlighted album cover at the top to expand the artwork and see some new options.",
  ],
  lyrics: [
    "Back to Lyrics",
    "Tap the highlighted mic at the bottom to bring your lyrics back.",
  ],
  seek: [
    "Jump to a Lyric",
    "Tap any lyric line to play from there. You can also drag the progress bar to seek.",
  ],
  playback: [
    "Control Playback",
    "Tap the highlighted play/pause button. The buttons beside it skip tracks when you’re listening.",
  ],
  translate: [
    "Show Translations",
    "Tap the highlighted language button to reveal translations beneath the lyrics.",
  ],
  autoScroll: [
    "Return to the Current Lyric",
    "Scroll away from the current lyric, then tap the highlighted arrow button to smoothly return to it. Auto scroll follows the song from there.",
  ],
  autoHide: [
    "Give Your Lyrics More Room",
    "Tap the highlighted eye button to turn on Auto hide controls. The playback bar fades away when you leave it alone.",
  ],
  done: [
    "All done!",
    "Open the player menu for more options. In fullscreen, the library button opens your Local Vault and the gear opens Settings.",
  ],
} as const;

export function PlayerTourOverlay({
  controlsHeight,
  transitioning,
  landscape,
  fullscreen,
}: {
  controlsHeight: number;
  transitioning: boolean;
  landscape: boolean;
  fullscreen: boolean;
}) {
  const { active, step, advance, finish, autoHideControls } = usePlayerTourStore();
  const insets = useSafeAreaInsets();
  if (!active || transitioning) return null;
  const dialog = step === "welcome" || step === "done";
  const [title, description] = COPY[step];
  const card = (
    <View style={styles.card}>
      <BlurView
        pointerEvents="none"
        intensity={34}
        tint="light"
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        pointerEvents="none"
        colors={["rgba(255,255,255,0.16)", "rgba(255,255,255,0.03)"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <View style={[styles.copy, !dialog && styles.compactCopy]}>
        <Text style={styles.eyebrow}>
          {dialog
            ? "KINESYNC · SETUP TOUR"
            : `QUICK TOUR · ${TOUR_STEPS.indexOf(step)} OF ${TOUR_STEPS.length - 2}`}
        </Text>
        <Text
          accessibilityRole="header"
          style={[styles.title, !dialog && styles.compactTitle]}
        >
          {title}
        </Text>
        <Text style={styles.description}>
          {landscape && step === "artwork"
            ? "Tap the album cover to reveal the playback controls beside your lyrics."
            : fullscreen && step !== "lyrics" && !dialog
              ? "Tap the bottom mic to return to lyrics and continue the tour."
              : step === 'autoHide' && autoHideControls
                ? "Wait a moment to see the playback bar fade away. Tap near the bottom to bring it back, then continue. Your saved setting stays unchanged during this demo."
                : description}
        </Text>
        <View style={styles.actions}>
          {step !== "done" && (
            <Button
              accessibilityLabel="Skip player tour"
              onPress={finish}
              style={styles.skip}
            >
              <Text style={styles.skipText}>Skip tour</Text>
            </Button>
          )}
          {(dialog || (step === 'autoHide' && autoHideControls)) && (
            <Button
              onPress={() =>
                step === "welcome" ? advance("welcome") : step === 'autoHide' ? advance('autoHide') : finish()
              }
              style={styles.primary}
            >
              <Text style={styles.primaryText}>
                {step === "welcome" ? "Let’s try it" : step === 'autoHide' ? 'Continue' : "Start listening"}
              </Text>
            </Button>
          )}
        </View>
      </View>
    </View>
  );
  // Stay in the screen's view hierarchy so the tour doesn't take over the iOS
  // presentation controller (status bar, Dynamic Island and orientation).
  if (dialog)
    return (
      <Animated.View
        key={step}
        entering={overlayEntrance}
        style={[
          StyleSheet.absoluteFill,
          styles.overlay,
          styles.dialogBackdrop,
          { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 },
        ]}
        accessibilityViewIsModal
      >
        {card}
      </Animated.View>
    );
  // Keep instructions away from the current lyric, which sits near the top of the player.
  const bottom = !landscape && step !== "lyrics";
  return (
    <Animated.View
      key={step}
      entering={overlayEntrance}
      pointerEvents="box-none"
      style={[StyleSheet.absoluteFill, styles.overlay]}
    >
      <View
        pointerEvents="box-none"
        accessibilityLiveRegion="polite"
        style={[
          styles.popup,
          landscape
            ? { left: "40%", right: 20, bottom: insets.bottom + 16 }
            : bottom
              ? { bottom: insets.bottom + Math.max(controlsHeight, 180) + 22 }
              : { top: insets.top + 96 },
        ]}
      >
        {card}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: { zIndex: 100 },
  dialogBackdrop: {
    flex: 1,
    backgroundColor: "rgba(3,8,15,0.28)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  popup: { position: "absolute", left: 20, right: 20, alignItems: "center" },
  card: {
    width: "100%",
    maxWidth: 440,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
    backgroundColor: "rgba(12,16,25,0.36)",
    overflow: "hidden",
  },
  copy: { padding: 20, gap: 12 },
  compactCopy: { padding: 14, gap: 8 },
  compactTitle: { fontSize: 18 },
  eyebrow: {
    color: Design.accent,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.4,
  },
  title: {
    color: Design.text,
    fontSize: 23,
    lineHeight: 29,
    fontWeight: "700",
    letterSpacing: -0.5,
    paddingVertical: 1,
  },
  description: { color: "rgba(249,250,252,0.8)", fontSize: 14, lineHeight: 21 },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 10,
  },
  skip: { minHeight: 44, justifyContent: "center", paddingHorizontal: 4 },
  skipText: {
    color: "rgba(249,250,252,0.72)",
    fontSize: 13,
    fontWeight: "600",
  },
  primary: {
    minHeight: 46,
    paddingHorizontal: 18,
    justifyContent: "center",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
    backgroundColor: "rgba(255,255,255,0.12)",
  },
  primaryText: { color: Design.text, fontSize: 14, fontWeight: "700" },
});
