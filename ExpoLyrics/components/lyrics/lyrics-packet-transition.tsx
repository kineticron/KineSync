import React, { createContext, memo, useCallback, useContext, useEffect, useMemo, useState, type ComponentType } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useShallow } from 'zustand/react/shallow';
import { usePlaybackStore } from '@/store/playback-store';
import type { LyricLine, LyricsMetadata, Track } from '@/types/bridge';

type Packet = {
  lyrics: LyricLine[];
  lyricsSource: string;
  lyricsMetadata: LyricsMetadata;
  lyricsStatusMessage: string;
  currentTrack: Track | null;
};
type Layer = { id: number; packet: Packet };
const PacketContext = createContext<{ packet: Packet; onReady: () => void } | null>(null);
export const useLyricsPacketTransition = () => useContext(PacketContext);
const FADE_MS = 240;
const NOOP = () => {};
const easeOut = Easing.bezier(0.23, 1, 0.32, 1);

/** Keep the previous renderer alive until the replacement has laid out its lyrics. */
export function withLyricsPacketTransition<Props extends { demoLyrics?: LyricLine[]; active?: boolean }>(Renderer: ComponentType<Props>) {
  const LiveTransition = memo(function LiveTransition(props: Props) {
    const packet = usePlaybackStore(useShallow(state => ({ lyrics: state.lyrics, lyricsSource: state.lyricsSource,
      lyricsMetadata: state.lyricsMetadata, lyricsStatusMessage: state.lyricsStatusMessage, currentTrack: state.currentTrack })));
    const reducedMotion = useReducedMotion();
    const isActive = props.active !== false;
    const duration = reducedMotion || !isActive ? 0 : FADE_MS;
    const fade = useSharedValue(0);
    const [layers, setLayers] = useState<{ current: Layer; previous?: Layer; ready: boolean }>(
      () => ({ current: { id: 0, packet }, ready: true }));
    const { current, previous, ready } = layers;
    // Replace an unready packet, but let an in-progress crossfade finish.
    if ((!previous || !ready) && (current.packet.lyrics !== packet.lyrics || current.packet.lyricsSource !== packet.lyricsSource ||
      current.packet.currentTrack?.id !== packet.currentTrack?.id)) {
      setLayers({ current: { id: current.id + 1, packet }, previous: previous ?? current, ready: !isActive });
    } else if (previous && !ready && !isActive) {
      setLayers({ ...layers, ready: true });
    } else if (current.packet !== packet && current.packet.lyrics === packet.lyrics &&
      current.packet.lyricsSource === packet.lyricsSource && current.packet.currentTrack?.id === packet.currentTrack?.id) {
      setLayers({ ...layers, current: { ...current, packet } });
    }
    const onReady = useCallback(() => {
      setLayers(state => state.current.id !== current.id || state.ready ? state : { ...state, ready: true });
    }, [current.id]);
    const finishFade = useCallback(() => {
      setLayers(state => state.current.id === current.id ? { current: state.current, ready: true } : state);
    }, [current.id]);
    useEffect(() => {
      if (!previous || !ready) { fade.set(0); return; }
      // Retire the old renderer only after the UI runtime reaches the endpoint.
      fade.set(withTiming(1, { duration, easing: easeOut }, finished => {
        if (finished) scheduleOnRN(finishFade);
      }));
      return () => cancelAnimation(fade);
    }, [duration, fade, finishFade, previous, ready]);
    const outgoingStyle = useAnimatedStyle(() => ({ opacity: ready ? 1 - fade.get() : 1 }));
    const incomingStyle = useAnimatedStyle(() => ({ opacity: previous ? ready ? fade.get() : 0 : 1 }));
    const context = useMemo(() => ({ packet: current.packet, onReady }), [current.packet, onReady]);
    const oldContext = useMemo(() => previous ? { packet: previous.packet, onReady: NOOP } : null, [previous]);
    return <View style={styles.root}>
      {previous && oldContext ? <Animated.View key={previous.id} pointerEvents="none" accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants" style={[styles.layer, outgoingStyle]}>
        <PacketContext.Provider value={oldContext}><Renderer {...props} active={false}
          onActiveLineChange={undefined} onAutoFollowChange={undefined} onUserInteraction={undefined} /></PacketContext.Provider>
      </Animated.View> : null}
      <Animated.View key={current.id} pointerEvents={previous && !ready ? 'none' : 'auto'}
        accessibilityElementsHidden={!!previous && !ready} importantForAccessibility={previous && !ready ? 'no-hide-descendants' : 'auto'}
        style={[styles.layer, incomingStyle]}>
        <PacketContext.Provider value={context}><Renderer {...props} /></PacketContext.Provider>
      </Animated.View>
    </View>;
  });
  return memo(function LyricsPacketTransition(props: Props) {
    return props.demoLyrics ? <Renderer {...props} /> : <LiveTransition {...props} />;
  });
}

const styles = StyleSheet.create({ root: { flex: 1 }, layer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } });
