import { BlurView } from 'expo-blur';
import { Image } from 'expo-image';
import { memo, useEffect, useState } from 'react';
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions, type ViewStyle } from 'react-native';
import Animated, { Easing, FadeIn, ReduceMotion, measure, useAnimatedReaction, useAnimatedRef, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming, type AnimatedStyle, type SharedValue } from 'react-native-reanimated';
import type { LyricsMetadata, LyricsAttributionProfile } from '@/types/bridge';

type Props = {
  metadata: LyricsMetadata;
  trackId?: string;
  controlsProgress: SharedValue<number>;
  controlsTarget: SharedValue<number>;
  controlsVisible: boolean;
  controlsHeight: number;
  bottomInset: number;
  onInteraction: () => void;
};

const ATTRIBUTION_EASE = Easing.bezier(0.77, 0, 0.175, 1);
const ATTRIBUTION_EXIT_MS = 220;
const ATTRIBUTION_ENTER_MS = 300;

function handle(profile?: LyricsAttributionProfile) {
  return profile?.username ? `@${profile.username.replace(/^@+/, '')}` : profile?.id || '';
}

function Profile({ label, profile, link = false, avatarStyle }: { label: string; profile?: LyricsAttributionProfile; link?: boolean; avatarStyle?: AnimatedStyle<ViewStyle> }) {
  if (!profile) return null;
  const url = profile.url?.trim();
  const linked = Boolean(link && url && /^https:\/\//i.test(url));
  const avatar = profile.avatar?.trim();
  return <View pointerEvents={link ? 'auto' : 'none'} style={[styles.profileRow, link && styles.detailProfileRow]}>
    <Animated.View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.avatar, link ? styles.detailAvatar : styles.compactAvatar, avatarStyle]}>
      <Text style={[styles.avatarInitial, link && styles.detailAvatarInitial]}>{handle(profile).replace(/^@/, '').slice(0, 1).toUpperCase() || '?'}</Text>
      {avatar && /^https:\/\//i.test(avatar) ? <Image source={{ uri: avatar }} contentFit="cover" style={StyleSheet.absoluteFill} /> : null}
    </Animated.View>
    <Text style={[styles.credit, link && styles.detailCredit]}>
      {label}{' '}
      <Text accessibilityRole={linked ? 'link' : undefined} style={linked ? styles.link : undefined}
        onPress={linked ? event => { event.stopPropagation(); void Linking.openURL(url!).catch(() => {}); } : undefined}>
        {handle(profile)}
      </Text>
    </Text>
  </View>;
}

// Mounted outside both lyric renderers, so attribution never scrolls away.
export const LyricsAttribution = memo(function LyricsAttribution({ metadata, trackId, controlsProgress, controlsTarget, controlsVisible, controlsHeight, bottomInset, onInteraction }: Props) {
  const [expanded, setExpanded] = useState(false);
  const reducedMotion = useReducedMotion();
  const { width: viewportWidth } = useWindowDimensions();
  const badgeRef = useAnimatedRef<View>();
  const attribution = metadata.attribution;
  const community = attribution?.provider === 'Spicy Lyrics';
  useEffect(() => { setExpanded(false); }, [trackId, attribution?.source, attribution?.provider]);
  const controlsOffset = Math.max(0, controlsHeight - 12);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(controlsVisible ? -controlsOffset : 0);
  const opacity = useSharedValue(1);
  const chromeReady = useSharedValue(controlsVisible ? 1 : 0);
  useAnimatedReaction(
    () => ({ shown: controlsTarget.get() > 0, offset: controlsOffset, viewportWidth, reducedMotion }),
    (current, previous) => {
      if (!previous || current.reducedMotion || current.offset === 0 || current.offset !== previous.offset || current.viewportWidth !== previous.viewportWidth) {
        translateX.set(0);
        translateY.set(current.shown ? -current.offset : 0);
        opacity.set(1);
        chromeReady.set(current.shown ? 1 : 0);
        return;
      }
      if (current.shown === previous.shown && current.reducedMotion === previous.reducedMotion) return;
      if (current.shown) {
        // Keep the outgoing badge minimal until it is fully offscreen.
        chromeReady.set(0);
        // Measure and chain both stages on the UI thread, including interruptions.
        const offscreenX = (measure(badgeRef)?.width ?? current.viewportWidth) + 24;
        translateY.set(translateY.get());
        opacity.set(withTiming(0, { duration: ATTRIBUTION_EXIT_MS, easing: Easing.linear }));
        translateX.set(withTiming(offscreenX, { duration: ATTRIBUTION_EXIT_MS, easing: ATTRIBUTION_EASE }, finished => {
          if (!finished || controlsTarget.get() <= 0) return;
          opacity.set(0);
          chromeReady.set(1);
          translateY.set(-current.offset);
          translateX.set(offscreenX);
          translateX.set(withTiming(0, { duration: ATTRIBUTION_ENTER_MS, easing: ATTRIBUTION_EASE }));
          opacity.set(withTiming(1, { duration: ATTRIBUTION_ENTER_MS, easing: Easing.linear }));
        }));
      } else {
        translateX.set(withTiming(0, { duration: 300, easing: ATTRIBUTION_EASE }));
        translateY.set(withTiming(0, { duration: 300, easing: ATTRIBUTION_EASE }));
        opacity.set(withTiming(1, { duration: 160, easing: Easing.linear }));
      }
    },
  );
  const positionStyle = useAnimatedStyle(() => ({
    opacity: Math.max(0, Math.min(1, opacity.get())),
    transform: [
      { translateX: Math.max(0, Math.min(viewportWidth + 24, translateX.get())) },
      { translateY: Math.max(-controlsOffset, Math.min(0, translateY.get())) },
    ],
  }));
  const glassStyle = useAnimatedStyle(() => ({ opacity: controlsProgress.get() * chromeReady.get() }));
  if (!attribution) return null;

  return <>
    <View pointerEvents="box-none" style={[styles.anchor, { bottom: bottomInset + 10 }]}>
      <Animated.View ref={badgeRef} collapsable={false} style={[styles.motion, positionStyle]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Lyrics attribution. Show details" accessibilityState={{ expanded }}
          hitSlop={8} onPress={() => { onInteraction(); setExpanded(true); }} style={styles.badge}>
          <Animated.View pointerEvents="none" style={[styles.glass, glassStyle]}>
            <BlurView intensity={28} tint="dark" style={StyleSheet.absoluteFill} />
          </Animated.View>
          {community && (attribution.uploader || attribution.maker) ? <>
            <Animated.Text style={[styles.provider, glassStyle]}>{attribution.provider}</Animated.Text>
            <Profile label="U:" profile={attribution.uploader} avatarStyle={glassStyle} />
            <Profile label="M:" profile={attribution.maker} avatarStyle={glassStyle} />
          </> : <Text style={styles.credit}>{attribution.provider || 'Unknown'}</Text>}
        </Pressable>
      </Animated.View>
    </View>
    <Modal transparent visible={expanded} animationType="fade" statusBarTranslucent onRequestClose={() => setExpanded(false)}>
      <Pressable accessibilityLabel="Close lyrics attribution" style={styles.scrim} onPress={() => setExpanded(false)}>
        <Animated.View entering={FadeIn.duration(200).reduceMotion(ReduceMotion.System)} style={styles.dialog}>
          <Pressable onPress={event => event.stopPropagation()} accessibilityViewIsModal>
            <BlurView intensity={48} tint="dark" style={StyleSheet.absoluteFill} />
            <ScrollView contentContainerStyle={styles.details}>
              <Text accessibilityRole="header" style={styles.title}>Lyrics attribution</Text>
              <Text style={styles.detailProvider}>{attribution.provider || 'Unknown'}</Text>
              {community ? <>
                <Profile label="Uploader:" profile={attribution.uploader} link />
                <Profile label="Maker:" profile={attribution.maker} link />
              </> : null}
              {metadata.credits?.songwriters?.length ? <Text style={styles.description}>Written by {metadata.credits.songwriters.join(', ')}</Text> : null}
              {community ? <Text style={styles.description}>Community lyrics sync provided by Spicy Lyrics. Contributor names link to their profiles.</Text> : null}
              <Pressable accessibilityRole="button" onPress={() => setExpanded(false)} style={styles.close}><Text style={styles.closeText}>Done</Text></Pressable>
            </ScrollView>
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  </>;
});

const styles = StyleSheet.create({
  anchor: { position: 'absolute', right: 16, left: 16, alignItems: 'flex-end', zIndex: 20 },
  motion: { maxWidth: '100%' },
  badge: { paddingHorizontal: 10, paddingVertical: 8, maxWidth: '100%', alignItems: 'flex-end', minHeight: 44, justifyContent: 'center' },
  glass: { ...StyleSheet.absoluteFill, overflow: 'hidden', borderRadius: 13, borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.16)', backgroundColor: 'rgba(20,20,24,0.25)' },
  provider: { fontSize: 9, lineHeight: 14, color: 'rgba(255,255,255,0.8)', textAlign: 'right' },
  credit: { fontSize: 10, lineHeight: 15, color: 'rgba(255,255,255,0.9)', textAlign: 'right', flexShrink: 1 },
  detailCredit: { fontSize: 14, lineHeight: 20, textAlign: 'left' },
  profileRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6 },
  detailProfileRow: { justifyContent: 'flex-start' },
  avatar: { borderRadius: 20, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center' },
  compactAvatar: { width: 16, height: 16 },
  detailAvatar: { width: 32, height: 32 },
  avatarInitial: { color: '#FFF', fontSize: 9 },
  detailAvatarInitial: { fontSize: 15 },
  link: { textDecorationLine: 'underline' },
  scrim: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: 'rgba(0,0,0,0.25)' },
  dialog: { width: '100%', maxWidth: 380, maxHeight: '80%', borderRadius: 24, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.2)', backgroundColor: 'rgba(24,24,30,0.18)' },
  details: { padding: 24, gap: 12, alignItems: 'stretch' },
  title: { color: '#FFF', fontSize: 21, fontWeight: '600' },
  detailProvider: { color: '#FFF', fontSize: 15, fontWeight: '500' },
  description: { color: 'rgba(255,255,255,0.75)', fontSize: 13, lineHeight: 20 },
  close: { alignSelf: 'flex-end', minHeight: 44, justifyContent: 'center', paddingHorizontal: 16 },
  closeText: { color: '#FFF', fontSize: 15, fontWeight: '600' },
});
