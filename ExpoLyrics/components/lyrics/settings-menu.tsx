import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ComponentProps, ReactNode } from "react";
import { getLyricsTimingLabel } from "@/lib/lyrics-timing";
import type { LyricsSourcePreference } from "@/lib/lyrics-sync";
import { saveCurrentTrackToVault } from "@/lib/lyrics-sync";
import { usePlaybackStore } from "@/store/playback-store";
import type { ConnectionStatus } from "@/types/bridge";
import { CameraView, useCameraPermissions } from "expo-camera";
import { saveBridgeSettings } from "@/lib/bridge-settings";
import { bridgeClient } from "@/lib/bridge-client";

type IoniconName = ComponentProps<typeof Ionicons>["name"];

const MODAL_SUPPORTED_ORIENTATIONS = [
  "portrait",
  "portrait-upside-down",
  "landscape",
  "landscape-left",
  "landscape-right",
] as ("portrait" | "portrait-upside-down" | "landscape" | "landscape-left" | "landscape-right")[];

type SettingsMenuProps = {
  open: boolean;
  landscapeAnchorWidth?: number;
  onClose: () => void;
  onReconnectBridge: () => void;
  onRefetchLyrics: () => void;
  onRefetchLyricsFromSource: (source: LyricsSourcePreference) => void;
  onOpenBridgeSettings: () => void;
  onOpenButtonTutorial: () => void;
  playbackTapToSeek: boolean;
  onTogglePlaybackTapToSeek: (value: boolean) => void;
  hidePlaybackStatusBar: boolean;
  onToggleHidePlaybackStatusBar: (value: boolean) => void;
  autoHidePlaybackControls: boolean;
  onToggleAutoHidePlaybackControls: (value: boolean) => void;
  showTranslatedText: boolean;
  onToggleShowTranslatedText: (value: boolean) => void;
  connectionStatus: ConnectionStatus;
  latencyMs: number;
  errorMessage: string;
};

type SourceOption = {
  id: LyricsSourcePreference;
  label: string;
  icon: IoniconName;
};

const SOURCE_OPTIONS: SourceOption[] = [
  { id: "auto", label: "Auto", icon: "sparkles" },
  { id: "local-vault", label: "Local", icon: "archive" },
  { id: "kugou", label: "Kugou", icon: "mic" },
  { id: "netease", label: "Netease", icon: "cloud" },
  { id: "qq-direct", label: "QQ", icon: "musical-note" },
  { id: "musixmatch", label: "Musixmatch", icon: "key" },
  { id: "lrclib", label: "LrcLib", icon: "library" },
  { id: "spicy-lyrics", label: "Spicy", icon: "flame" },
];

function inferActiveSource(lyricsSource: string): LyricsSourcePreference {
  const source = String(lyricsSource || "").toLowerCase();
  if (source.includes("local-vault")) {
    return "local-vault";
  }
  if (source.includes("spicy")) {
    return "spicy-lyrics";
  }
  if (source.includes("musixmatch")) {
    return "musixmatch";
  }
  if (source.includes("kugou")) {
    return "kugou";
  }
  if (source.includes("netease")) {
    return "netease";
  }
  if (source.includes("lrclib")) {
    return "lrclib";
  }
  if (source.includes("qq")) {
    return "qq-direct";
  }
  return "auto";
}

function getConnectionDescriptor(status: ConnectionStatus, latencyMs: number) {
  if (status !== "connected") {
    return { label: "Offline", color: "#FF93A4" };
  }
  if (latencyMs > 210) {
    return { label: "Connected", color: "#FFD287" };
  }
  if (latencyMs > 120) {
    return { label: "Connected", color: "#FFFFFF" };
  }
  return { label: "Connected", color: "#8FF0C4" };
}

function MenuSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function MenuAction({
  icon,
  label,
  onPress,
  disabled = false,
  showChevron = false,
}: {
  icon: IoniconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  showChevron?: boolean;
}) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.row,
        disabled && styles.rowDisabled,
        pressed && !disabled && styles.rowPressed,
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      <View style={styles.rowIconWrap}>
        <Ionicons name={icon} size={17} color="rgba(248,248,254,0.88)" />
      </View>
      <Text style={styles.rowLabel}>{label}</Text>
      {showChevron && (
        <Ionicons
          name="chevron-forward"
          size={15}
          color="rgba(248,248,254,0.34)"
        />
      )}
    </Pressable>
  );
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
  onChange: (next: boolean) => void;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowIconWrap}>
        <Ionicons name={icon} size={17} color="rgba(248,248,254,0.88)" />
      </View>
      <Text style={styles.rowLabel}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: "rgba(255,255,255,0.16)", true: "rgba(143,240,196,0.42)" }}
        thumbColor="#F8F8FE"
      />
    </View>
  );
}

function SourceChip({
  icon,
  label,
  active,
  onPress,
  compact = false,
}: {
  icon: IoniconName;
  label: string;
  active: boolean;
  onPress: () => void;
  compact?: boolean;
}) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.sourceChip,
        compact && styles.sourceChipLandscape,
        active && styles.sourceChipActive,
        pressed && styles.sourceChipPressed,
      ]}
      onPress={onPress}
    >
      <Ionicons
        name={icon}
        size={15}
        color={active ? "#8FF0C4" : "rgba(248,248,254,0.72)"}
      />
      <Text style={[styles.sourceChipLabel, active && styles.sourceChipLabelActive]}>
        {label}
      </Text>
    </Pressable>
  );
}

function StatusPanel({
  connectionStatus,
  latencyMs,
  timingLabel,
  sourceLabel,
  statusMessage,
  errorMessage,
  bridgePipelineMs,
  bridgeForwardBiasMs,
  bridgeNativeExtrapolation,
}: {
  connectionStatus: ConnectionStatus;
  latencyMs: number;
  timingLabel: string;
  sourceLabel: string;
  statusMessage: string;
  errorMessage: string;
  bridgePipelineMs: number;
  bridgeForwardBiasMs: number;
  bridgeNativeExtrapolation: boolean;
}) {
  const connection = getConnectionDescriptor(connectionStatus, latencyMs);
  const ping = Math.max(0, Math.round(latencyMs));

  return (
    <View style={styles.statusPanel}>
      <View style={styles.statusTopRow}>
        <View style={styles.statusConnection}>
          <View style={[styles.statusDot, { backgroundColor: connection.color }]} />
          <Text style={styles.statusConnectionText}>{connection.label}</Text>
        </View>
        <View style={styles.statusPing}>
          <Ionicons name="pulse" size={12} color="rgba(248,248,254,0.48)" />
          <Text style={styles.statusPingText}>{ping} ms</Text>
        </View>
      </View>

      <View style={styles.statusMetaRow}>
        <Text style={styles.statusMetaText} numberOfLines={1}>
          {sourceLabel || "No source"}
        </Text>
        <Text style={styles.statusMetaDivider}>·</Text>
        <Text style={styles.statusMetaText}>{timingLabel}</Text>
      </View>

      {connectionStatus === "connected" && (
        <Text style={styles.statusBridgeTiming} numberOfLines={2}>
          Bridge pipeline {Math.max(0, bridgePipelineMs)} ms · forward bias{" "}
          {Math.max(0, bridgeForwardBiasMs)} ms · native extrap{" "}
          {bridgeNativeExtrapolation ? "yes" : "no"}
        </Text>
      )}

      {!!statusMessage && (
        <Text style={styles.statusMessage} numberOfLines={2}>
          {statusMessage}
        </Text>
      )}

      {!!errorMessage && (
        <Text style={styles.statusError} numberOfLines={2}>
          {errorMessage}
        </Text>
      )}
    </View>
  );
}

export const SettingsMenu = memo(function SettingsMenu({
  open,
  landscapeAnchorWidth,
  onClose,
  onReconnectBridge,
  onRefetchLyrics,
  onRefetchLyricsFromSource,
  onOpenBridgeSettings,
  onOpenButtonTutorial,
  playbackTapToSeek,
  onTogglePlaybackTapToSeek,
  hidePlaybackStatusBar,
  onToggleHidePlaybackStatusBar,
  autoHidePlaybackControls,
  onToggleAutoHidePlaybackControls,
  showTranslatedText,
  onToggleShowTranslatedText,
  connectionStatus,
  latencyMs,
  errorMessage,
}: SettingsMenuProps) {
  const lyrics = usePlaybackStore((state) => state.lyrics);
  const lyricsSource = usePlaybackStore((state) => state.lyricsSource);
  const lyricsStatusMessage = usePlaybackStore(
    (state) => state.lyricsStatusMessage,
  );
  const lyricsTimingLabel = useMemo(
    () => getLyricsTimingLabel(lyrics, lyricsSource),
    [lyrics, lyricsSource],
  );
  const bridgeTiming = usePlaybackStore((state) => state.bridgeTiming);
  const activeSource = useMemo(
    () => inferActiveSource(lyricsSource),
    [lyricsSource],
  );
  const [vaultIncludeTranslations, setVaultIncludeTranslations] = useState(false);
  const [vaultSaving, setVaultSaving] = useState(false);
  const hasLyrics = lyrics.length > 0;
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanError, setScanError] = useState('');
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  const scanFailTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scanHandled = useRef(false);

  const handleBarcodeScanned = useCallback(({ data }: { data: string }) => {
    if (scanHandled.current) return;
    try {
      const parsed = JSON.parse(data);
      if (parsed.u && parsed.k) {
        scanHandled.current = true;
        if (scanFailTimer.current) { clearTimeout(scanFailTimer.current); scanFailTimer.current = null; }
        setScanError('');
        usePlaybackStore.getState().setServerUrl(parsed.u);
        usePlaybackStore.getState().setHandshakeKey(parsed.k);
        saveBridgeSettings({ serverUrl: parsed.u, handshakeKey: parsed.k }).catch(() => {});
        bridgeClient.reconnectNow();
        setScannerOpen(false);
        return;
      }
    } catch {}
    if (!scanFailTimer.current) {
      scanFailTimer.current = setTimeout(() => {
        setScanError('No valid KineSync QR code found');
        scanFailTimer.current = null;
      }, 5000);
    }
  }, []);

  const openScanner = async () => {
    scanHandled.current = false;
    if (cameraPermission?.granted === true) {
      onClose();
      setTimeout(() => setScannerOpen(true), 350);
      return;
    }
    const { status } = await requestCameraPermission();
    if (status === 'granted') {
      onClose();
      setTimeout(() => setScannerOpen(true), 350);
    } else {
      setScanError('Camera permission required to scan QR codes');
      setTimeout(() => setScanError(''), 3000);
    }
  };

  useEffect(() => {
    if (!open) {
      setVaultSaving(false);
    }
  }, [open]);

  useEffect(() => {
    if (
      vaultSaving &&
      /saved \\d+ lines to local vault/i.test(lyricsStatusMessage)
    ) {
      setVaultSaving(false);
    }
  }, [vaultSaving, lyricsStatusMessage]);

  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const isLandscape = width > height;
  const landscapeOverlayStyle = isLandscape
    ? {
        paddingTop: Math.max(insets.top, 12),
        paddingBottom: Math.max(insets.bottom, 12),
        paddingLeft: landscapeAnchorWidth ?? Math.max(insets.left, 12),
        paddingRight: Math.max(insets.right, 12),
      }
    : null;

  return (
    <>
    <Modal
      transparent
      animationType="fade"
      visible={open}
      onRequestClose={onClose}
      supportedOrientations={MODAL_SUPPORTED_ORIENTATIONS}
    >
      <GestureHandlerRootView
        style={[
          styles.overlay,
          isLandscape && styles.overlayLandscape,
          landscapeOverlayStyle,
        ]}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <BlurView
          intensity={34}
          tint="dark"
          style={[styles.card, isLandscape && styles.cardLandscape]}
        >
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Settings</Text>
            <Pressable
              onPress={onClose}
              hitSlop={10}
              style={({ pressed }) => [
                styles.headerClose,
                pressed && styles.headerClosePressed,
              ]}
            >
              <Ionicons name="close" size={18} color="rgba(248,248,254,0.78)" />
            </Pressable>
          </View>

          <ScrollView
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            <MenuSection title="Display">
              <ToggleRow
                icon="hand-left"
                label="Tap line to seek"
                value={playbackTapToSeek}
                onChange={onTogglePlaybackTapToSeek}
              />
              <ToggleRow
                icon="eye-off"
                label="Hide status bar"
                value={hidePlaybackStatusBar}
                onChange={onToggleHidePlaybackStatusBar}
              />
              <ToggleRow
                icon="eye"
                label="Auto-hide controls"
                value={autoHidePlaybackControls}
                onChange={onToggleAutoHidePlaybackControls}
              />
              <ToggleRow
                icon="language"
                label="Show translations"
                value={showTranslatedText}
                onChange={onToggleShowTranslatedText}
              />
            </MenuSection>

            <MenuSection title="Lyrics">
              <MenuAction
                icon="refresh"
                label="Fetch new lyrics"
                onPress={onRefetchLyrics}
              />
              <ToggleRow
                icon="language"
                label="Include translations when saving to vault"
                value={vaultIncludeTranslations}
                onChange={setVaultIncludeTranslations}
              />
              <MenuAction
                icon="archive"
                label={vaultSaving ? "Saving to local vault..." : "Save to local vault"}
                onPress={() => {
                  if (vaultSaving || !hasLyrics) {
                    return;
                  }
                  setVaultSaving(true);
                  void (async () => {
                    try {
                      await saveCurrentTrackToVault({
                        includeTranslations: vaultIncludeTranslations,
                      });
                      onClose();
                    } catch (error) {
                      usePlaybackStore
                        .getState()
                        .setLyricsStatusMessage(
                          error instanceof Error
                            ? error.message
                            : String(error),
                        );
                    } finally {
                      setVaultSaving(false);
                    }
                  })();
                }}
                disabled={!hasLyrics || vaultSaving}
              />
              <View
                style={[
                  styles.sourceGrid,
                  isLandscape && styles.sourceGridLandscape,
                ]}
              >
                {SOURCE_OPTIONS.map((option) => (
                  <SourceChip
                    key={option.id}
                    icon={option.icon}
                    label={option.label}
                    active={activeSource === option.id}
                    onPress={() => onRefetchLyricsFromSource(option.id)}
                    compact={isLandscape}
                  />
                ))}
              </View>
            </MenuSection>

            <MenuSection title="Bridge">
              <MenuAction
                icon="sync"
                label="Reconnect"
                onPress={onReconnectBridge}
              />
              <MenuAction
                icon="settings-outline"
                label="Bridge settings"
                onPress={onOpenBridgeSettings}
                showChevron
              />
              <MenuAction
                icon="qr-code-outline"
                label="Scan QR Code from Desktop"
                onPress={openScanner}
                showChevron
              />
            </MenuSection>

            <MenuSection title="Help">
              <MenuAction
                icon="help-circle-outline"
                label="Button tutorial"
                onPress={onOpenButtonTutorial}
                showChevron
              />
            </MenuSection>

            <MenuSection title="Status">
              <StatusPanel
                connectionStatus={connectionStatus}
                latencyMs={latencyMs}
                timingLabel={lyricsTimingLabel}
                sourceLabel={lyricsSource}
                statusMessage={lyricsStatusMessage}
                errorMessage={errorMessage}
                bridgePipelineMs={Number(bridgeTiming.measuredPipelineMs || 0)}
                bridgeForwardBiasMs={Number(bridgeTiming.estimatedForwardBiasMs || 0)}
                bridgeNativeExtrapolation={Boolean(bridgeTiming.nativeExtrapolationEnabled)}
              />
            </MenuSection>
          </ScrollView>
        </BlurView>
      </GestureHandlerRootView>
    </Modal>

    {/* QR Code Scanner Modal */}
    <Modal
      animationType="slide"
      visible={scannerOpen}
      onRequestClose={() => setScannerOpen(false)}
      supportedOrientations={MODAL_SUPPORTED_ORIENTATIONS}
    >
      <GestureHandlerRootView style={styles.scannerModalRoot}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setScannerOpen(false)} />
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
            <BlurView intensity={34} tint="dark" style={styles.scannerCloseBlur}>
              <Ionicons name="close" size={20} color="#F8F8FE" />
            </BlurView>
          </Pressable>
        </View>
      </GestureHandlerRootView>
    </Modal>
    </>
  );
});

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "flex-start",
    paddingTop: 86,
    paddingHorizontal: 14,
    backgroundColor: "rgba(3,4,10,0.34)",
  },
  overlayLandscape: {
    flexDirection: "row",
    justifyContent: "flex-start",
    alignItems: "stretch",
    gap: 12,
  },
  card: {
    marginLeft: "auto",
    width: 306,
    maxHeight: "78%",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.16)",
    overflow: "hidden",
  },
  cardLandscape: {
    marginLeft: 0,
    width: "46%",
    minWidth: 300,
    maxWidth: 440,
    maxHeight: "100%",
    flexShrink: 0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 6,
  },
  headerTitle: {
    color: "#F8F8FE",
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
  headerClose: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  headerClosePressed: {
    backgroundColor: "rgba(255,255,255,0.14)",
  },
  scrollContent: {
    paddingBottom: 12,
  },
  section: {
    paddingHorizontal: 10,
    paddingBottom: 8,
  },
  sectionTitle: {
    color: "rgba(248,248,254,0.56)",
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.35,
    textTransform: "uppercase",
    marginBottom: 4,
    marginTop: 4,
    paddingHorizontal: 4,
  },
  row: {
    minHeight: 42,
    borderRadius: 10,
    paddingHorizontal: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  rowPressed: {
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  rowDisabled: {
    opacity: 0.48,
  },
  rowIconWrap: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.06)",
    marginRight: 8,
  },
  rowLabel: {
    color: "#F8F8FE",
    fontSize: 14,
    fontWeight: "500",
    flex: 1,
    paddingRight: 8,
  },
  sourceGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 4,
    paddingTop: 2,
    paddingBottom: 4,
  },
  sourceGridLandscape: {
    gap: 6,
  },
  sourceChipLandscape: {
    width: "23%",
    minWidth: 72,
  },
  sourceChip: {
    width: "31%",
    minWidth: 88,
    flexGrow: 1,
    minHeight: 54,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
    backgroundColor: "rgba(255,255,255,0.04)",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingHorizontal: 6,
    paddingVertical: 8,
  },
  sourceChipActive: {
    borderColor: "rgba(143,240,196,0.42)",
    backgroundColor: "rgba(143,240,196,0.08)",
  },
  sourceChipPressed: {
    opacity: 0.86,
  },
  sourceChipLabel: {
    color: "rgba(248,248,254,0.72)",
    fontSize: 11,
    fontWeight: "600",
  },
  sourceChipLabelActive: {
    color: "#D9FBEA",
  },
  statusPanel: {
    marginHorizontal: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
    backgroundColor: "rgba(255,255,255,0.04)",
    paddingHorizontal: 10,
    paddingVertical: 10,
    gap: 6,
  },
  statusTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  statusConnection: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
  },
  statusConnectionText: {
    color: "rgba(248,248,254,0.82)",
    fontSize: 13,
    fontWeight: "600",
  },
  statusPing: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  statusPingText: {
    color: "rgba(248,248,254,0.72)",
    fontSize: 12,
    fontWeight: "600",
  },
  statusMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },
  statusMetaText: {
    color: "rgba(248,248,254,0.58)",
    fontSize: 12,
    fontWeight: "500",
    flexShrink: 1,
  },
  statusMetaDivider: {
    color: "rgba(248,248,254,0.28)",
    fontSize: 12,
    fontWeight: "500",
  },
  statusBridgeTiming: {
    color: "rgba(248,248,254,0.58)",
    fontSize: 11,
    lineHeight: 15,
    fontVariant: ["tabular-nums"],
  },
  statusMessage: {
    color: "rgba(248,248,254,0.52)",
    fontSize: 11,
    lineHeight: 15,
  },
  statusError: {
      color: "#FFD1D8",
      fontSize: 11,
      lineHeight: 15,
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
  });
