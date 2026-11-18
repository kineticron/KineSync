import { useMemo, useRef } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { DRAG_SLOP, LONG_PRESS_MS } from '@/lib/rust-lyrics-gesture';
import type { RustCredits } from '@/lib/rust-lyrics-protocol';
import type { LyricLine } from '@/types/bridge';
import { buildAmllWords } from '../amll-word-spacing';

function getStaticText(line: LyricLine, syllables: LyricLine['backgroundSyllables']) {
  return buildAmllWords(syllables ?? [], line.lineStartTime, line.lineEndTime)
    .map(word => word.word)
    .join('')
    .trim();
}

export function getStaticLineText(line: LyricLine) {
  return getStaticText(line, line.syllables);
}

export function StaticLyricsView({ lines, fontScale, landscape, showTranslation, credits, interactive,
  shouldRevealTap, onUserInteraction }: {
  lines: LyricLine[];
  fontScale: number;
  landscape: boolean;
  showTranslation: boolean;
  credits: RustCredits | null;
  interactive: boolean;
  shouldRevealTap?: (pageY: number) => boolean;
  onUserInteraction?: () => void;
}) {
  const rows = useMemo(() => lines.flatMap((line, index) => {
    const text = getStaticLineText(line);
    if (!text) return [];
    return [{
      index,
      text,
      translation: line.translatedText?.trim(),
      background: getStaticText(line, line.backgroundSyllables),
      backgroundTranslation: line.backgroundTranslatedText?.trim(),
    }];
  }), [lines]);
  const revealTouch = useRef<{ x: number; y: number; startedAt: number } | null>(null);
  const scale = Math.max(0.82, Math.min(1.35, fontScale));
  const alignment = landscape ? styles.rightText : undefined;
  const rowAlignment = landscape ? styles.rightRow : undefined;
  const attribution = credits?.attribution;
  const creditLines = [
    credits?.songwriters?.length ? `Written By: ${credits.songwriters.join(', ')}` : '',
    attribution?.provider ? `Provided By: ${attribution.provider}` : '',
    attribution?.community ? 'These lyrics have been provided by the Spicy Lyrics community' : '',
    attribution?.maker ? `Made By: @${attribution.maker}` : '',
    attribution?.uploader ? `Uploaded By: @${attribution.uploader}` : '',
  ].filter(Boolean);

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      automaticallyAdjustContentInsets={false}
      contentInsetAdjustmentBehavior="never"
      showsVerticalScrollIndicator={false}
      pointerEvents={interactive ? undefined : 'none'}
      onTouchStart={({ nativeEvent }) => {
        const { pageX, pageY } = nativeEvent;
        if (shouldRevealTap?.(pageY)) {
          revealTouch.current = { x: pageX, y: pageY, startedAt: performance.now() };
        } else {
          revealTouch.current = null;
          onUserInteraction?.();
        }
      }}
      onTouchMove={({ nativeEvent }) => {
        const touch = revealTouch.current;
        if (touch && Math.hypot(nativeEvent.pageX - touch.x, nativeEvent.pageY - touch.y) > DRAG_SLOP) {
          revealTouch.current = null;
        }
      }}
      onTouchEnd={({ nativeEvent }) => {
        const touch = revealTouch.current;
        revealTouch.current = null;
        if (touch && performance.now() - touch.startedAt < LONG_PRESS_MS &&
          Math.hypot(nativeEvent.pageX - touch.x, nativeEvent.pageY - touch.y) <= DRAG_SLOP) {
          onUserInteraction?.();
        }
      }}
      onTouchCancel={() => { revealTouch.current = null; }}
      onScrollBeginDrag={() => {
        revealTouch.current = null;
        onUserInteraction?.();
      }}
    >
      {rows.map(row => (
        <View key={row.index} style={[styles.row, rowAlignment]}>
          <Text style={[styles.lead, alignment, { fontSize: 26 * scale, lineHeight: 26 * scale * 1.46 }]}>
            {row.text}
          </Text>
          {showTranslation && row.translation ? (
            <Text style={[styles.translation, alignment, { fontSize: 18 * scale, lineHeight: 18 * scale * 1.44 }]}>
              {row.translation}
            </Text>
          ) : null}
          {row.background ? (
            <View style={styles.background}>
              <Text style={[styles.backgroundText, alignment, { fontSize: 18 * scale, lineHeight: 18 * scale * 1.4 }]}>
                {row.background}
              </Text>
              {showTranslation && row.backgroundTranslation ? (
                <Text style={[styles.backgroundTranslation, alignment, { fontSize: 15 * scale, lineHeight: 15 * scale * 1.4 }]}>
                  {row.backgroundTranslation}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      ))}
      {creditLines.length ? <Text style={[styles.credits, rowAlignment, alignment]}>{creditLines.join('\n')}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, backgroundColor: 'transparent' },
  content: { paddingTop: 150, paddingHorizontal: 28, paddingBottom: 280 },
  row: { width: '100%', maxWidth: 300, marginBottom: 14 },
  rightRow: { marginLeft: 'auto' },
  rightText: { textAlign: 'right' },
  lead: { color: '#fff', fontWeight: '600', letterSpacing: 0.15, includeFontPadding: false },
  translation: { marginTop: 6, color: 'rgba(255,255,255,0.68)', fontWeight: '500', letterSpacing: 0.1, includeFontPadding: false },
  background: { marginTop: 5 },
  backgroundText: { color: 'rgba(255,255,255,0.78)', fontWeight: '500', includeFontPadding: false },
  backgroundTranslation: { marginTop: 2, color: 'rgba(255,255,255,0.58)', fontWeight: '500', includeFontPadding: false },
  credits: {
    width: '88%', maxWidth: 300, marginTop: 18, paddingTop: 18, paddingBottom: 32,
    color: 'rgba(255,255,255,0.56)', fontSize: 13, lineHeight: 18, fontWeight: '600', includeFontPadding: false,
  },
});
