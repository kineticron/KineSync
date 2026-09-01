import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Platform, StyleSheet, View } from "react-native";
import WebView, { type WebViewMessageEvent } from "react-native-webview";

import {
  AMLL_WEBVIEW_CSS,
  AMLL_WEBVIEW_JS,
} from "@/components/lyrics/amll-webview-bundle";
import { detectLyricsTimingMode } from "@/lib/lyrics-timing";
import { usePlaybackStore } from "@/store/playback-store";
import type { LyricLine as LyricLineType } from "@/types/bridge";

const TransparentWebView = WebView as unknown as React.ComponentType<Record<string, unknown>>;

type WebLyricsSyllable = {
  text: string;
  startTime: number;
  endTime: number;
};

type WebLyricsLine = {
  lineStartTime: number;
  lineEndTime: number;
  syllables: WebLyricsSyllable[];
  backgroundSyllables?: WebLyricsSyllable[];
  translatedText?: string;
  backgroundTranslatedText?: string;
  oppositeAligned?: boolean;
};

type WebLyricsViewProps = {
  tapToSeekEnabled: boolean;
  showTranslatedText?: boolean;
  previewPositionMs?: number | null;
  autoFollowEnabled?: boolean;
  resumeAutoFollowSignal?: number;
  selectedLineKeys?: Set<string>;
  onLinePress?: (line: LyricLineType) => void;
  onLineLongPress?: (line: LyricLineType) => void;
  onActiveLineChange?: (lineIndex: number) => void;
  onAutoFollowChange?: (enabled: boolean) => void;
  onCreditsTimestampPress?: (positionMs: number) => void;
  onUserInteraction?: () => void;
  fontScale?: number;
  landscapeMode?: boolean;
};

function escapeScript(value: string) {
  return value.replace(/<\/script/gi, "<\\/script");
}

function createWebLyricsHtml() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<style>
${AMLL_WEBVIEW_CSS}
html,
body,
#app {
  margin: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: transparent;
}
body {
  color: white;
  font-family: "SF Pro Display", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
  touch-action: manipulation;
}
#app,
#amll-root {
  position: absolute;
  inset: 0;
  background: transparent;
}
.static-lyrics-root {
  position: absolute;
  inset: 0;
  box-sizing: border-box;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 150px 28px 280px;
  scrollbar-width: none;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  touch-action: pan-y;
}
.static-lyrics-root::-webkit-scrollbar {
  display: none;
}
.static-lyrics-root[hidden] {
  display: none;
}
.static-lyrics-line {
  box-sizing: border-box;
  width: 100%;
  max-width: 300px;
  margin: 0 0 14px;
  color: #fff;
  font-size: calc(26px * var(--ks-font-scale, 1));
  line-height: 1.46;
  font-weight: 600;
  letter-spacing: 0.15px;
  white-space: pre-wrap;
}
.static-lyrics-translation {
  margin-top: 6px;
  color: rgba(255,255,255,0.68);
  font-size: calc(18px * var(--ks-font-scale, 1));
  line-height: 1.44;
  font-weight: 500;
  letter-spacing: 0.1px;
}
.static-lyrics-background {
  margin-top: 5px;
  color: rgba(255,255,255,0.78);
  font-size: calc(18px * var(--ks-font-scale, 1));
  line-height: 1.4;
  font-weight: 500;
}
.static-lyrics-background-translation {
  margin-top: 2px;
  color: rgba(255,255,255,0.58);
  font-size: calc(15px * var(--ks-font-scale, 1));
  line-height: 1.4;
  font-weight: 500;
}
.static-lyrics-root.landscape .static-lyrics-line {
  margin-left: auto;
  text-align: right;
}
.static-lyrics-root .kinesync-credits-footer {
  max-width: 300px;
  margin-top: 18px;
  padding-left: 0;
  padding-right: 0;
}
.static-lyrics-root.landscape .kinesync-credits-footer {
  margin-left: auto;
  text-align: right;
}
.kinesync-amll-player {
  background: transparent;
  --amll-lp-color: #fff;
  --amll-lp-font-size: calc(36px * var(--ks-font-scale, 1));
  --amll-lp-hover-bg-color: transparent;
  font-family: "SF Pro Display", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-weight: 800;
  overflow: visible;
}
.kinesync-amll-player.landscape {
  --amll-lp-font-size: calc(32px * var(--ks-font-scale, 1));
}
.kinesync-amll-player [class*="lyricLineWrapper"] {
  box-sizing: border-box;
  max-width: calc(100% - 44px);
  margin-top: 8px;
  margin-bottom: 8px;
  overflow: visible !important;
}
.kinesync-amll-player.landscape [class*="lyricLineWrapper"] {
  max-width: calc(100% - 56px);
  margin-top: 10px;
  margin-bottom: 10px;
}
.kinesync-amll-player [class*="lyricLineWrapper"]:not([style*="right"]) {
  margin-left: 22px;
}
.kinesync-amll-player [class*="lyricLineWrapper"][style*="right"] {
  margin-right: 22px;
}
.kinesync-amll-player.landscape [class*="lyricLineWrapper"]:not([style*="right"]) {
  margin-left: 28px;
}
.kinesync-amll-player.landscape [class*="lyricLineWrapper"][style*="right"] {
  margin-right: 28px;
}
.kinesync-amll-player [class*="lyricMainLine"],
.kinesync-amll-player [class*="lyricSubLine"] {
  font-family: "SF Pro Display", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-weight: 800;
}
.kinesync-amll-player [class*="lyricSubLine"] {
  font-weight: 700;
}
.kinesync-amll-player .kinesync-selected-line,
.kinesync-selected-line {
  background-color: rgba(255,255,255,0.13) !important;
}
.kinesync-amll-player .kinesync-pressed-line,
.kinesync-pressed-line {
  background-color: rgba(255,255,255,0.16) !important;
}
.kinesync-credits-footer {
  box-sizing: border-box;
  width: min(88%, 720px);
  margin: 18px 0 0 0;
  padding: 18px 16px 32px;
  color: rgba(255,255,255,0.56);
  font-family: "SF Pro Display", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 13px;
  line-height: 18px;
  font-weight: 600;
  cursor: pointer;
}
.kinesync-amll-player.landscape .kinesync-credits-footer {
  margin-left: auto;
  text-align: right;
}
.kinesync-credits-footer:active {
  color: rgba(255,255,255,0.86);
}
.kinesync-credits-strong {
  font-weight: 800;
}
.empty {
  position: absolute;
  left: 26px;
  right: 26px;
  top: 45%;
  transform: translateY(-50%);
  text-align: center;
  pointer-events: none;
}
.empty-title {
  color: #fff;
  font-size: 27px;
  line-height: 1.16;
  font-weight: 800;
}
.empty-sub {
  margin-top: 10px;
  color: rgba(255,255,255,0.62);
  font-size: 13px;
  line-height: 1.35;
  font-weight: 560;
}
</style>
</head>
<body>
<div id="app">
  <div id="amll-root"></div>
  <div id="staticLyricsRoot" class="static-lyrics-root" hidden></div>
  <div id="empty" class="empty" hidden>
    <div id="emptyTitle" class="empty-title"></div>
    <div id="emptySub" class="empty-sub"></div>
  </div>
</div>
<script>${escapeScript(AMLL_WEBVIEW_JS)}</script>
</body>
</html>`;
}

const WEB_LYRICS_HTML = createWebLyricsHtml();

function toFiniteMs(value: unknown, fallback = 0) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.max(0, numberValue) : fallback;
}

function toWebSyllable(syllable: { text: string; startTime: number; endTime: number }): WebLyricsSyllable {
  const startTime = toFiniteMs(syllable.startTime);
  return {
    text: String(syllable.text || ""),
    startTime,
    endTime: Math.max(startTime + 1, toFiniteMs(syllable.endTime, startTime + 1)),
  };
}

function toWebLine(line: LyricLineType): WebLyricsLine {
  const startTime = toFiniteMs(line.lineStartTime);
  return {
    lineStartTime: startTime,
    lineEndTime: Math.max(startTime + 1, toFiniteMs(line.lineEndTime, startTime + 1)),
    syllables: (line.syllables || []).map(toWebSyllable),
    backgroundSyllables: line.backgroundSyllables?.length
      ? line.backgroundSyllables.map(toWebSyllable)
      : undefined,
    translatedText: String(line.translatedText || "").trim() || undefined,
    backgroundTranslatedText:
      String(line.backgroundTranslatedText || "").trim() || undefined,
    oppositeAligned: Boolean(line.oppositeAligned),
  };
}

function serializeForInjection(payload: unknown) {
  return JSON.stringify(payload)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export const WebLyricsView = memo(function WebLyricsView({
  tapToSeekEnabled,
  showTranslatedText = true,
  previewPositionMs = null,
  autoFollowEnabled = true,
  resumeAutoFollowSignal = 0,
  selectedLineKeys,
  onLinePress,
  onLineLongPress,
  onActiveLineChange,
  onAutoFollowChange,
  onCreditsTimestampPress,
  onUserInteraction,
  fontScale = 1,
  landscapeMode = false,
}: WebLyricsViewProps) {
  const webViewRef = useRef<{
    injectJavaScript: (script: string) => void;
  } | null>(null);
  const appStateRef = useRef(AppState.currentState);
  const [webViewGeneration, setWebViewGeneration] = useState(0);
  const [readyGeneration, setReadyGeneration] = useState(-1);
  const ready = readyGeneration === webViewGeneration;
  const lyrics = usePlaybackStore((state) => state.lyrics);
  const lyricsMetadata = usePlaybackStore((state) => state.lyricsMetadata);
  const lyricsSource = usePlaybackStore((state) => state.lyricsSource);
  const lyricsStatusMessage = usePlaybackStore((state) => state.lyricsStatusMessage);
  const currentTrack = usePlaybackStore((state) => state.currentTrack);
  const songwriters = useMemo(
    () => lyricsMetadata.credits?.songwriters || [],
    [lyricsMetadata.credits?.songwriters],
  );
  const lastLyricEndTime = lyrics.length
    ? Number(lyrics[lyrics.length - 1]?.lineEndTime || 0)
    : 0;
  const lyricsTimingMode = useMemo(
    () => detectLyricsTimingMode(lyrics, lyricsSource),
    [lyrics, lyricsSource],
  );
  const anchorPositionMs = usePlaybackStore((state) => state.anchorPositionMs);
  const isPlaying = usePlaybackStore((state) => state.isPlaying);

  const selectedKeyMap = useMemo(() => {
    const result: Record<string, boolean> = {};
    selectedLineKeys?.forEach((key) => {
      result[key] = true;
    });
    return result;
  }, [selectedLineKeys]);

  const inject = useCallback((payload: unknown) => {
    if (!ready) {
      return;
    }
    webViewRef.current?.injectJavaScript(
      `window.KineSyncLyrics && window.KineSyncLyrics.receive(${serializeForInjection(payload)}); true;`,
    );
  }, [ready]);

  // iOS suspends the WebView process while the app is backgrounded. Its
  // animation loop can resume with a stale/blank layer, even though React
  // still considers the component mounted. Remount the native WebView on every
  // real background -> active transition. A generation-bound ready state keeps
  // late events from the suspended instance from affecting its replacement.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      const previousState = appStateRef.current;
      appStateRef.current = nextState;
      if (nextState === "active" && previousState !== "active") {
        setWebViewGeneration((generation) => generation + 1);
      }
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!ready) {
      return;
    }
    inject({
      type: "setLyrics",
      lines: lyrics.map(toWebLine),
      timingMode: lyricsTimingMode,
      emptyTitle: lyricsMetadata.instrumental
        ? "This song is an instrumental"
        : "No synced lyrics yet",
      emptySub: lyricsStatusMessage || `Source: ${lyricsSource || "unavailable"}`,
      songwriters,
      lastLyricEndTime,
    });
  }, [
    inject,
    lastLyricEndTime,
    lyrics,
    lyricsMetadata.instrumental,
    lyricsSource,
    lyricsStatusMessage,
    lyricsTimingMode,
    ready,
    songwriters,
  ]);

  useEffect(() => {
    inject({
      type: "options",
      showTranslatedText,
      tapToSeekEnabled,
      landscapeMode,
      fontScale,
      selectedKeys: selectedKeyMap,
      autoFollowEnabled,
      resumeAutoFollowSignal,
    });
  }, [
    autoFollowEnabled,
    fontScale,
    inject,
    landscapeMode,
    resumeAutoFollowSignal,
    selectedKeyMap,
    showTranslatedText,
    tapToSeekEnabled,
  ]);

  useEffect(() => {
    inject({
      type: "sync",
      positionMs: previewPositionMs ?? anchorPositionMs,
      previewPositionMs,
      isPlaying: previewPositionMs === null ? isPlaying : false,
      durationMs: currentTrack?.durationMs ?? 0,
      force: previewPositionMs !== null,
    });
  }, [anchorPositionMs, currentTrack?.durationMs, inject, isPlaying, previewPositionMs]);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    let payload: {
      type?: string;
      index?: number;
      enabled?: boolean;
      positionMs?: number;
    } | null = null;
    try {
      payload = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (!payload || typeof payload !== "object") {
      return;
    }
    if (payload.type === "ready") {
      setReadyGeneration(webViewGeneration);
      return;
    }
    if (payload.type === "activeLineChange") {
      onActiveLineChange?.(Number(payload.index ?? -1));
      return;
    }
    if (payload.type === "autoFollowChange") {
      onAutoFollowChange?.(Boolean(payload.enabled));
      return;
    }
    if (payload.type === "creditsPress") {
      const positionMs = Number(payload.positionMs ?? 0);
      if (Number.isFinite(positionMs) && positionMs >= 0) {
        onUserInteraction?.();
        onCreditsTimestampPress?.(positionMs);
      }
      return;
    }
    const index = Number(payload.index ?? -1);
    const line = Number.isInteger(index) ? lyrics[index] : undefined;
    if (!line) {
      return;
    }
    onUserInteraction?.();
    if (payload.type === "linePress") {
      onLinePress?.(line);
      return;
    }
    if (payload.type === "lineLongPress") {
      onLineLongPress?.(line);
    }
  }, [
    lyrics,
    onActiveLineChange,
    onAutoFollowChange,
    onCreditsTimestampPress,
    onLineLongPress,
    onLinePress,
    onUserInteraction,
    webViewGeneration,
  ]);

  return (
    <View style={styles.container}>
      <TransparentWebView
        key={`web-lyrics-${webViewGeneration}`}
        ref={webViewRef}
        source={{ html: WEB_LYRICS_HTML }}
        originWhitelist={["*"]}
        javaScriptEnabled
        domStorageEnabled={false}
        cacheEnabled={false}
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        automaticallyAdjustContentInsets={false}
        textInteractionEnabled={false}
        androidLayerType={Platform.OS === "android" ? "hardware" : undefined}
        onMessage={handleMessage}
        onLoadEnd={() => setReadyGeneration(webViewGeneration)}
        style={styles.webView}
        containerStyle={styles.webViewContainer}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "transparent",
  },
  webView: {
    flex: 1,
    backgroundColor: "transparent",
  },
  webViewContainer: {
    flex: 1,
    backgroundColor: "transparent",
  },
});
