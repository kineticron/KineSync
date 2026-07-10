/**
 * SkiaLyricsCanvas — full Skia replacement for FlashList lyrics rendering.
 *
 * One <Canvas> draws all visible lyrics. Scroll is a translateY on a Group.
 * Reveal sweeps use clipRect per token. Sustain glow uses Shadow ImageFilter.
 *
 * ponytail: single Canvas replaces 24+ animated Views per active line.
 * Upgrade path: if memory pressure on 500+ line lyrics, add tile-based culling.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import {
  Canvas,
  Fill,
  Group,
  Text as SkiaText,
  matchFont,
  rect,
  Shadow,
  type SkFont,
} from "@shopify/react-native-skia";
import Reanimated, {
  cancelAnimation,
  Easing as ReanimatedEasing,
  useDerivedValue,
  useSharedValue,
  withDecay,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

import type { LyricLine, LyricSyllable } from "@/types/bridge";
import { usePlaybackStore } from "@/store/playback-store";
import { getGraphemeCount } from "@/lib/graphemes";

// ─── Constants (matching lyric-line.tsx) ────────────────────────────────────

const BASE_FONT_SIZE = 32;
const BASE_LINE_HEIGHT = 42;
const BG_FONT_SIZE = BASE_FONT_SIZE * 0.62;
const BG_LINE_HEIGHT = BASE_LINE_HEIGHT * 0.62;
const LINE_GAP = 18;
const BG_LINE_GAP = 10;
const HORIZONTAL_INSET = 24;
const TOP_PADDING = 150;
const BOTTOM_PADDING = 280;

const SCALE_ACTIVE = 1.05;
const OPACITY_ACTIVE = 1;
const OPACITY_INACTIVE = 0.5;
const COLOR_DONE = "rgba(255,255,255,0.5)";
const COLOR_ACTIVE_PENDING = "rgba(255,255,255,0.5)";
const COLOR_ACTIVE_PROGRESS = "#FFFFFF";
const COLOR_INACTIVE = "rgba(255,255,255,0.5)";

const SUSTAIN_MS_THRESHOLD = 680;
const MIN_MS_PER_CHAR_FOR_LETTER_SWEEP = 220;
const MAX_LETTER_SWEEP_CHARS = 5;
const WORD_SUSTAIN_MIN_MS = 920;
const SUSTAIN_GLOW_RADIUS_MAX = 7;

// Scroll easing — same as lyrics-view.tsx
const LYRIC_SCROLL_ANIMATION_MS = 440;
const LYRIC_SCROLL_EASING = ReanimatedEasing.bezier(0.22, 0.88, 0.34, 1);

// ─── Types ──────────────────────────────────────────────────────────────────

type SustainMode = "none" | "solo" | "letter-sweep" | "word";

type LayoutToken = {
  text: string;
  x: number;
  y: number;
  width: number;
  startTime: number;
  endTime: number;
  sustainMode: SustainMode;
};

type LayoutLine = {
  y: number;
  height: number;
  primaryTokens: LayoutToken[];
  backgroundTokens?: LayoutToken[];
  lineIndex: number;
  lineStartTime: number;
  lineEndTime: number;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function getSustainMode(text: string, durationMs: number): SustainMode {
  const trimmed = String(text || "").trim();
  const charCount = getGraphemeCount(trimmed);
  if (charCount === 0 || durationMs < SUSTAIN_MS_THRESHOLD) return "none";
  if (charCount === 1) return "solo";
  const msPerChar = durationMs / charCount;
  if (msPerChar >= MIN_MS_PER_CHAR_FOR_LETTER_SWEEP) return "letter-sweep";
  if (charCount > MAX_LETTER_SWEEP_CHARS && durationMs >= WORD_SUSTAIN_MIN_MS)
    return "letter-sweep";
  return "none";
}

function clamp01(v: number) {
  "worklet";
  return Math.max(0, Math.min(1, v));
}

function getRevealClipWidth(
  baseWidth: number,
  progress: number,
  leadWidth: number,
  edgePad: number,
) {
  "worklet";
  const safeBase = Math.max(0, baseWidth);
  const p = clamp01(progress);
  const targetWidth = safeBase + edgePad;
  const swept = targetWidth * p + leadWidth * (1 - p);
  return Math.min(swept, targetWidth);
}

function getSyllableProgress(
  positionMs: number,
  startTime: number,
  endTime: number,
) {
  "worklet";
  const duration = Math.max(1, endTime - startTime);
  return clamp01((positionMs - startTime) / duration);
}

function getSustainBlur(progress: number): number {
  "worklet";
  // Gaussian bell — peak glow at midpoint of syllable
  const d = (progress - 0.5) * 3;
  const intensity = Math.exp(-(d * d));
  return SUSTAIN_GLOW_RADIUS_MAX * intensity;
}

// ─── Layout computation ─────────────────────────────────────────────────────

function computeLayout(
  lyrics: LyricLine[],
  font: SkFont,
  bgFont: SkFont | null,
  containerWidth: number,
): LayoutLine[] {
  const textWidth = containerWidth - HORIZONTAL_INSET * 2;
  const lines: LayoutLine[] = [];
  let y = TOP_PADDING;

  for (let i = 0; i < lyrics.length; i++) {
    const line = lyrics[i];
    const syllables = line.syllables;
    const bgSyllables = line.backgroundSyllables;

    // Primary tokens
    const primaryTokens: LayoutToken[] = [];
    let tokenX = 0;
    let tokenY = 0;

    for (const syl of syllables) {
      const w = font.measureText(syl.text).width;
      if (tokenX + w > textWidth && tokenX > 0) {
        tokenX = 0;
        tokenY += BASE_LINE_HEIGHT;
      }
      const durationMs = Math.max(1, syl.endTime - syl.startTime);
      primaryTokens.push({
        text: syl.text,
        x: tokenX,
        y: tokenY,
        width: w,
        startTime: syl.startTime,
        endTime: syl.endTime,
        sustainMode: getSustainMode(syl.text, durationMs),
      });
      tokenX += w;
    }

    const primaryHeight = tokenY + BASE_LINE_HEIGHT;

    // Background tokens
    let backgroundTokens: LayoutToken[] | undefined;
    let bgHeight = 0;
    if (bgSyllables && bgSyllables.length > 0 && bgFont) {
      backgroundTokens = [];
      let bgX = 0;
      let bgY = 0;
      for (const syl of bgSyllables) {
        const w = bgFont.measureText(syl.text).width;
        if (bgX + w > textWidth && bgX > 0) {
          bgX = 0;
          bgY += BG_LINE_HEIGHT;
        }
        const durationMs = Math.max(1, syl.endTime - syl.startTime);
        backgroundTokens.push({
          text: syl.text,
          x: bgX,
          y: primaryHeight + BG_LINE_GAP + bgY,
          width: w,
          startTime: syl.startTime,
          endTime: syl.endTime,
          sustainMode: getSustainMode(syl.text, durationMs),
        });
        bgX += w;
      }
      bgHeight = bgY + BG_LINE_HEIGHT + BG_LINE_GAP;
    }

    const totalHeight = primaryHeight + bgHeight;
    lines.push({
      y,
      height: totalHeight,
      primaryTokens,
      backgroundTokens,
      lineIndex: i,
      lineStartTime: line.lineStartTime,
      lineEndTime: line.lineEndTime,
    });
    y += totalHeight + LINE_GAP;
  }

  return lines;
}

// ─── Props ──────────────────────────────────────────────────────────────────

export type SkiaLyricsCanvasProps = {
  autoFollowEnabled?: boolean;
  onAutoFollowChange?: (enabled: boolean) => void;
  onUserInteraction?: () => void;
  onLinePress?: (line: LyricLine) => void;
  onLineLongPress?: (line: LyricLine) => void;
  fontScale?: number;
  landscapeMode?: boolean;
};

// ─── Component ──────────────────────────────────────────────────────────────

export const SkiaLyricsCanvas = memo(function SkiaLyricsCanvas({
  autoFollowEnabled = true,
  onAutoFollowChange,
  onUserInteraction,
  onLinePress,
  fontScale = 1,
  landscapeMode = false,
}: SkiaLyricsCanvasProps) {
  // ponytail: matchFont — "System" resolves to SF Pro on iOS, Roboto on Android
  const primaryFont = useMemo(
    () =>
      matchFont({
        fontFamily: "System",
        fontSize: BASE_FONT_SIZE * fontScale,
        fontWeight: "bold",
        fontStyle: "normal",
      }),
    [fontScale],
  );
  const bgFont = useMemo(
    () =>
      matchFont({
        fontFamily: "System",
        fontSize: BG_FONT_SIZE * fontScale,
        fontWeight: "bold",
        fontStyle: "normal",
      }),
    [fontScale],
  );

  const lyrics = usePlaybackStore((s) => s.lyrics);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  // Layout all lines when lyrics or canvas size changes
  const layout = useMemo(() => {
    if (!primaryFont || canvasSize.width === 0) return [];
    return computeLayout(lyrics, primaryFont, bgFont, canvasSize.width);
  }, [lyrics, primaryFont, bgFont, canvasSize.width]);

  const totalContentHeight = useMemo(() => {
    if (layout.length === 0) return 0;
    const last = layout[layout.length - 1];
    return last.y + last.height + BOTTOM_PADDING;
  }, [layout]);

  // ─── Playback position (shared value, updated via interval) ──────────────
  // ponytail: ~60fps polling from JS thread. SharedValue change triggers Skia
  // Canvas redraw. This is simpler than per-syllable withTiming and works for
  // all tokens simultaneously from one source of truth.

  const playbackPosition = useSharedValue(0);

  useEffect(() => {
    let anchorPos = usePlaybackStore.getState().anchorPositionMs;
    let anchorMono = usePlaybackStore.getState().anchorMonotonicMs;
    let playing = usePlaybackStore.getState().isPlaying;

    const unsub = usePlaybackStore.subscribe((state) => {
      anchorPos = state.anchorPositionMs;
      anchorMono = state.anchorMonotonicMs;
      playing = state.isPlaying;
      if (!playing) {
        playbackPosition.value = Math.max(0, anchorPos);
      }
    });

    // ~60fps position update while playing
    let rafId: number | null = null;
    const tick = () => {
      if (playing) {
        const now =
          typeof performance !== "undefined" ? performance.now() : Date.now();
        playbackPosition.value = Math.max(0, anchorPos + now - anchorMono);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    return () => {
      unsub();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [playbackPosition]);

  // ─── Scroll state ───────────────────────────────────────────────────────

  const scrollOffset = useSharedValue(0);
  const isUserScrolling = useSharedValue(false);
  const autoFollowEnabledRef = useRef(autoFollowEnabled);
  autoFollowEnabledRef.current = autoFollowEnabled;

  const maxScroll = useMemo(
    () => Math.max(0, totalContentHeight - canvasSize.height),
    [totalContentHeight, canvasSize.height],
  );

  // ─── Gesture ──────────────────────────────────────────────────────────────

  const scrollStart = useSharedValue(0);
  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .onBegin(() => {
          "worklet";
          cancelAnimation(scrollOffset);
          scrollStart.value = scrollOffset.value;
          isUserScrolling.value = true;
        })
        .onUpdate((e) => {
          "worklet";
          // translationY is cumulative from gesture start
          const next = scrollStart.value - e.translationY;
          scrollOffset.value = Math.max(0, Math.min(maxScroll, next));
        })
        .onEnd((e) => {
          "worklet";
          scrollOffset.value = withDecay({
            velocity: -e.velocityY,
            clamp: [0, maxScroll],
            deceleration: 0.997,
          });
        })
        .onFinalize(() => {
          "worklet";
          isUserScrolling.value = false;
        }),
    [maxScroll, scrollOffset, scrollStart, isUserScrolling],
  );

  // ─── Auto-follow ─────────────────────────────────────────────────────────

  const activeLineIndexRef = useRef(-1);

  useEffect(() => {
    const unsub = usePlaybackStore.subscribe((state) => {
      if (!autoFollowEnabledRef.current || isUserScrolling.value) return;
      if (layout.length === 0) return;

      const pos = state.playbackPosition;
      let activeIdx = -1;

      // Binary-ish search for active line
      for (let i = 0; i < layout.length; i++) {
        const l = layout[i];
        if (pos >= l.lineStartTime && pos < l.lineEndTime) {
          activeIdx = i;
          break;
        }
        if (l.lineStartTime > pos) {
          activeIdx = Math.max(0, i - 1);
          break;
        }
      }
      if (activeIdx < 0) activeIdx = layout.length - 1;
      if (activeIdx === activeLineIndexRef.current) return;
      activeLineIndexRef.current = activeIdx;

      const layoutLine = layout[activeIdx];
      if (!layoutLine) return;

      const targetOffset = Math.max(
        0,
        Math.min(maxScroll, layoutLine.y - canvasSize.height * 0.33),
      );

      cancelAnimation(scrollOffset);
      scrollOffset.value = withTiming(targetOffset, {
        duration: LYRIC_SCROLL_ANIMATION_MS,
        easing: LYRIC_SCROLL_EASING,
      });
    });
    return unsub;
  }, [layout, maxScroll, canvasSize.height, scrollOffset, isUserScrolling]);

  // ─── Scroll transform (derived for Skia) ─────────────────────────────────

  const scrollTransform = useDerivedValue(() => [
    { translateY: -scrollOffset.value },
  ]);

  // ─── Layout handler ───────────────────────────────────────────────────────

  const handleLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setCanvasSize((prev) =>
      Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1
        ? prev
        : { width, height },
    );
  }, []);

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <GestureDetector gesture={panGesture}>
      <Reanimated.View
        style={styles.container}
        onLayout={handleLayout}
        collapsable={false}
      >
        <Canvas style={StyleSheet.absoluteFill}>
          {/* Debug: red fill so canvas is obviously visible */}
          <Fill color="rgba(255,0,0,0.3)" />
          <SkiaText
            x={24}
            y={250}
            text={`Skia: ${Math.round(canvasSize.width)}x${Math.round(canvasSize.height)}, ${layout.length} lines`}
            font={primaryFont}
            color="yellow"
          />
          {layout.length > 0 && (
            <Group transform={scrollTransform}>
              {layout.map((layoutLine) => (
                <SkiaLyricLineGroup
                  key={layoutLine.lineIndex}
                  layoutLine={layoutLine}
                  primaryFont={primaryFont}
                  bgFont={bgFont}
                  playbackPosition={playbackPosition}
                  scrollOffset={scrollOffset}
                  canvasHeight={canvasSize.height}
                />
              ))}
            </Group>
          )}
        </Canvas>
      </Reanimated.View>
    </GestureDetector>
  );
});

// ─── Per-line Skia group ────────────────────────────────────────────────────

const SkiaLyricLineGroup = memo(function SkiaLyricLineGroup({
  layoutLine,
  primaryFont,
  bgFont,
  playbackPosition,
  scrollOffset,
  canvasHeight,
}: {
  layoutLine: LayoutLine;
  primaryFont: SkFont;
  bgFont: SkFont;
  playbackPosition: SharedValue<number>;
  scrollOffset: SharedValue<number>;
  canvasHeight: number;
}) {
  // Viewport culling — skip if line is off-screen
  // ponytail: derived value recalculates each frame, but the conditional
  // drawing below means Skia skips the draw calls for culled lines
  const isVisible = useDerivedValue(() => {
    const viewTop = scrollOffset.value;
    const viewBottom = viewTop + canvasHeight;
    const lineTop = layoutLine.y;
    const lineBottom = lineTop + layoutLine.height;
    // 100px buffer for smooth entry
    return lineBottom > viewTop - 100 && lineTop < viewBottom + 100;
  });

  // Line state: active/past/inactive
  const lineOpacity = useDerivedValue(() => {
    if (!isVisible.value) return 0;
    const pos = playbackPosition.value;
    if (pos >= layoutLine.lineStartTime && pos < layoutLine.lineEndTime) {
      return OPACITY_ACTIVE;
    }
    return OPACITY_INACTIVE;
  });

  const lineScale = useDerivedValue(() => {
    if (!isVisible.value) return 1;
    const pos = playbackPosition.value;
    if (pos >= layoutLine.lineStartTime && pos < layoutLine.lineEndTime) {
      return SCALE_ACTIVE;
    }
    return 1;
  });

  const lineTransform = useDerivedValue(() => [
    { translateX: HORIZONTAL_INSET },
    { translateY: layoutLine.y },
    { scale: lineScale.value },
  ]);

  return (
    <Group transform={lineTransform} opacity={lineOpacity}>
      {/* Primary tokens */}
      {layoutLine.primaryTokens.map((token, idx) => (
        <SkiaRevealToken
          key={idx}
          token={token}
          font={primaryFont}
          playbackPosition={playbackPosition}
          lineStartTime={layoutLine.lineStartTime}
          lineEndTime={layoutLine.lineEndTime}
          isBackground={false}
        />
      ))}
      {/* Background tokens */}
      {layoutLine.backgroundTokens?.map((token, idx) => (
        <SkiaRevealToken
          key={`bg-${idx}`}
          token={token}
          font={bgFont}
          playbackPosition={playbackPosition}
          lineStartTime={layoutLine.lineStartTime}
          lineEndTime={layoutLine.lineEndTime}
          isBackground={true}
        />
      ))}
    </Group>
  );
});

// ─── Per-token reveal (reactive via SharedValue) ────────────────────────────
// ponytail: all rendering is purely derived from playbackPosition SharedValue.
// Skia redraws affected nodes when any derived value changes. Zero-width clips
// are GPU no-ops (no pixels drawn), so inactive tokens cost almost nothing.

const SkiaRevealToken = memo(function SkiaRevealToken({
  token,
  font,
  playbackPosition,
  lineStartTime,
  lineEndTime,
  isBackground,
}: {
  token: LayoutToken;
  font: SkFont;
  playbackPosition: SharedValue<number>;
  lineStartTime: number;
  lineEndTime: number;
  isBackground: boolean;
}) {
  const fontSize = font.getSize();

  const pendingColor = isBackground
    ? "rgba(255,255,255,0.32)"
    : COLOR_ACTIVE_PENDING;
  const progressColor = isBackground
    ? "rgba(255,255,255,0.47)"
    : COLOR_ACTIVE_PROGRESS;

  // Derived progress — recalculates each frame while playing
  const progress = useDerivedValue(() => {
    return getSyllableProgress(
      playbackPosition.value,
      token.startTime,
      token.endTime,
    );
  });

  // Clip rect for progress reveal (zero-width when progress=0 → GPU no-op)
  const progressClip = useDerivedValue(() => {
    const w = getRevealClipWidth(token.width, progress.value, 0, 0);
    return rect(token.x, token.y, w, fontSize * 1.4);
  });

  // Soft edge clip (slightly wider for leading edge glow)
  const softClip = useDerivedValue(() => {
    const lead = isBackground ? 6 : 0;
    const w = getRevealClipWidth(token.width, progress.value, lead, 0);
    return rect(token.x, token.y, w, fontSize * 1.4);
  });

  // Token rise Y (subtle vertical movement during reveal)
  const riseY = useDerivedValue(() => {
    const p = progress.value;
    const rise = isBackground
      ? 0.005 * fontSize * (1 - 2 * p)
      : 0.01 * fontSize * (1 - 5 * p);
    return token.y + fontSize + rise;
  });

  // Base text color — switches between pending (active line) and done/inactive
  const baseColor = useDerivedValue(() => {
    const pos = playbackPosition.value;
    if (pos >= lineStartTime && pos < lineEndTime) return pendingColor;
    if (pos >= lineEndTime) return COLOR_DONE;
    return COLOR_INACTIVE;
  });

  // Sustain glow blur (0 when not applicable → Shadow is invisible)
  const sustainBlur = useDerivedValue(() => {
    if (token.sustainMode === "none") return 0;
    const p = progress.value;
    if (p <= 0 || p >= 1) return 0;
    return getSustainBlur(p);
  });

  return (
    <Group>
      {/* Base text: pending/inactive/done color */}
      <SkiaText
        x={token.x}
        y={riseY}
        text={token.text}
        font={font}
        color={baseColor}
      />
      {/* Progress reveal: clipped sweep (zero-width clip = no draw) */}
      <Group clip={progressClip}>
        <SkiaText
          x={token.x}
          y={riseY}
          text={token.text}
          font={font}
          color={progressColor}
        />
      </Group>
      {/* Soft leading edge (primary only) */}
      {!isBackground && (
        <Group clip={softClip} opacity={0.35}>
          <SkiaText
            x={token.x}
            y={riseY}
            text={token.text}
            font={font}
            color={progressColor}
          />
        </Group>
      )}
      {/* Sustain glow (blur=0 when inactive → invisible) */}
      {token.sustainMode !== "none" && (
        <Group clip={progressClip} layer>
          <Shadow
            dx={0}
            dy={0}
            blur={sustainBlur}
            color="rgba(255,255,255,0.24)"
          />
          <SkiaText
            x={token.x}
            y={riseY}
            text={token.text}
            font={font}
            color={progressColor}
          />
        </Group>
      )}
    </Group>
  );
});

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  canvas: {
    flex: 1,
  },
});
