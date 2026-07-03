import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import {
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import Reanimated, {
  Easing as ReanimatedEasing,
  Extrapolation,
  interpolate,
  interpolateColor,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { bridgeClient } from "@/lib/bridge-client";
import { extractHost, isPrivateIpv4 } from "@/lib/network";
import { usePlaybackStore } from "@/store/playback-store";
import { saveBridgeSettings } from "@/lib/bridge-settings";
import { CameraView, useCameraPermissions } from "expo-camera";

function inferDefaultBridgeUrl() {
  const configuredBridgeUrl =
    process.env.EXPO_PUBLIC_BRIDGE_WS_URL?.trim() ||
    ""; // Set EXPO_PUBLIC_BRIDGE_WS_URL or configure in Bridge Settings

  if (configuredBridgeUrl) {
    return configuredBridgeUrl;
  }

  if (Platform.OS === "web") {
    const hostname =
      typeof window !== "undefined" && window.location?.hostname
        ? window.location.hostname
        : "localhost";
    const host =
      hostname === "0.0.0.0" || hostname === "::" ? "localhost" : hostname;
    return `ws://${host}:3001`;
  }

  const Constants = require("expo-constants").default;
  const constantsAny = Constants as unknown as Record<string, unknown>;
  const expoGoConfig = (constantsAny.expoGoConfig || {}) as Record<
    string,
    unknown
  >;
  const manifest = (constantsAny.manifest || {}) as Record<string, unknown>;

  const candidates = [
    extractHost(expoGoConfig.debuggerHost),
    extractHost(manifest.debuggerHost),
    extractHost(Constants.expoConfig?.hostUri),
    extractHost(constantsAny?.linkingUri),
  ].filter(Boolean);

  const preferredPrivateHost = candidates.find((host) => isPrivateIpv4(host));
  const host =
    preferredPrivateHost ||
    candidates.find(
      (candidate) => candidate === "localhost" || candidate === "127.0.0.1",
    ) ||
    "";
  if (!host) {
    return "";
  }
  return `ws://${host}:3001`;
}

type IoniconName = ComponentProps<typeof Ionicons>["name"];

const ONBOARDING_STEPS: {
  icon: IoniconName;
  title: string;
  eyebrow: string;
  description: string;
}[] = [
  {
    icon: "musical-notes-outline",
    eyebrow: "Welcome",
    title: "Syllable-synced lyrics,\non your terms.",
    description:
      "A modern, beautiful mobile app for rendering syllable-synced lyrics synced with your Spotify playback using your own self-hosted Desktop Bridge. Free, forever.",
  },
  {
    icon: "color-palette-outline",
    eyebrow: "Your vibe",
    title: "Customize the visuals.",
    description:
      "These settings control how much UI stays on screen while the music plays. Go minimal or extra. \n All settings can be changed later.",
  },
  {
    icon: "scan-outline",
    eyebrow: "Connect",
    title: "Link to your Desktop Bridge.",
    description:
      "Open the Desktop Bridge on your PC, enable the relay, then scan the QR code it shows. One scan and you're connected.",
  },
];

function GlassIcon({ icon, active }: { icon: IoniconName; active?: boolean }) {
  return (
    <BlurView intensity={34} tint="light" style={styles.iconGlassOuter}>
      <LinearGradient
        colors={[
          "rgba(255,255,255,0.24)",
          active ? "rgba(143,240,196,0.16)" : "rgba(255,255,255,0.06)",
        ]}
        start={{ x: 0.15, y: 0 }}
        end={{ x: 0.9, y: 1 }}
        style={styles.iconGlassInner}
      >
        <Ionicons name={icon} size={42} color="#F8F8FE" />
      </LinearGradient>
    </BlurView>
  );
}

function StepPage({
  index,
  itemWidth,
  scrollX,
  children,
}: {
  index: number;
  itemWidth: number;
  scrollX: SharedValue<number>;
  children: ReactNode;
}) {
  const animatedStyle = useAnimatedStyle(() => {
    const progress = itemWidth > 0 ? scrollX.value / itemWidth : 0;
    const inputRange = [index - 1, index, index + 1];
    return {
      opacity: interpolate(
        progress,
        inputRange,
        [0.34, 1, 0.34],
        Extrapolation.CLAMP,
      ),
      transform: [
        {
          translateX: interpolate(
            progress,
            inputRange,
            [34, 0, -34],
            Extrapolation.CLAMP,
          ),
        },
        {
          scale: interpolate(
            progress,
            inputRange,
            [0.94, 1, 0.94],
            Extrapolation.CLAMP,
          ),
        },
      ],
    };
  }, [index, itemWidth]);

  return (
    <View style={[styles.page, { width: itemWidth }]}>
      <Reanimated.View style={[styles.pageInner, animatedStyle]}>
        {children}
      </Reanimated.View>
    </View>
  );
}

function Dot({
  index,
  itemWidth,
  scrollX,
}: {
  index: number;
  itemWidth: number;
  scrollX: SharedValue<number>;
}) {
  const animatedStyle = useAnimatedStyle(() => {
    const progress = itemWidth > 0 ? scrollX.value / itemWidth : 0;
    const inputRange = [index - 1, index, index + 1];
    return {
      width: interpolate(progress, inputRange, [7, 24, 7], Extrapolation.CLAMP),
      backgroundColor: interpolateColor(progress, inputRange, [
        "rgba(255,255,255,0.24)",
        "rgba(143,240,196,0.92)",
        "rgba(255,255,255,0.24)",
      ]),
    };
  }, [index, itemWidth]);

  return <Reanimated.View style={[styles.dot, animatedStyle]} />;
}

function ToggleRow({
  icon,
  label,
  value,
  onChange,
}: {
  icon: IoniconName;
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.toggleRow}>
      <View style={styles.rowIconWrap}>
        <Ionicons name={icon} size={17} color="rgba(248,248,254,0.88)" />
      </View>
      <Text style={styles.toggleLabel}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{
          false: "rgba(255,255,255,0.16)",
          true: "rgba(143,240,196,0.42)",
        }}
        thumbColor="#F8F8FE"
      />
    </View>
  );
}

function OnboardingScreen({ onDismiss }: { onDismiss: () => void }) {
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const itemWidth = Math.max(1, windowWidth);
  const scrollX = useSharedValue(0);
  const buttonScale = useSharedValue(1);
  const [step, setStep] = useState(0);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanError, setScanError] = useState("");
  const [scanCompleted, setScanCompleted] = useState(false);
  const scrollRef = useRef<any>(null);

  const connectionStatus = usePlaybackStore((s) => s.connectionStatus);
  const setServerUrlStore = usePlaybackStore((s) => s.setServerUrl);
  const setHandshakeKeyStore = usePlaybackStore((s) => s.setHandshakeKey);
  const playbackTapToSeek = usePlaybackStore((s) => s.playbackTapToSeek);
  const setPlaybackTapToSeek = usePlaybackStore((s) => s.setPlaybackTapToSeek);
  const hidePlaybackStatusBar = usePlaybackStore(
    (s) => s.hidePlaybackStatusBar,
  );
  const setHidePlaybackStatusBar = usePlaybackStore(
    (s) => s.setHidePlaybackStatusBar,
  );
  const autoHidePlaybackControls = usePlaybackStore(
    (s) => s.autoHidePlaybackControls,
  );
  const setAutoHidePlaybackControls = usePlaybackStore(
    (s) => s.setAutoHidePlaybackControls,
  );
  const showTranslatedText = usePlaybackStore((s) => s.showTranslatedText);
  const setShowTranslatedText = usePlaybackStore(
    (s) => s.setShowTranslatedText,
  );

  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  const isLastStep = step === ONBOARDING_STEPS.length - 1;

  const scanFailTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scanHandled = useRef(false);

  const handleBarcodeScanned = useCallback(
    ({ data }: { data: string }) => {
      if (scanHandled.current) return;
      try {
        const parsed = JSON.parse(data);
        if (parsed.u && parsed.k) {
          scanHandled.current = true;
          if (scanFailTimer.current) {
            clearTimeout(scanFailTimer.current);
            scanFailTimer.current = null;
          }
          setScanError("");
          setServerUrlStore(parsed.u);
          setHandshakeKeyStore(parsed.k);
          saveBridgeSettings({
            serverUrl: parsed.u,
            handshakeKey: parsed.k,
          }).catch(() => {});
          bridgeClient.reconnectNow();
          setScanCompleted(true);
          setScannerOpen(false);
          return;
        }
      } catch {}
      if (!scanFailTimer.current) {
        scanFailTimer.current = setTimeout(() => {
          setScanError("No valid KineSync QR code found");
          scanFailTimer.current = null;
        }, 5000);
      }
    },
    [setServerUrlStore, setHandshakeKeyStore],
  );

  const openScanner = async () => {
    scanHandled.current = false;
    if (cameraPermission?.granted === true) {
      setScannerOpen(true);
      return;
    }
    const { status } = await requestCameraPermission();
    if (status === "granted") {
      setScannerOpen(true);
    } else {
      setScanError("Camera permission required to scan QR codes");
      setTimeout(() => setScanError(""), 3000);
    }
  };

  const onScroll = useAnimatedScrollHandler({
    onScroll: (event) => {
      scrollX.value = event.contentOffset.x;
    },
  });

  const buttonAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: buttonScale.value }],
  }));

  const backgroundAnimatedStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      scrollX.value / itemWidth,
      [0, 1, 2],
      ["rgba(9,10,17,0.94)", "rgba(8,12,18,0.94)", "rgba(10,9,17,0.94)"],
    ),
  }));

  const footerLabel = useMemo(
    () => (isLastStep ? "Get started" : "Next"),
    [isLastStep],
  );

  const persistBridgeSettings = useCallback(() => {
    const state = usePlaybackStore.getState();
    if (!state.serverUrl) {
      setServerUrlStore(inferDefaultBridgeUrl());
    }
    bridgeClient.reconnectNow();
  }, [setServerUrlStore]);

  const handleNext = useCallback(() => {
    if (isLastStep) {
      persistBridgeSettings();
      onDismiss();
      return;
    }
    const nextStep = Math.min(step + 1, ONBOARDING_STEPS.length - 1);
    setStep(nextStep);
    scrollX.value = withTiming(nextStep * itemWidth, {
      duration: 360,
      easing: ReanimatedEasing.out(ReanimatedEasing.cubic),
    });
    scrollRef.current?.scrollTo({ x: nextStep * itemWidth, animated: true });
  }, [isLastStep, itemWidth, onDismiss, persistBridgeSettings, scrollX, step]);

  const handleSkip = useCallback(() => {
    persistBridgeSettings();
    onDismiss();
  }, [onDismiss, persistBridgeSettings]);

  const handleMomentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const nextStep = Math.max(
        0,
        Math.min(
          ONBOARDING_STEPS.length - 1,
          Math.round(event.nativeEvent.contentOffset.x / itemWidth),
        ),
      );
      setStep(nextStep);
    },
    [itemWidth],
  );

  return (
    <GestureHandlerRootView style={styles.root}>
      <View style={styles.container}>
        <Reanimated.View
          style={[StyleSheet.absoluteFill, backgroundAnimatedStyle]}
        />
        <LinearGradient
          pointerEvents="none"
          colors={[
            "rgba(90,109,255,0.28)",
            "rgba(143,240,196,0.10)",
            "rgba(182,104,242,0.22)",
          ]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.backdropWash}
        />
        <View
          pointerEvents="none"
          style={[styles.ambientGlow, styles.ambientGlowA]}
        />
        <View
          pointerEvents="none"
          style={[styles.ambientGlow, styles.ambientGlowB]}
        />

        <View style={[styles.topBar, { paddingTop: insets.top + 10 }]}>
          <View />
          <Pressable
            onPress={handleSkip}
            hitSlop={12}
            style={({ pressed }) => [
              styles.skipButton,
              pressed && styles.topActionPressed,
            ]}
          >
            <BlurView intensity={28} tint="dark" style={styles.skipBlur}>
              <Text style={styles.skipText}>Skip</Text>
            </BlurView>
          </Pressable>
        </View>

        <Reanimated.ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          bounces={false}
          overScrollMode="never"
          showsHorizontalScrollIndicator={false}
          directionalLockEnabled
          decelerationRate="fast"
          snapToInterval={itemWidth}
          snapToAlignment="start"
          disableIntervalMomentum
          onScroll={onScroll}
          onMomentumScrollEnd={handleMomentumEnd}
          scrollEventThrottle={16}
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
        >
          {ONBOARDING_STEPS.map((stepData, index) => (
            <StepPage
              key={stepData.title}
              index={index}
              itemWidth={itemWidth}
              scrollX={scrollX}
            >
              <GlassIcon icon={stepData.icon} active={index === step} />
              <Text style={styles.eyebrow}>{stepData.eyebrow}</Text>
              <Text style={styles.title}>{stepData.title}</Text>
              <Text style={styles.description}>{stepData.description}</Text>

              {index === 1 ? (
                <BlurView intensity={30} tint="dark" style={styles.inlinePanel}>
                  <ToggleRow
                    icon="hand-left-outline"
                    label="Tap a lyric to jump there"
                    value={playbackTapToSeek}
                    onChange={setPlaybackTapToSeek}
                  />
                  <ToggleRow
                    icon="eye-off-outline"
                    label="Minimal — hide status bar"
                    value={hidePlaybackStatusBar}
                    onChange={setHidePlaybackStatusBar}
                  />
                  <ToggleRow
                    icon="timer-outline"
                    label="Fade controls after a moment"
                    value={autoHidePlaybackControls}
                    onChange={setAutoHidePlaybackControls}
                  />
                  <ToggleRow
                    icon="language-outline"
                    label="Show line translations"
                    value={showTranslatedText}
                    onChange={setShowTranslatedText}
                  />
                </BlurView>
              ) : null}

              {index === 2 ? (
                <BlurView intensity={30} tint="dark" style={styles.inlinePanel}>
                  {scanCompleted ? (
                    <View style={styles.connectionStatusRow}>
                      <Ionicons
                        name={
                          connectionStatus === "connected"
                            ? "checkmark-circle"
                            : connectionStatus === "connecting"
                              ? "sync-outline"
                              : "close-circle"
                        }
                        size={20}
                        color={
                          connectionStatus === "connected"
                            ? "#8FF0C4"
                            : connectionStatus === "connecting"
                              ? "rgba(248,248,254,0.7)"
                              : "#FF6B6B"
                        }
                      />
                      <Text style={styles.connectionStatusText}>
                        {connectionStatus === "connected"
                          ? "Connected to Desktop Bridge"
                          : connectionStatus === "connecting"
                            ? "Connecting to bridge…"
                            : "Connection failed – check bridge is running"}
                      </Text>
                      {connectionStatus === "disconnected" ? (
                        <Pressable
                          onPress={() => bridgeClient.reconnectNow()}
                          style={styles.retryButton}
                        >
                          <Text style={styles.retryButtonText}>Retry</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  ) : (
                    <>
                      <Pressable
                        style={({ pressed }) => [
                          styles.scanButton,
                          pressed && styles.buttonPressed,
                        ]}
                        onPress={openScanner}
                      >
                        <BlurView
                          intensity={30}
                          tint="light"
                          style={styles.scanButtonBlur}
                        >
                          <Ionicons
                            name="qr-code-outline"
                            size={20}
                            color="#F8F8FE"
                          />
                          <Text style={styles.scanButtonText}>
                            Scan QR code from Desktop Bridge
                          </Text>
                        </BlurView>
                      </Pressable>
                      <Text style={styles.inlinePanelHint}>
                        Or configure manually in Bridge Settings later.
                      </Text>
                    </>
                  )}
                </BlurView>
              ) : null}
            </StepPage>
          ))}
        </Reanimated.ScrollView>

        <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.dots}>
            {ONBOARDING_STEPS.map((stepData, index) => (
              <Dot
                key={stepData.title}
                index={index}
                itemWidth={itemWidth}
                scrollX={scrollX}
              />
            ))}
          </View>

          <Reanimated.View style={buttonAnimatedStyle}>
            <Pressable
              onPress={handleNext}
              onPressIn={() => {
                buttonScale.value = withTiming(0.97, { duration: 90 });
              }}
              onPressOut={() => {
                buttonScale.value = withTiming(1, {
                  duration: 180,
                  easing: ReanimatedEasing.out(ReanimatedEasing.cubic),
                });
              }}
              style={({ pressed }) => [
                styles.nextButton,
                pressed && styles.buttonPressed,
              ]}
            >
              <BlurView intensity={30} tint="light" style={styles.nextBlur}>
                <LinearGradient
                  colors={["rgba(143,240,196,0.28)", "rgba(90,109,255,0.34)"]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.nextGradient}
                >
                  <Text style={styles.nextText}>{footerLabel}</Text>
                  <Ionicons
                    name={isLastStep ? "checkmark" : "arrow-forward"}
                    size={18}
                    color="#F8F8FE"
                  />
                </LinearGradient>
              </BlurView>
            </Pressable>
          </Reanimated.View>
        </View>

        {/* QR Code Scanner Modal */}
        <Modal
          animationType="slide"
          visible={scannerOpen}
          onRequestClose={() => setScannerOpen(false)}
        >
          <GestureHandlerRootView style={styles.scannerModalRoot}>
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={() => setScannerOpen(false)}
            />
            <View style={styles.scannerModalContainer}>
              <CameraView
                style={styles.scannerCamera}
                onBarcodeScanned={handleBarcodeScanned}
              />
              <View style={styles.scannerOverlay}>
                <View style={styles.scannerFrame} />
                <Text style={styles.scannerInstruction}>
                  Point camera at the QR code on your Desktop Bridge app
                </Text>
              </View>
              {scanError && (
                <View style={styles.scannerError}>
                  <Text style={styles.scannerErrorText}>{scanError}</Text>
                </View>
              )}
              <Pressable
                onPress={() => setScannerOpen(false)}
                style={styles.scannerCloseButton}
              >
                <BlurView
                  intensity={34}
                  tint="dark"
                  style={styles.scannerCloseBlur}
                >
                  <Ionicons name="close" size={20} color="#F8F8FE" />
                </BlurView>
              </Pressable>
            </View>
          </GestureHandlerRootView>
        </Modal>
      </View>
    </GestureHandlerRootView>
  );
}

export const Onboarding = memo(OnboardingScreen);

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  container: {
    flex: 1,
    backgroundColor: "#090A11",
    overflow: "hidden",
  },
  backdropWash: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0.9,
  },
  ambientGlow: {
    position: "absolute",
    width: 290,
    height: 290,
    borderRadius: 145,
    opacity: 0.34,
  },
  ambientGlowA: {
    top: 58,
    left: -96,
    backgroundColor: "#5A6DFF",
  },
  ambientGlowB: {
    right: -94,
    bottom: 136,
    backgroundColor: "#8FF0C4",
  },
  topBar: {
    position: "absolute",
    left: 20,
    right: 20,
    zIndex: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  topAction: {
    borderRadius: 18,
    overflow: "hidden",
  },
  topActionPressed: {
    opacity: 0.8,
    transform: [{ scale: 0.97 }],
  },
  topActionBlur: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    backgroundColor: "rgba(255,255,255,0.09)",
    overflow: "hidden",
  },
  skipButton: {
    borderRadius: 18,
    overflow: "hidden",
  },
  skipBlur: {
    minHeight: 38,
    paddingHorizontal: 15,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "rgba(255,255,255,0.07)",
    overflow: "hidden",
  },
  skipText: {
    color: "rgba(248,248,254,0.78)",
    fontSize: 14,
    fontWeight: "700",
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    alignItems: "stretch",
  },
  page: {
    flex: 1,
    paddingHorizontal: 22,
    paddingTop: 106,
    paddingBottom: 142,
    justifyContent: "center",
    alignItems: "center",
  },
  pageInner: {
    width: "100%",
    maxWidth: 430,
    alignItems: "center",
  },
  iconGlassOuter: {
    width: 112,
    height: 112,
    borderRadius: 56,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
    backgroundColor: "rgba(255,255,255,0.08)",
    marginBottom: 28,
  },
  iconGlassInner: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  eyebrow: {
    color: "rgba(143,240,196,0.88)",
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginBottom: 10,
  },
  title: {
    color: "#FFFFFF",
    fontSize: 31,
    lineHeight: 37,
    fontWeight: "800",
    textAlign: "center",
    maxWidth: 350,
    marginBottom: 14,
  },
  description: {
    color: "rgba(248,248,254,0.68)",
    fontSize: 16,
    lineHeight: 23,
    fontWeight: "500",
    textAlign: "center",
    maxWidth: 350,
  },
  inlinePanel: {
    width: "100%",
    marginTop: 26,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    backgroundColor: "rgba(255,255,255,0.06)",
    padding: 12,
    gap: 10,
    overflow: "hidden",
  },
  inlinePanelHint: {
    color: "rgba(248,248,254,0.48)",
    fontSize: 12,
    fontWeight: "500",
    textAlign: "center",
    marginTop: 4,
  },
  connectionStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 6,
  },
  connectionStatusText: {
    color: "rgba(248,248,254,0.88)",
    fontSize: 14,
    fontWeight: "600",
    flex: 1,
  },
  retryButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: "rgba(255,255,255,0.12)",
  },
  retryButtonText: {
    color: "#F8F8FE",
    fontSize: 13,
    fontWeight: "600",
  },
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 20,
    paddingTop: 14,
    zIndex: 12,
  },
  dots: {
    height: 18,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 7,
    marginBottom: 14,
  },
  dot: {
    height: 7,
    borderRadius: 999,
  },
  nextButton: {
    borderRadius: 18,
    overflow: "hidden",
  },
  nextBlur: {
    borderRadius: 18,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  nextGradient: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  nextText: {
    color: "#FFFFFF",
    fontSize: 17,
    fontWeight: "800",
  },
  buttonPressed: {
    opacity: 0.86,
  },
  fieldGroup: {
    gap: 7,
  },
  fieldLabel: {
    color: "rgba(248,248,254,0.56)",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.45,
    textTransform: "uppercase",
    paddingHorizontal: 2,
  },
  inputShell: {
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "rgba(255,255,255,0.07)",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    gap: 9,
  },
  inputIconWrap: {
    width: 26,
    height: 26,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.07)",
  },
  textInput: {
    flex: 1,
    minWidth: 0,
    color: "#F8F8FE",
    fontSize: 14,
    fontWeight: "600",
    paddingVertical: Platform.OS === "ios" ? 10 : 6,
  },
  toggleRow: {
    minHeight: 44,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    gap: 9,
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  rowIconWrap: {
    width: 30,
    height: 30,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.07)",
  },
  toggleLabel: {
    flex: 1,
    color: "#F8F8FE",
    fontSize: 14,
    fontWeight: "600",
  },
  modalRoot: {
    flex: 1,
    backgroundColor: "rgba(3,4,10,0.42)",
  },
  modalAvoider: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  settingsCard: {
    width: "100%",
    maxWidth: 430,
    maxHeight: "86%",
    alignSelf: "center",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.16)",
    backgroundColor: "rgba(255,255,255,0.07)",
    overflow: "hidden",
  },
  settingsHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 15,
    paddingBottom: 10,
  },
  settingsTitle: {
    color: "#FFFFFF",
    fontSize: 18,
    fontWeight: "800",
  },
  settingsSubtitle: {
    color: "rgba(248,248,254,0.52)",
    fontSize: 12,
    fontWeight: "600",
    marginTop: 2,
  },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.09)",
  },
  closeButtonPressed: {
    opacity: 0.75,
  },
  settingsScroll: {
    paddingHorizontal: 14,
    paddingBottom: 10,
    gap: 10,
  },
  sectionTitle: {
    color: "rgba(143,240,196,0.78)",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.55,
    textTransform: "uppercase",
    marginTop: 8,
  },
  secondaryButton: {
    minHeight: 42,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
  },
  secondaryButtonText: {
    color: "rgba(248,248,254,0.86)",
    fontSize: 14,
    fontWeight: "700",
  },
  applyButton: {
    marginHorizontal: 14,
    marginTop: 6,
    marginBottom: 14,
    minHeight: 48,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(143,240,196,0.2)",
    borderWidth: 1,
    borderColor: "rgba(143,240,196,0.34)",
  },
  scanButton: {
    minHeight: 48,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "rgba(90,109,255,0.18)",
    borderWidth: 1,
    borderColor: "rgba(90,109,255,0.34)",
    marginTop: 8,
  },
  scanButtonBlur: {
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    backgroundColor: "rgba(255,255,255,0.06)",
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  scanButtonText: {
    color: "#F8F8FE",
    fontSize: 14,
    fontWeight: "700",
  },
  scannerModalRoot: {
    flex: 1,
    backgroundColor: "#000",
  },
  scannerModalContainer: {
    flex: 1,
  },
  scannerCamera: {
    flex: 1,
  },
  scannerOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 40,
  },
  scannerFrame: {
    width: 240,
    height: 240,
    borderWidth: 2,
    borderColor: "#8FF0C4",
    borderRadius: 16,
    position: "relative",
  },
  scannerCorner: {
    position: "absolute",
    width: 24,
    height: 24,
    borderWidth: 3,
    borderColor: "#8FF0C4",
  },
  scannerInstruction: {
    marginTop: 24,
    color: "rgba(248,248,254,0.78)",
    fontSize: 15,
    fontWeight: "500",
    textAlign: "center",
  },
  scannerError: {
    position: "absolute",
    bottom: 100,
    left: 20,
    right: 20,
    backgroundColor: "rgba(255,147,164,0.9)",
    padding: 12,
    borderRadius: 12,
    alignItems: "center",
  },
  scannerErrorText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "600",
  },
  scannerCloseButton: {
    position: "absolute",
    top: 50,
    right: 24,
    zIndex: 10,
  },
  scannerCloseBlur: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    backgroundColor: "rgba(255,255,255,0.09)",
  },
  applyButtonText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "800",
  },
});
