import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, FlatList, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useAnimatedReaction, useDerivedValue, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { usePlaybackStore } from '@/store/playback-store';
import { detectLyricsTimingMode } from '@/lib/lyrics-timing';
import { getAutoScrollTargetRange, getBackgroundActiveLines, getLyricTimingIndex, getPlaybackWindowState } from '@/lib/lyrics-layout';
import type { LyricLine, LyricsMetadata } from '@/types/bridge';
import { buildNativeRows, type NativeLyricRow, type NativeLyricsStyle } from './native-lyrics-model';
import { NativeLyricRowView, type NativeReveal } from './native-lyric-row';
import { useNativeLyricsClock } from './use-native-lyrics-clock';
import { initialScrollCommand, ReferenceScrollContext, ReferenceScrollView } from './reference-scroll';

export type NativeLyricsViewProps = {
  demoLyrics?: LyricLine[]; demoLayout?: 'preview' | 'player'; demoIsPlaying?: boolean;
  tapToSeekEnabled: boolean; showTranslatedText?: boolean; previewPositionMs?: number | null;
  autoFollowEnabled?: boolean; resumeAutoFollowSignal?: number; selectedLineKeys?: Set<string>;
  onLinePress?: (line: LyricLine) => void; onLineLongPress?: (line: LyricLine) => void;
  onActiveLineChange?: (index: number) => void; onAutoFollowChange?: (enabled: boolean) => void;
  onCreditsTimestampPress?: (position: number) => void; onUserInteraction?: () => void;
  fontScale?: number; landscapeMode?: boolean; active?: boolean;
};

const keyExtractor = (row: NativeLyricRow) => row.key;
const getItemType = (row: NativeLyricRow) => row.backgrounds.length ? 'background' : 'lead';
const maintainVisibleContentPosition = { disabled: true };
const emptyMetadata: LyricsMetadata = {};

/** Experimental native host. Both list backends deliberately use identical rows and clocks for A/B profiling. */
export const NativeLyricsView = memo(function NativeLyricsView({
  style, list = 'flash', reveal = 'clip', demoLyrics, demoLayout = 'preview', demoIsPlaying,
  tapToSeekEnabled, showTranslatedText = true, previewPositionMs = null, autoFollowEnabled = true,
  resumeAutoFollowSignal = 0, selectedLineKeys, onLinePress, onLineLongPress, onActiveLineChange,
  onAutoFollowChange, onCreditsTimestampPress, onUserInteraction, fontScale = 1, landscapeMode = false, active = true,
}: NativeLyricsViewProps & { style: NativeLyricsStyle; list?: 'flat' | 'flash'; reveal?: NativeReveal }) {
  const lyrics = usePlaybackStore(state => demoLyrics ?? state.lyrics);
  const source = usePlaybackStore(state => demoLyrics ? 'demo-syllable' : state.lyricsSource);
  const metadata = usePlaybackStore(state => demoLyrics ? emptyMetadata : state.lyricsMetadata);
  const status = usePlaybackStore(state => demoLyrics ? '' : state.lyricsStatusMessage);
  const trackDuration = usePlaybackStore(state => demoLyrics ? 0 : state.currentTrack?.durationMs ?? 0);
  const playing = usePlaybackStore(state => demoLyrics ? demoIsPlaying ?? true : state.isPlaying);
  const duration = useMemo(() => Math.max(trackDuration, Math.max(1, ...lyrics.map(line => Math.max(line.lineEndTime,
    ...(line.backgroundSyllables ?? []).map(part => part.endTime),
    ...(line.spicyBackgrounds ?? []).map(block => block.lineEndTime)))) + 1000), [lyrics, trackDuration]);
  const staticLyrics = useMemo(() => detectLyricsTimingMode(lyrics, source) === 'static', [lyrics, source]);
  const { position, running, seekVersion } = useNativeLyricsClock({ active: active && !staticLyrics, duration, preview: previewPositionMs, demo: !!demoLyrics, playing: demoIsPlaying });
  const hasDuet = useMemo(() => lyrics.some(line => landscapeMode ? !line.oppositeAligned : !!line.oppositeAligned), [landscapeMode, lyrics]);
  const rows = useMemo(() => buildNativeRows(lyrics, style, staticLyrics), [lyrics, staticLyrics, style]);
  const backgrounds = useMemo(() => getBackgroundActiveLines(lyrics), [lyrics]);
  const timing = useMemo(() => getLyricTimingIndex(lyrics), [lyrics]);
  const flashRef = useRef<FlashListRef<NativeLyricRow>>(null);
  const flatRef = useRef<FlatList<NativeLyricRow>>(null);
  const scrollCommand = useSharedValue(initialScrollCommand);
  const scrollState = useRef(initialScrollCommand);
  const scrollResidual = useSharedValue(0);
  const actualScrollOffset = useSharedValue(0);
  const referenceScroll = useMemo(() => ({ command: scrollCommand, residual: scrollResidual, actualOffset: actualScrollOffset, spicy: style === 'spicy' }), [actualScrollOffset, scrollCommand, scrollResidual, style]);
  const following = useRef(autoFollowEnabled);
  const currentPosition = useRef(0);
  const pendingIndex = useRef(-1);
  const lastScrollTarget = useRef('');
  const activeIndex = useRef(-2);
  const generation = useRef(0);
  const mounted = useRef(true);
  const latestLyrics = useRef(lyrics);
  latestLyrics.current = lyrics;
  const followControl = useRef({ enabled: autoFollowEnabled, signal: resumeAutoFollowSignal });
  const [window, setWindow] = useState(() => getPlaybackWindowState(0, lyrics, backgrounds, timing));
  const [viewportHeight, setViewportHeight] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  const preview = !!demoLyrics && demoLayout === 'preview';
  const topPadding = preview ? 12 : landscapeMode ? 168 : 150;
  const contentStyle = useMemo(() => ({ paddingTop: topPadding, paddingBottom: Math.max(280, viewportHeight) }), [topPadding, viewportHeight]);
  const cues = useMemo(() => [...new Set([0, ...lyrics.flatMap(line => [line.lineStartTime, line.lineEndTime,
    Math.max(0, line.lineStartTime - 500), ...(line.backgroundSyllables ?? []).flatMap(part => [part.startTime, part.endTime]),
    ...(line.spicyBackgrounds ?? []).flatMap(block => [block.lineStartTime, block.lineEndTime])])])].sort((a, b) => a - b), [lyrics]);
  const cueWindows = useMemo(() => cues.map(time => getPlaybackWindowState(time, lyrics, backgrounds, timing)), [backgrounds, cues, lyrics, timing]);
  // Compute discrete presentation state on the UI thread. Cells and their glyph
  // trees retain their identity when a cue advances, even if JS is busy.
  const presentationCue = useDerivedValue(() => {
    let low = 0;
    let high = cues.length;
    while (low < high) { const mid = (low + high) >>> 1; if (cues[mid] <= position.value) low = mid + 1; else high = mid; }
    return Math.max(0, low - 1);
  });

  const presentationWindow = useDerivedValue(() => cueWindows[presentationCue.value]);

  const scrollTo = useCallback((index: number, animated: boolean) => {
    if (!following.current || !active || staticLyrics || index < 0 || index >= rows.length) return;
    const measured = list === 'flash' ? flashRef.current?.getLayout(index) : undefined;
    const target = `${index}:${landscapeMode}:${fontScale}:${showTranslatedText}:${viewportHeight}:${measured?.y}:${flashRef.current?.getFirstItemOffset()}`;
    if (target === lastScrollTarget.current) return;
    const anchor = preview ? 12 : style === 'amll' ? viewportHeight * 0.08 + 8 : landscapeMode ? 32 : 0;
    if (list === 'flash') {
      const host = flashRef.current;
      const layout = host?.getLayout(index);
      if (!host || !layout || !viewportHeight) { pendingIndex.current = index; return; }
      const offset = Math.max(0, layout.y + host.getFirstItemOffset() - anchor);
      const previous = scrollState.current;
      const oldOffset = previous.serial ? previous.offset : host.getAbsoluteLastScrollOffset();
      const command = { serial: previous.serial + 1, offset, delta: offset - oldOffset, index,
        firstVisible: host.getFirstVisibleIndex(), interval: index > 0 ? rows[index].lead.start - rows[index - 1].lead.start : 800,
        instant: !animated || !previous.serial || Math.abs(offset - oldOffset) > viewportHeight,
        interlude: currentPosition.current > rows[index].lead.end, snap: true };
      scrollState.current = command;
      scrollCommand.value = command;
    } else flatRef.current?.scrollToIndex({ index, animated, viewPosition: 0, viewOffset: -anchor });
    lastScrollTarget.current = target;
  }, [active, fontScale, landscapeMode, list, preview, rows, scrollCommand, showTranslatedText, staticLyrics, style, viewportHeight]);
  const updateWindow = useCallback((time: number, token: number, seek = false) => {
    if (!mounted.current || token !== generation.current || latestLyrics.current !== lyrics || !active || AppState.currentState !== 'active') return;
    currentPosition.current = time;
    const next = getPlaybackWindowState(time, lyrics, backgrounds, timing);
    setWindow(previous => previous.activeLineStartIndex === next.activeLineStartIndex &&
      previous.activeLineEndIndex === next.activeLineEndIndex && previous.visualActiveLineStartIndex === next.visualActiveLineStartIndex &&
      previous.visualActiveLineEndIndex === next.visualActiveLineEndIndex && previous.focusLineIndex === next.focusLineIndex &&
      previous.isLongPause === next.isLongPause && previous.pauseStartMs === next.pauseStartMs &&
      previous.pauseVisualDurationMs === next.pauseVisualDurationMs && previous.pauseBeforeIndex === next.pauseBeforeIndex &&
      previous.pauseAfterIndex === next.pauseAfterIndex ? previous : next);
    if (activeIndex.current !== next.activeLineStartIndex) {
      activeIndex.current = next.activeLineStartIndex;
      onActiveLineChange?.(next.activeLineStartIndex);
    }
    const range = getAutoScrollTargetRange(next, time, lyrics);
    if (seek) lastScrollTarget.current = '';
    if (range) scrollTo(range.startIndex, !seek);
  }, [active, backgrounds, lyrics, onActiveLineChange, scrollTo, timing]);
  const cueIdentity = useMemo(() => ({ lyrics, token: ++generation.current }), [lyrics]);
  const token = cueIdentity.token;
  useAnimatedReaction(() => {
    if (!running.value || staticLyrics) return null;
    const time = position.value;
    let low = 0;
    let high = cues.length;
    while (low < high) { const mid = (low + high) >>> 1; if (cues[mid] <= time) low = mid + 1; else high = mid; }
    return { index: low, token, seek: seekVersion.value };
  }, (cue, previous) => {
    // Cross to JS only at a semantic cue, never on scroll or every playback frame.
    if (cue !== null && (cue.index !== previous?.index || cue.token !== previous?.token || cue.seek !== previous?.seek))
      scheduleOnRN(updateWindow, position.value, token, previous !== null && cue.seek !== previous.seek);
  });
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (staticLyrics && activeIndex.current !== -1) {
      activeIndex.current = -1;
      onActiveLineChange?.(-1);
    }
  }, [onActiveLineChange, staticLyrics]);
  useEffect(() => {
    const previous = followControl.current;
    if (previous.enabled !== autoFollowEnabled || previous.signal !== resumeAutoFollowSignal) following.current = autoFollowEnabled;
    followControl.current = { enabled: autoFollowEnabled, signal: resumeAutoFollowSignal };
    lastScrollTarget.current = '';
    const current = getPlaybackWindowState(currentPosition.current, lyrics, backgrounds, timing);
    const range = getAutoScrollTargetRange(current, currentPosition.current, lyrics);
    if (following.current && range) scrollTo(range.startIndex, true);
  }, [autoFollowEnabled, backgrounds, lyrics, resumeAutoFollowSignal, scrollTo, timing]);
  const takeOwnership = useCallback(() => {
    following.current = false;
    pendingIndex.current = -1;
    lastScrollTarget.current = '';
    const command = { ...scrollState.current, offset: flashRef.current?.getAbsoluteLastScrollOffset() ?? 0,
      serial: scrollState.current.serial + 1, instant: true, snap: false };
    scrollState.current = command;
    scrollCommand.value = command;
    onAutoFollowChange?.(false);
    onUserInteraction?.();
  }, [onAutoFollowChange, onUserInteraction, scrollCommand]);
  const press = useCallback((row: NativeLyricRow) => {
    following.current = true;
    onAutoFollowChange?.(true);
    onUserInteraction?.();
    onLinePress?.(row.line);
  }, [onAutoFollowChange, onLinePress, onUserInteraction]);
  const longPress = useCallback((row: NativeLyricRow) => { onUserInteraction?.(); onLineLongPress?.(row.line); }, [onLineLongPress, onUserInteraction]);
  const pause = useMemo(() => window.isLongPause ? { start: window.pauseStartMs, duration: window.pauseVisualDurationMs,
    before: window.pauseBeforeIndex >= 0 } : undefined, [window.isLongPause, window.pauseBeforeIndex, window.pauseStartMs, window.pauseVisualDurationMs]);
  const experimentalWindow = reveal === 'canvas' ? undefined : window;
  const renderItem = useCallback(({ item }: { item: NativeLyricRow }) => <NativeLyricRowView hasDuet={hasDuet} row={item} position={position}
    style={style} fontScale={fontScale} landscape={landscapeMode} preview={preview} playing={playing} viewportWidth={viewportWidth} referenceScroll={referenceScroll}
    presentationWindow={presentationWindow}
    active={!!experimentalWindow && item.index >= experimentalWindow.visualActiveLineStartIndex && item.index <= experimentalWindow.visualActiveLineEndIndex}
    distance={experimentalWindow ? Math.abs(item.index - Math.max(0, experimentalWindow.focusLineIndex)) : 0}
    selected={selectedLineKeys?.has(`${item.line.lineStartTime}-${item.line.lineEndTime}`) ?? false}
    staticLyrics={staticLyrics} showTranslation={showTranslatedText} reveal={reveal} tapToSeek={tapToSeekEnabled}
    onPress={press} onLongPress={longPress}
    pause={item.index === window.pauseAfterIndex || item.index === window.pauseBeforeIndex ? pause : undefined} />,
  [fontScale, hasDuet, landscapeMode, longPress, playing, position, press, preview, referenceScroll, reveal, selectedLineKeys, showTranslatedText, staticLyrics, style, viewportWidth,
    tapToSeekEnabled, presentationWindow, experimentalWindow, pause, window.pauseAfterIndex, window.pauseBeforeIndex]);
  const footer = useMemo(() => !metadata.credits?.songwriters?.length && !metadata.attribution ? null : <Pressable
    style={[styles.footer, landscapeMode && styles.rightFooter]} onPress={() => {
      onUserInteraction?.();
      onCreditsTimestampPress?.(Math.max(0, ...lyrics.map(line => line.lineEndTime)));
    }}>
    {!!metadata.credits?.songwriters?.length && <Text style={styles.credits}><Text style={styles.strong}>Written By: </Text>{metadata.credits.songwriters.join(', ')}</Text>}
    {!!metadata.attribution?.provider && <Text style={styles.credits}><Text style={styles.strong}>Provided By: </Text>{metadata.attribution.provider}</Text>}
    {metadata.attribution?.community && <Text style={styles.credits}>These lyrics have been provided by the Spicy Lyrics community</Text>}
    {[metadata.attribution?.maker, metadata.attribution?.uploader].map((profile, index) => profile?.username && <Pressable
      key={index} style={styles.profile} onPress={event => {
        event.stopPropagation();
        if (profile.url && /^https:\/\//i.test(profile.url)) void Linking.openURL(profile.url).catch(() => {});
      }}>
      <Text style={styles.credits}><Text style={styles.strong}>{index === 1 && metadata.attribution?.maker?.username ? 'Uploaded By: ' : 'Made By: '}</Text>@{profile.username}</Text>
      {!!profile.avatar && <Image source={{ uri: profile.avatar }} style={styles.avatar} accessibilityLabel={`${profile.username}'s avatar`} />}
    </Pressable>)}
  </Pressable>, [landscapeMode, lyrics, metadata, onCreditsTimestampPress, onUserInteraction]);
  const retryFlatScroll = useCallback(({ index, averageItemLength }: { index: number; averageItemLength: number }) => {
    if (!following.current) return;
    pendingIndex.current = index;
    flatRef.current?.scrollToOffset({ offset: averageItemLength * index, animated: false });
    // Retry only after new rows have laid out; no delayed retries can steal a user drag.
  }, []);
  const onContentSizeChange = useCallback(() => {
    if (pendingIndex.current >= 0 && following.current) {
      const index = pendingIndex.current;
      pendingIndex.current = -1;
      lastScrollTarget.current = '';
      scrollTo(index, false);
    } else if (following.current) {
      const current = getPlaybackWindowState(currentPosition.current, lyrics, backgrounds, timing);
      const range = getAutoScrollTargetRange(current, currentPosition.current, lyrics);
      if (range) scrollTo(range.startIndex, true);
    }
  }, [backgrounds, lyrics, scrollTo, timing]);
  if (!lyrics.length) return <View style={styles.empty}><Text style={styles.title}>{metadata.instrumental ? 'This song is an instrumental' : 'No synced lyrics yet'}</Text><Text style={styles.credits}>{status || `Source: ${source || 'unavailable'}`}</Text></View>;
  return <View style={styles.root} onLayout={event => { setViewportHeight(event.nativeEvent.layout.height); setViewportWidth(event.nativeEvent.layout.width); }} testID={`native-${style}-${list}-${reveal}`}>
    <ReferenceScrollContext.Provider value={referenceScroll}>{list === 'flash'
      ? <FlashList ref={flashRef} data={rows} renderItem={renderItem} keyExtractor={keyExtractor} getItemType={getItemType}
          extraData={renderItem}
          drawDistance={420} renderScrollComponent={ReferenceScrollView} maintainVisibleContentPosition={maintainVisibleContentPosition} contentContainerStyle={contentStyle}
          onLoad={onContentSizeChange}
          onCommitLayoutEffect={onContentSizeChange}
          ListFooterComponent={footer} showsVerticalScrollIndicator={false} onScrollBeginDrag={takeOwnership}
          onTouchStart={takeOwnership} onContentSizeChange={onContentSizeChange} />
      : <FlatList ref={flatRef} data={rows} renderItem={renderItem} keyExtractor={keyExtractor} contentContainerStyle={contentStyle}
          extraData={renderItem}
          ListFooterComponent={footer} showsVerticalScrollIndicator={false} onScrollBeginDrag={takeOwnership}
          onTouchStart={takeOwnership} onScrollToIndexFailed={retryFlatScroll} onContentSizeChange={onContentSizeChange}
          initialNumToRender={8} maxToRenderPerBatch={6} windowSize={5} removeClippedSubviews={false} />}</ReferenceScrollContext.Provider>
  </View>;
});

const styles = StyleSheet.create({
  root: { flex: 1 }, empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 28 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700', textAlign: 'center' },
  footer: { marginTop: 18, paddingTop: 18, paddingHorizontal: 28, paddingBottom: 32, width: '88%' },
  rightFooter: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  credits: { color: 'rgba(255,255,255,0.56)', fontSize: 13, lineHeight: 18, fontWeight: '600' },
  strong: { fontWeight: '800' }, profile: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  avatar: { width: 18, height: 18 },
});
