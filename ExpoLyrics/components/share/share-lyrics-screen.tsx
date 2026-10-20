import Ionicons from '@react-native-vector-icons/ionicons';
import { Canvas, Picture, Skia, useImage } from '@shopify/react-native-skia';
import { router, useLocalSearchParams } from 'expo-router';
import { shareAsync } from 'expo-sharing';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Switch, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNativeLyricsFonts } from '@/components/lyrics/native/native-lyrics-fonts';
import { drawCard, prepareCard, type PreparedCard } from '@/components/share/share-card';
import { makeVideo, savePicture } from '@/components/share/share-export';
import { MotionPressable as Button } from '@/components/ui/motion-pressable';
import { Design } from '@/constants/design';
import { lyricTextWithRanges } from '@/lib/active-lyric-line';
import { MAX_VIDEO_MS, shareLines, videoWindow } from '@/lib/share/share-timeline';
import { canMakeVideo } from '@/lib/share/video-encoder';
import { usePlaybackStore } from '@/store/playback-store';

type Mode = 'picture' | 'video';
/** Up to story-shaped: 1080 wide pictures, 720 wide videos (smaller files, quick to make). The height follows the lyrics. */
const SIZES = { picture: { width: 1080, maxHeight: 1920 }, video: { width: 720, maxHeight: 1280 } } as const;
const PREVIEW = { width: 540, maxHeight: 960 };
const LOGO = require('@/assets/images/share-logo.png');
const DEFAULT_LINES = 4;

/**
 * Share lyrics as a picture or a silent video: pick the lines (tap the first
 * and the last), see the card, then share it through the system share sheet.
 */
export default function ShareLyricsScreen() {
  const params = useLocalSearchParams<{ line?: string; art?: string }>();
  const lyrics = usePlaybackStore((state) => state.lyrics);
  const track = usePlaybackStore((state) => state.currentTrack);
  const translated = usePlaybackStore((state) => state.showTranslatedText);
  const fonts = useNativeLyricsFonts();
  const art = useImage(params.art || track?.artworkUrl || null);
  const logo = useImage(LOGO);
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const [mode, setMode] = useState<Mode>('picture');
  /** Video: words move like the player's Spicy lyrics (lift, glow) instead of a plain highlight. */
  const [animated, setAnimated] = useState(true);
  const [range, setRange] = useState(() => {
    const from = Math.max(0, Math.min(lyrics.length - 1, Number(params.line) || 0));
    return { from, to: Math.min(lyrics.length - 1, from + DEFAULT_LINES - 1) };
  });
  const [busy, setBusy] = useState<{ label: string; progress: number | null } | null>(null);
  const cancelled = useRef(false);

  const lines = useMemo(() => shareLines(lyrics, range.from, range.to, { translation: translated }), [lyrics, range, translated]);
  const clip = videoWindow(lines);
  const tooLong = clip.durationMs > MAX_VIDEO_MS;
  const meta = { title: track?.title ?? '', artist: track?.artist ?? '' };

  // The preview is a half-size card; exports are made at full size when asked.
  const preview = useMemo(() => fonts && lines.length
    ? prepareCard({ ...PREVIEW, art, logo, ...meta, lines, fonts, mode, animated }) : null,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [fonts, lines, art, logo, mode, animated, meta.title, meta.artist]);

  // Video preview: loop the clip in real time.
  const [clock, setClock] = useState(0);
  useEffect(() => {
    if (mode !== 'video' || !lines.length || busy) return;
    const began = Date.now();
    const timer = setInterval(() => setClock((Date.now() - began) % Math.max(1, clip.durationMs)), 33);
    return () => clearInterval(timer);
  }, [mode, lines.length, clip.durationMs, busy]);

  // The preview keeps the card's own shape (as tall as its lyrics, up to 9:16).
  const aspect = preview ? preview.height / preview.width : 16 / 9;
  const previewWidth = Math.min(screenWidth - 32, (screenHeight * 0.46) / aspect);
  const previewHeight = previewWidth * aspect;
  const picture = useMemo(() => {
    if (!preview) return null;
    const recorder = Skia.PictureRecorder();
    const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, previewWidth, previewHeight));
    canvas.scale(previewWidth / preview.width, previewHeight / preview.height);
    drawCard(canvas, preview, mode === 'video' ? clip.start + clock : null);
    return recorder.finishRecordingAsPicture();
  }, [preview, previewWidth, previewHeight, mode, clip.start, clock]);

  const fullCard = (): PreparedCard | null => fonts ? prepareCard({ ...SIZES[mode], art, logo, ...meta, lines, fonts, mode, animated }) : null;

  const share = async () => {
    if (!lines.length || busy) return;
    cancelled.current = false;
    try {
      if (mode === 'picture') {
        setBusy({ label: 'Making the picture…', progress: null });
        await new Promise((resolve) => setTimeout(resolve, 30));
        const card = fullCard();
        if (!card) throw new Error('The fonts are still loading. Try again in a moment.');
        const uri = savePicture(card);
        setBusy(null);
        await shareAsync(uri, { mimeType: 'image/png', dialogTitle: 'Share lyrics' });
      } else {
        setBusy({ label: 'Making the video…', progress: 0 });
        await new Promise((resolve) => setTimeout(resolve, 30));
        const card = fullCard();
        if (!card) throw new Error('The fonts are still loading. Try again in a moment.');
        const uri = await makeVideo(card, lines, (progress) => setBusy({ label: 'Making the video…', progress }), () => cancelled.current);
        setBusy(null);
        if (uri) await shareAsync(uri, { mimeType: 'video/mp4', dialogTitle: 'Share lyrics video' });
      }
    } catch (error) {
      setBusy(null);
      Alert.alert(mode === 'picture' ? 'Picture not made' : 'Video not made', error instanceof Error ? error.message : String(error));
    }
  };

  const choose = (index: number) => setRange((current) => index < current.from ? { ...current, from: index }
    : index > current.to ? { ...current, to: index } : { from: index, to: index });

  const videoUnavailable = mode === 'video' && !canMakeVideo();
  const blocked = !lines.length || (mode === 'video' && (tooLong || videoUnavailable));
  const hint = !lines.length ? 'Pick at least one line with words.'
    : mode === 'picture' ? `${lines.length} ${lines.length === 1 ? 'line' : 'lines'}. Tap the first and last line you want.`
      : videoUnavailable ? 'Video sharing needs the latest app build on this phone.'
        : tooLong ? `That is ${(clip.durationMs / 1000).toFixed(0)} s. Videos can be up to ${MAX_VIDEO_MS / 1000} s: pick fewer lines.`
          : `${(clip.durationMs / 1000).toFixed(1)} s video, no sound. Tap the first and last line you want.`;

  return <View style={styles.screen}><SafeAreaView style={styles.flex} edges={['top', 'bottom', 'left', 'right']}>
    <View style={styles.header}>
      <Button style={styles.iconButton} onPress={() => router.back()} accessibilityLabel="Back"><Ionicons name="chevron-back" size={22} color={Design.text} /></Button>
      <Text style={[styles.title, styles.flex]} numberOfLines={1}>Share lyrics</Text>
      <View style={styles.segment}>
        {(['picture', 'video'] as const).map((value) => <Pressable key={value} onPress={() => setMode(value)} disabled={busy != null}
          style={[styles.segmentItem, mode === value && styles.segmentActive]} accessibilityRole="button" accessibilityState={{ selected: mode === value }}>
          <Ionicons name={value === 'picture' ? 'image-outline' : 'videocam-outline'} size={15} color={mode === value ? Design.accentInk : Design.text} />
          <Text style={[styles.segmentText, mode === value && styles.segmentTextActive]}>{value === 'picture' ? 'Picture' : 'Video'}</Text>
        </Pressable>)}
      </View>
    </View>

    {!lyrics.length ? <View style={styles.empty}><Text style={styles.hint}>Play a song with lyrics first.</Text></View> : <>
      <View style={styles.previewWrap}>
        <View style={[styles.preview, { width: previewWidth, height: previewHeight }]}>
          {picture ? <Canvas style={{ width: previewWidth, height: previewHeight }}><Picture picture={picture} /></Canvas>
            : <ActivityIndicator color={Design.text} />}
        </View>
      </View>
      <Text style={styles.hint}>{hint}</Text>
      {mode === 'video' ? <View style={styles.option}>
        <Text style={[styles.optionText, styles.flex]}>Animated words (like the player)</Text>
        <Switch value={animated} onValueChange={setAnimated} disabled={busy != null} accessibilityLabel="Animated words" />
      </View> : null}
      <View style={styles.actions}>
        <Button style={[styles.primary, styles.flex, (blocked || busy) && styles.disabled]} disabled={blocked || busy != null} onPress={() => void share()}>
          <Ionicons name="share-outline" size={18} color={Design.accentInk} />
          <Text style={styles.primaryText}>{mode === 'picture' ? 'Share picture' : 'Make and share video'}</Text>
        </Button>
      </View>
      <ScrollView style={styles.flex} contentContainerStyle={styles.list}>
        {lyrics.map((line, index) => {
          const text = lyricTextWithRanges(line.syllables || []).text;
          if (!text) return null;
          const selected = index >= range.from && index <= range.to;
          return <Pressable key={index} onPress={() => choose(index)} disabled={busy != null}
            style={[styles.lineItem, selected && styles.lineItemSelected]} accessibilityRole="checkbox" accessibilityState={{ checked: selected }}>
            <Text style={[styles.lineText, selected && styles.lineTextSelected]}>{text}</Text>
          </Pressable>;
        })}
      </ScrollView>
    </>}

    {busy ? <View style={styles.busy}>
      <View style={styles.busyCard}>
        <Text style={styles.busyText}>{busy.label}</Text>
        {busy.progress != null ? <>
          <View style={styles.bar}><View style={[styles.barFill, { width: `${Math.round(busy.progress * 100)}%` }]} /></View>
          <Text style={styles.hint}>{Math.round(busy.progress * 100)}%</Text>
          <Button style={styles.secondary} onPress={() => { cancelled.current = true; }}><Text style={styles.buttonText}>Cancel</Text></Button>
        </> : <ActivityIndicator color={Design.text} />}
      </View>
    </View> : null}
  </SafeAreaView></View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Design.background },
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6 },
  title: { color: Design.text, fontSize: 18, fontWeight: '700' },
  iconButton: { width: 42, height: 42, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center' },
  segment: { flexDirection: 'row', borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.06)', padding: 3 },
  segmentItem: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 11 },
  segmentActive: { backgroundColor: Design.accent },
  segmentText: { color: Design.text, fontSize: 13, fontWeight: '600' },
  segmentTextActive: { color: Design.accentInk },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  previewWrap: { alignItems: 'center', paddingVertical: 8 },
  preview: { borderRadius: 18, overflow: 'hidden', backgroundColor: Design.surface, alignItems: 'center', justifyContent: 'center' },
  hint: { color: Design.muted, fontSize: 13, textAlign: 'center', paddingHorizontal: 16 },
  option: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 8 },
  optionText: { color: Design.text, fontSize: 14, fontWeight: '600' },
  actions: { flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 10 },
  primary: { minHeight: 48, paddingHorizontal: 14, borderRadius: 16, backgroundColor: Design.accent, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  primaryText: { color: Design.accentInk, fontSize: 14, fontWeight: '700' },
  secondary: { minHeight: 44, paddingHorizontal: 18, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: Design.border, alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: Design.text, fontSize: 14, fontWeight: '600' },
  disabled: { opacity: 0.4 },
  list: { paddingHorizontal: 16, paddingBottom: 24, gap: 4 },
  lineItem: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12 },
  lineItemSelected: { backgroundColor: 'rgba(168,240,207,0.16)' },
  lineText: { color: Design.muted, fontSize: 15, fontWeight: '600' },
  lineTextSelected: { color: Design.text },
  busy: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' },
  busyCard: { width: 260, padding: 20, gap: 12, borderRadius: 22, backgroundColor: Design.surface, alignItems: 'center' },
  busyText: { color: Design.text, fontSize: 15, fontWeight: '700' },
  bar: { alignSelf: 'stretch', height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.1)', overflow: 'hidden' },
  barFill: { height: 6, backgroundColor: Design.accent },
});
