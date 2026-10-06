import { RendererPreview } from "./renderer-preview";
import { GradientWord } from './gradient-word';
import { BEAUTIFUL_GRADIENT, LyricReveal, MODERN_GRADIENT, SetupBackground } from './setup-motion';
import Ionicons from "@react-native-vector-icons/ionicons";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { Image } from "expo-image";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import {
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import Reanimated, {
  Extrapolation,
  interpolate,
  FadeInUp,
  ReduceMotion,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  useReducedMotion,
  type SharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SpotifyLoginWebView } from '@/components/spotify-login-webview';

import { bridgeClient } from "@/lib/bridge-client";
import {
  extractHost,
  isPrivateIpv4,
  isValidBridgeKey,
  parseBridgeWebSocketUrl,
} from "@/lib/network";
import { useSpotifySessionStore } from "@/store/spotify-session-store";
import { usePlaybackStore } from "@/store/playback-store";
import { saveBridgeSettings } from "@/lib/bridge-settings";
import { saveMobileLyricsSettings } from "@/lib/mobile-lyrics-settings";
import {
  isTrustedSpotifyWebViewMessageUrl,
  parseBrowserEvent,
} from "@/lib/spotify-browser";
import { requestReloadSpotifyBrowser } from "@/components/lyrics/spotify-browser-fallback";
import { CameraView, useCameraPermissions } from "expo-camera";
import { MotionPressable as Pressable } from "@/components/ui/motion-pressable";
import { Design } from "@/constants/design";

function inferDefaultBridgeUrl() {
  const configuredBridgeUrl =
    process.env.EXPO_PUBLIC_BRIDGE_WS_URL?.trim() || ""; // Set EXPO_PUBLIC_BRIDGE_WS_URL or configure in Bridge Settings

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
  description: string;
}[] = [
  {
    icon: "musical-notes-outline",
    title: "KineSync",
    description:
      "A modern, beautiful mobile app for rendering syllable-synced lyrics synced with your Spotify playback.",
  },
  {
    icon: "color-palette-outline",
    title: "Adjust the Appearance",
    description: "Choose how your lyrics look.",
  },
  {
    icon: "link-outline",
    title: "Connect",
    description: "Choose a playback source.",
  },
];

function GlassIcon({ icon, active }: { icon: IoniconName; active?: boolean }) {
  return (
    <BlurView intensity={34} tint="light" style={styles.iconGlassOuter}>
      <LinearGradient
        colors={[
          "rgba(255,255,255,0.24)",
          active ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.06)",
        ]}
        start={{ x: 0.15, y: 0 }}
        end={{ x: 0.9, y: 1 }}
        style={styles.iconGlassInner}
      >
        <View style={styles.iconCutout}>
          <Ionicons name={icon} size={30} color="#232733" />
        </View>
      </LinearGradient>
    </BlurView>
  );
}

function StepPage({
  index,
  itemWidth,
  scrollX,
  active,
  landscape,
  children,
}: {
  index: number;
  itemWidth: number;
  scrollX: SharedValue<number>;
  active: boolean;
  landscape: boolean;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  const animatedStyle = useAnimatedStyle(() => {
    if (reduceMotion)
      return { opacity: 1, transform: [{ translateX: 0 }] };
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
      ],
    };
  }, [index, itemWidth]);

  return (
    <ScrollView
      style={{ width: itemWidth }}
      aria-hidden={!active}
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? "auto" : "no-hide-descendants"}
      contentContainerStyle={[
        styles.page,
        {
          paddingTop: insets.top + (landscape ? 20 : index === 1 ? 32 : 64),
          paddingBottom: insets.bottom + (landscape ? 94 : 110),
          paddingLeft: Math.max(22, insets.left + 22),
          paddingRight: Math.max(22, insets.right + 22),
        },
      ]}
      showsVerticalScrollIndicator={false}
      nestedScrollEnabled
    >
      <Reanimated.View style={[styles.pageInner, landscape && styles.pageInnerLandscape, animatedStyle]}>
        {children}
      </Reanimated.View>
    </ScrollView>
  );
}

function ChoiceRow({
  icon,
  label,
  hint,
  onPress,
}: {
  icon: IoniconName;
  label: string;
  hint: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.choiceRow,
        pressed && styles.buttonPressed,
      ]}
    >
      <View style={styles.rowIconWrap}>
        <Ionicons name={icon} size={18} color="#232733" />
      </View>
      <View style={styles.choiceCopy}>
        <Text style={styles.choiceLabel}>{label}</Text>
        <Text style={styles.choiceHint}>{hint}</Text>
      </View>
      <Ionicons
        name="chevron-forward"
        size={16}
        color="rgba(248,248,254,0.45)"
      />
    </Pressable>
  );
}

function OnboardingScreen({ onDismiss }: { onDismiss: () => void }) {
  const reduceMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const landscape = windowWidth > windowHeight;
  const contentWidth = Math.min(1040, Math.max(1, windowWidth - insets.left - insets.right - 44));
  const columnLayout = landscape && contentWidth >= 520;
  // Reserve only the space needed by the two-line heading so both previews
  // can sit beside it even on narrower landscape phones.
  const threeColumns = columnLayout;
  const appearanceTitleWidth = columnLayout
    ? 180
    : Math.min(430, contentWidth) - 44;
  const itemWidth = Math.max(1, windowWidth);
  const scrollX = useSharedValue(0);
  const [step, setStep] = useState(0);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanError, setScanError] = useState("");
  const [scanCompleted, setScanCompleted] = useState(false);
  const [playbackMode, setPlaybackMode] = useState<
    "unset" | "desktop" | "phone"
  >("unset");
  const [loginOpen, setLoginOpen] = useState(false);
  const spotifySignedIn = useSpotifySessionStore((s) => s.signedIn);
  const setSpotifySignedIn = useSpotifySessionStore((s) => s.setSignedIn);
  const spotifyLoginCompletedRef = useRef(false);
  const scrollRef = useRef<any>(null);
  const stepRef = useRef(step);
  stepRef.current = step;

  useEffect(() => {
    // Preserve the selected page on rotation or split-screen resizing.
    const offset = stepRef.current * itemWidth;
    scrollX.value = offset;
    scrollRef.current?.scrollTo({ x: offset, animated: false });
  }, [itemWidth, scrollX]);

  const connectionStatus = usePlaybackStore((s) => s.connectionStatus);
  const setServerUrlStore = usePlaybackStore((s) => s.setServerUrl);
  const setHandshakeKeyStore = usePlaybackStore((s) => s.setHandshakeKey);
  const setPlaybackModeStore = usePlaybackStore((s) => s.setPlaybackMode);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  const completeSpotifySignIn = useCallback(() => {
    if (spotifyLoginCompletedRef.current) return;
    spotifyLoginCompletedRef.current = true;
    setSpotifySignedIn(true);
    setLoginOpen(false);
    requestReloadSpotifyBrowser();
  }, [setSpotifySignedIn]);

  const openSpotifyLogin = useCallback(() => {
    spotifyLoginCompletedRef.current = false;
    setLoginOpen(true);
  }, []);

  const isLastStep = step === ONBOARDING_STEPS.length - 1;

  const scanFailTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scanHandled = useRef(false);

  const handleBarcodeScanned = useCallback(
    ({ data }: { data: string }) => {
      if (scanHandled.current) return;
      try {
        const parsed = JSON.parse(data);
        const bridgeUrl = parseBridgeWebSocketUrl(parsed?.u);
        const bridgeKey = String(parsed?.k || "").trim();
        if (bridgeUrl && isValidBridgeKey(bridgeKey)) {
          scanHandled.current = true;
          if (scanFailTimer.current) {
            clearTimeout(scanFailTimer.current);
            scanFailTimer.current = null;
          }
          setScanError("");
          void saveBridgeSettings({
            serverUrl: bridgeUrl,
            handshakeKey: bridgeKey,
            playbackMode: "desktop",
            onboardingCompleted: true,
          })
            .then((saved) => {
              setServerUrlStore(saved.serverUrl);
              setHandshakeKeyStore(saved.handshakeKey);
              setPlaybackModeStore("desktop");
              setScanCompleted(true);
              setScannerOpen(false);
              bridgeClient.reconnectNow();
            })
            .catch((error) => {
              scanHandled.current = false;
              setScanError(
                error instanceof Error
                  ? error.message
                  : "Could not save bridge settings.",
              );
            });
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
    [setServerUrlStore, setHandshakeKeyStore, setPlaybackModeStore],
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

  const skipAnimatedStyle = useAnimatedStyle(() => ({
    width: interpolate(scrollX.value / itemWidth, [0, 0.2, 1], [86, 86, 0], Extrapolation.CLAMP),
    marginRight: interpolate(scrollX.value / itemWidth, [0, 0.2, 1], [12, 12, 0], Extrapolation.CLAMP),
    opacity: interpolate(scrollX.value / itemWidth, [0, 0.18], [1, 0], Extrapolation.CLAMP),
  }));

  const footerLabel = useMemo(
    () => (isLastStep ? "Done" : step === 0 ? "Start Setup" : "Continue"),
    [isLastStep, step],
  );

  const persistBridgeSettings = useCallback(() => {
    if (playbackMode === "phone") {
      // Keep the empty-state login action visible until a session is verified.
      setPlaybackModeStore("mobile");
      bridgeClient.disconnect();
      setServerUrlStore("");
      setHandshakeKeyStore("");
      void saveBridgeSettings({
        serverUrl: "",
        handshakeKey: "",
        playbackMode: "mobile",
        onboardingCompleted: true,
      });

      return;
    }
    setPlaybackModeStore("desktop");
    const state = usePlaybackStore.getState();
    if (!state.serverUrl) {
      setServerUrlStore(inferDefaultBridgeUrl());
    }
    bridgeClient.reconnectNow();
    void saveBridgeSettings({
      playbackMode: "desktop",
      onboardingCompleted: true,
    });
  }, [
    playbackMode,
    setHandshakeKeyStore,
    setPlaybackModeStore,
    setServerUrlStore,
  ]);

  const handleNext = useCallback(() => {
    if (isLastStep) {
      persistBridgeSettings();
      onDismiss();
      return;
    }
    const nextStep = Math.min(step + 1, ONBOARDING_STEPS.length - 1);
    setStep(nextStep);
    // Scroll events are the single source of truth for the page animation.
    scrollRef.current?.scrollTo({
      x: nextStep * itemWidth,
      animated: !reduceMotion,
    });
  }, [
    isLastStep,
    itemWidth,
    onDismiss,
    persistBridgeSettings,
    reduceMotion,
    step,
  ]);

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
        <SetupBackground />

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
              active={index === step}
              landscape={landscape}
            >
              <View style={[index === 0 ? styles.welcomeRow : styles.stepLayout, columnLayout && styles.stepLandscape, index === 1 && threeColumns && styles.appearanceLayoutLandscape]}>
              <View style={[index === 0 ? styles.welcomeArtColumn : styles.stepHeading, columnLayout && styles.headingLandscape, index === 1 && threeColumns && styles.appearanceHeadingLandscape]}>
              {index === 0 ? (
                  <Image source={require("@/assets/images/R.png")} style={[styles.welcomeLogo, landscape && styles.welcomeLogoLandscape]} accessibilityLabel="KineSync logo" />
              ) : (
                <>
                  {index === 2 && <GlassIcon icon={stepData.icon} active={index === step} />}
                  <View style={index === 1 ? [styles.appearanceHeading, columnLayout && styles.appearanceHeadingStacked] : undefined}>
                    {index === 1 && <View style={styles.appearanceIcon}><Ionicons name="color-palette" size={21} color="#232733" /></View>}
                    <LyricReveal text={index === 1 && columnLayout ? 'Adjust the\nAppearance' : stepData.title} active={index === step} style={[styles.title, index === 1 && styles.appearanceTitle, index === 1 && { maxWidth: Math.max(1, appearanceTitleWidth) }]} />
                  </View>
                  <Text style={[styles.description, index === 1 && styles.appearanceDescription]}>{stepData.description}</Text>
                </>
              )}
              </View>
              <View style={[styles.stepBody, index === 0 && styles.welcomeCopy, columnLayout && styles.bodyLandscape, index === 1 && threeColumns && styles.appearanceBodyLandscape]}>
              {index === 0 && <>
                <LyricReveal text={stepData.title} active={step === 0} style={styles.welcomeTitle} />
                <View accessible accessibilityLabel={stepData.description} style={styles.welcomeDescription}>
                  {stepData.description.split(' ').map((word, wordIndex) => (
                    <View key={wordIndex} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                      {word === 'modern,' || word === 'beautiful' ? (
                        <GradientWord text={word} active={step === 0} colors={word === 'modern,' ? MODERN_GRADIENT : BEAUTIFUL_GRADIENT} style={styles.descriptionWord} />
                      ) : <Text style={styles.descriptionWord}>{word}</Text>}
                    </View>
                  ))}
                </View>
              </>}

              {index === 1 ? <RendererPreview active={step === 1} sideBySide={threeColumns} /> : null}

              {index === 2 && playbackMode === "unset" ? (
                <BlurView intensity={30} tint="dark" style={[styles.inlinePanel, landscape && styles.inlinePanelLandscape]}>
                  <ChoiceRow
                    icon="desktop-outline"
                    label="Use a Desktop Bridge"
                    hint="Tightest sync. Needs the PC app running."
                    onPress={() => setPlaybackMode("desktop")}
                  />
                  <ChoiceRow
                    icon="phone-portrait-outline"
                    label="Use this phone only"
                    hint="Plays Spotify inside KineSync. No PC needed."
                    onPress={() => setPlaybackMode("phone")}
                  />
                </BlurView>
              ) : null}

              {index === 2 && playbackMode === "phone" ? (
                <BlurView intensity={30} tint="dark" style={[styles.inlinePanel, landscape && styles.inlinePanelLandscape]}>
                  {spotifySignedIn ? (
                    <View style={styles.connectionStatusRow}>
                      <Ionicons
                        name="checkmark-circle"
                        size={20}
                        color="#8FF0C4"
                      />
                      <Text style={styles.connectionStatusText}>
                        Signed in to Spotify on this phone
                      </Text>
                    </View>
                  ) : (
                    <>
                      <Pressable
                        style={({ pressed }) => [
                          styles.scanButton,
                          pressed && styles.buttonPressed,
                        ]}
                        onPress={openSpotifyLogin}
                      >
                        <BlurView
                          intensity={30}
                          tint="light"
                          style={styles.scanButtonBlur}
                        >
                          <Ionicons
                            name="log-in-outline"
                            size={20}
                            color="#F8F8FE"
                          />
                          <Text style={styles.scanButtonText}>
                            Sign in to Spotify
                          </Text>
                        </BlurView>
                      </Pressable>
                      <Text style={styles.inlinePanelHint}>
                        Use your email and password — Google and Apple sign-in
                        are blocked inside embedded browsers.
                      </Text>
                    </>
                  )}
                  <Pressable
                    hitSlop={8}
                    onPress={() => setPlaybackMode("unset")}
                  >
                    <Text style={styles.inlinePanelHint}>
                      Use a Desktop Bridge instead
                    </Text>
                  </Pressable>
                </BlurView>
              ) : null}

              {index === 2 && playbackMode === "desktop" ? (
                <BlurView intensity={30} tint="dark" style={[styles.inlinePanel, landscape && styles.inlinePanelLandscape]}>
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
                  <Pressable
                    hitSlop={8}
                    onPress={() => setPlaybackMode("unset")}
                  >
                    <Text style={styles.inlinePanelHint}>
                      No PC? Use this phone instead
                    </Text>
                  </Pressable>
                </BlurView>
              ) : null}
              </View>
              </View>
            </StepPage>
          ))}
        </Reanimated.ScrollView>

        <View style={[styles.footer, { paddingBottom: insets.bottom + (landscape ? 10 : 16), paddingLeft: insets.left + 22, paddingRight: insets.right + 22 }]}>
          <LinearGradient
            pointerEvents="none"
            colors={["rgba(9,12,19,0)", Design.background, Design.background]}
            locations={[0, 0.3, 1]}
            style={StyleSheet.absoluteFill}
          />
          <View style={[styles.nextWrap, landscape && styles.nextWrapLandscape]}>
            <Reanimated.View style={[styles.footerSkip, skipAnimatedStyle]} pointerEvents={step === 0 ? 'auto' : 'none'} accessibilityElementsHidden={step !== 0} importantForAccessibility={step === 0 ? 'auto' : 'no-hide-descendants'}>
              <Pressable onPress={handleSkip} style={styles.skipButton}>
                <BlurView intensity={24} tint="light" style={styles.skipBlur}>
                  <Text numberOfLines={1} style={styles.skipText}>Skip</Text>
                </BlurView>
              </Pressable>
            </Reanimated.View>
            <Pressable onPress={handleNext} style={styles.nextButton}>
              <BlurView intensity={36} tint="light" style={styles.nextBlur}>
                <LinearGradient colors={["rgba(168,240,207,0.23)", "rgba(168,240,207,0.09)"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.nextGradient}>
                  <Reanimated.View key={footerLabel} entering={FadeInUp.springify().damping(18).stiffness(240).reduceMotion(ReduceMotion.System)} style={styles.nextLabel}>
                    <Text style={styles.nextText}>{footerLabel}</Text>
                    <Ionicons name={isLastStep ? "checkmark-circle" : "arrow-forward-circle"} size={23} color={Design.accent} />
                  </Reanimated.View>
                </LinearGradient>
              </BlurView>
            </Pressable>
          </View>
        </View>

        {/* Spotify sign-in — cookies are shared with the background player */}
        <Modal
          animationType="slide"
          visible={loginOpen}
          onRequestClose={() => setLoginOpen(false)}
        >
          <GestureHandlerRootView style={styles.loginModalRoot}>
            <View style={[styles.loginHeader, { paddingTop: insets.top + 10 }]}>
              <Text style={styles.loginTitle}>Sign in to Spotify</Text>
              <Pressable
                hitSlop={10}
                onPress={() => setLoginOpen(false)}
                style={styles.closeButton}
              >
                <Ionicons name="close" size={20} color="#F8F8FE" />
              </Pressable>
            </View>
            <SpotifyLoginWebView
              onMessage={({ nativeEvent }) => {
                if (!isTrustedSpotifyWebViewMessageUrl(nativeEvent.url || ""))
                  return;
                const event = parseBrowserEvent(nativeEvent.data);
                if (event?.type === "spotifyToken" && event.token) {
                  void saveMobileLyricsSettings({
                    spotifyWebToken: event.token,
                    spotifyWebTokenExpiresAt: Number(event.expiresAt || 0),
                  });
                }
                if (event?.type === "signedIn" && event.signedIn) {
                  completeSpotifySignIn();
                }
              }}
            />
          </GestureHandlerRootView>
        </Modal>

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
  skipButton: {
    width: 86,
    borderRadius: 18,
    overflow: "hidden",
  },
  skipBlur: {
    minHeight: 58,
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
    flexGrow: 1,
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
  pageInnerLandscape: { maxWidth: 1040 },
  stepLayout: { width: '100%', alignItems: 'center' },
  stepLandscape: { flexDirection: 'row', alignItems: 'center', gap: 32 },
  stepHeading: { alignItems: 'center', width: '100%' },
  welcomeArtColumn: { alignItems: 'center' },
  headingLandscape: { flex: 0.85, width: undefined, minWidth: 0 },
  appearanceLayoutLandscape: { gap: 20 },
  appearanceHeadingLandscape: { flex: 0, flexShrink: 0, width: 180 },
  appearanceBodyLandscape: { flex: 1 },
  stepBody: { width: '100%' },
  bodyLandscape: { flex: 1.15, width: undefined, minWidth: 0 },
  inlinePanelLandscape: { marginTop: 0 },
  welcomeLogoLandscape: { width: 120, height: 120, borderRadius: 32 },
  nextWrapLandscape: { maxWidth: 1040 },
  iconGlassOuter: {
    width: 80,
    height: 80,
    borderRadius: 40,
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
  iconCutout: { width: 52, height: 52, borderRadius: 26, backgroundColor: 'rgba(245,247,252,0.9)', alignItems: 'center', justifyContent: 'center' },
  title: {
    color: "#FFFFFF",
    fontSize: 38,
    lineHeight: 43,
    letterSpacing: -1.5,
    fontWeight: "800",
    textAlign: "center",
    maxWidth: 350,
    marginBottom: 14,
  },
  description: {
    color: "rgba(248,248,254,0.68)",
    fontSize: 16,
    lineHeight: 23,
    fontWeight: "400",
    textAlign: "center",
    maxWidth: 350,
  },
  appearanceHeading: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  appearanceHeadingStacked: { flexDirection: 'column', gap: 10 },
  appearanceIcon: { width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(245,247,252,0.9)', alignItems: 'center', justifyContent: 'center' },
  appearanceTitle: {
    fontSize: 24,
    lineHeight: 30,
    marginTop: 4,
    marginBottom: 6,
  },
  appearanceDescription: {
    marginBottom: 20,
  },
  inlinePanel: {
    width: "100%",
    marginTop: 26,
    borderRadius: 24,
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
  nextButton: {
    flex: 1,
    borderRadius: 18,
    overflow: "hidden",
  },
  nextBlur: {
    borderRadius: 18,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(196,244,219,0.3)",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  nextGradient: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  nextText: {
    color: '#E4F8EE',
    fontSize: 17,
    fontWeight: "600",
  },
  buttonPressed: {
    opacity: 0.86,
  },
  welcomeLogo: {
    width: 88,
    height: 88,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: Design.border,
  },
  nextWrap: { width: "100%", maxWidth: 440, alignSelf: "center", flexDirection: 'row', alignItems: 'center' },
  nextLabel: { flexDirection: 'row', gap: 10, alignItems: 'center', justifyContent: 'center' },
  footerSkip: { overflow: 'hidden' },
  welcomeRow: { width: '100%', flexDirection: 'row', gap: 20, alignItems: 'center' },
  welcomeCopy: { flex: 1, minWidth: 0, gap: 12 },
  welcomeTitle: { color: '#FFFFFF', fontSize: 34, lineHeight: 42, letterSpacing: -1.1, fontWeight: '800' },
  welcomeDescription: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 4 },
  descriptionWord: { color: 'rgba(248,248,254,0.72)', fontSize: 15, lineHeight: 23 },
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
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(245,247,252,0.88)",
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
  choiceRow: {
    minHeight: 56,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    gap: 10,
    backgroundColor: "rgba(255,255,255,0.05)",
  },
  choiceCopy: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  choiceLabel: {
    color: "#F8F8FE",
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "600",
  },
  choiceHint: {
    color: "rgba(248,248,254,0.5)",
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "500",
  },
  loginModalRoot: {
    flex: 1,
    backgroundColor: "#090A11",
  },
  loginHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingBottom: 12,
  },
  loginTitle: {
    color: "#FFFFFF",
    fontSize: 17,
    fontWeight: "800",
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
    ...StyleSheet.absoluteFill,
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
